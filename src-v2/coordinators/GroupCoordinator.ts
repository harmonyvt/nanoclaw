/**
 * GroupCoordinator — per-group fiber that manages message queue and auto-interrupt.
 * Each registered group gets its own coordinator fiber spawned on first message.
 *
 * Port of handleMessage/processMessage from src/index.ts (v1).
 */

import fs from 'fs';
import path from 'path';
import {
  Cause,
  Effect,
  Fiber,
  Queue,
  Ref,
  Scope,
  Stream,
} from 'effect';

import { AppConfig } from '../config.js';
import { Database } from '../services/Database.js';
import { Telegram, type IncomingMessage } from '../services/Telegram.js';
import { ContainerRunner } from '../services/ContainerRunner.js';
import { Supermemory } from '../services/Supermemory.js';
import { TTS } from '../services/TTS.js';
import { BrowseHost } from '../services/BrowseHost.js';
import { AgentSemaphore } from './AgentSemaphore.js';
import {
  createMessagePipeline,
  type MessagePipelineHandle,
} from './MessagePipeline.js';
import type { RegisteredGroup } from '../schemas/Groups.js';
import type { ContainerInput } from '../schemas/ContainerIO.js';
import { looksLikeCode } from '../services/TTSLive.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GroupCoordinatorHandle {
  readonly queue: Queue.Queue<IncomingMessage>;
  readonly loop: Effect.Effect<void, never, never>;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const NON_RETRYABLE_PATTERNS = [
  'billing',
  'rate_limit',
  'authentication',
  'overloaded',
  'permission',
  'model_not_found',
];

function isNonRetryableError(error: string): boolean {
  const lower = error.toLowerCase();
  return NON_RETRYABLE_PATTERNS.some((p) => lower.includes(p));
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Build the conversation XML from message history.
 * Format matches v1: <messages><message sender="..." time="..." ...>content</message></messages>
 */
function buildConversationXml(
  history: ReadonlyArray<{
    sender_name: string;
    timestamp: string;
    content: string;
    media_type?: string;
    media_path?: string;
  }>,
  assistantName: string,
): string {
  if (history.length === 0) return '';

  const lines = history.map((row) => {
    let attrs = `sender="${escapeXml(row.sender_name)}" time="${escapeXml(row.timestamp)}"`;
    if (row.media_type) attrs += ` media_type="${escapeXml(row.media_type)}"`;
    if (row.media_path) attrs += ` media_path="${escapeXml(row.media_path)}"`;
    return `<message ${attrs}>${escapeXml(row.content)}</message>`;
  });

  return `<messages>\n${lines.join('\n')}\n</messages>`;
}

/**
 * Translate media paths from host filesystem to container mount paths.
 */
function translateMediaPath(
  hostMediaPath: string,
  groupFolder: string,
  groupsDir: string,
): string {
  const groupPrefix = path.join(groupsDir, groupFolder) + '/';
  if (hostMediaPath.startsWith(groupPrefix)) {
    return '/workspace/group/' + hostMediaPath.slice(groupPrefix.length);
  }
  return hostMediaPath;
}

/**
 * Load skill if the message matches /skill_name [params].
 */
function resolveSkillPrompt(
  content: string,
  groupFolder: string,
  groupsDir: string,
): string | null {
  const match = content.match(/^\/([a-z][a-z0-9_]{1,30})(?:\s+(.*))?$/);
  if (!match) return null;

  const [, skillName, skillParams] = match;
  const skillPath = path.join(groupsDir, groupFolder, 'skills', `${skillName}.json`);

  try {
    if (!fs.existsSync(skillPath)) return null;
    const skill = JSON.parse(fs.readFileSync(skillPath, 'utf-8')) as {
      instructions?: string;
      parameters?: string;
    };
    if (!skill.instructions) return null;

    let xml = `<skill name="${skillName}"`;
    if (skillParams) xml += ` parameters="${escapeXml(skillParams)}"`;
    if (skill.parameters) xml += ` accepts="${escapeXml(skill.parameters)}"`;
    xml += `>\n${escapeXml(skill.instructions)}\n</skill>`;
    return xml;
  } catch {
    return null;
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a GroupCoordinator for a registered group.
 * Returns a queue (for feeding messages) and a loop effect (to fork).
 */
export const createGroupCoordinator = (
  chatJid: string,
  group: RegisteredGroup,
): Effect.Effect<
  GroupCoordinatorHandle,
  never,
  | AppConfig
  | Database
  | Telegram
  | ContainerRunner
  | Supermemory
  | TTS
  | BrowseHost
  | AgentSemaphore
> =>
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const db = yield* Database;
    const telegram = yield* Telegram;
    const runner = yield* ContainerRunner;
    const memory = yield* Supermemory;
    const tts = yield* TTS;
    const browseHost = yield* BrowseHost;
    const semaphore = yield* AgentSemaphore;

    const queue = yield* Queue.unbounded<IncomingMessage>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const activeFiberRef = yield* Ref.make<Fiber.Fiber<any, any> | null>(null);

    const isMain = group.folder === config.mainGroupFolder;

    const processMessage = (msg: IncomingMessage) =>
      Effect.gen(function* () {
        // Auto-interrupt: cancel any active container fiber
        const currentFiber = yield* Ref.get(activeFiberRef);
        if (currentFiber) {
          yield* Fiber.interrupt(currentFiber).pipe(Effect.ignore);
          yield* Ref.set(activeFiberRef, null);
        }

        // Cancel any pending browse wait requests
        yield* browseHost.cancelWaiting(group.folder, 'New message received').pipe(
          Effect.ignore,
        );

        // Check for "continue" command (browse wait-for-user)
        const continueMatch = msg.content.match(/^continue(?:\s+(\S+))?$/i);
        if (continueMatch) {
          const requestId = continueMatch[1];
          const hasWaiting = yield* browseHost.hasWaitingRequests(group.folder);
          const resolved = yield* browseHost.resolveWait(group.folder, requestId);
          if (resolved) return;
          if (requestId || hasWaiting) {
            yield* telegram
              .sendMessage(
                chatJid,
                requestId
                  ? `No pending wait request found for ID: ${requestId}`
                  : 'No pending wait request found for this chat.',
              )
              .pipe(Effect.ignore);
            return;
          }
        }

        // Store incoming message in DB
        yield* db
          .storeTextMessage({
            id: msg.id,
            chatJid: msg.chatJid,
            sender: msg.sender,
            senderName: msg.senderName,
            content: msg.content,
            timestamp: msg.timestamp,
            isFromMe: false,
          })
          .pipe(Effect.ignore);

        if (msg.mediaType && msg.mediaPath) {
          yield* db
            .storeMediaMessage({
              id: msg.id,
              chatJid: msg.chatJid,
              sender: msg.sender,
              senderName: msg.senderName,
              content: msg.content,
              timestamp: msg.timestamp,
              isFromMe: false,
              mediaType: msg.mediaType,
              mediaPath: msg.mediaPath,
            })
            .pipe(Effect.ignore);
        }

        // Get conversation history
        const history = yield* db
          .getConversationHistory(chatJid, config.maxConversationMessages)
          .pipe(Effect.orElseSucceed(() => [] as const));

        // Translate media paths in history
        const translatedHistory = history.map((row) => ({
          ...row,
          media_path: row.media_path
            ? translateMediaPath(row.media_path, group.folder, config.groupsDir)
            : undefined,
        }));

        // Build conversation XML
        const messagesXml = buildConversationXml(
          translatedHistory,
          config.assistantName,
        );

        // Retrieve memories (if Supermemory configured)
        const memoryResult = yield* memory
          .search(msg.content, group.folder)
          .pipe(
            Effect.map((r) => {
              if (r.results.length === 0) return '';
              const items = r.results
                .map((m) => `<memory score="${m.score}">${escapeXml(m.content)}</memory>`)
                .join('\n');
              return `<memories>\n${items}\n</memories>`;
            }),
            Effect.orElseSucceed(() => ''),
          );

        // Check for skill invocation
        const skillXml = resolveSkillPrompt(
          msg.content,
          group.folder,
          config.groupsDir,
        );

        // Build full prompt
        const promptParts = [memoryResult, skillXml, messagesXml].filter(
          Boolean,
        );
        const prompt = promptParts.join('\n\n');

        // Resolve provider/model
        const provider =
          group.providerConfig?.provider || config.defaultProvider;
        const model = group.providerConfig?.model || config.defaultModel || undefined;
        const baseUrl = group.providerConfig?.baseUrl || undefined;

        // Build container input
        const containerInput: ContainerInput = {
          prompt,
          groupFolder: group.folder,
          chatJid,
          isMain,
          isScheduledTask: false,
          isSkillInvocation: !!skillXml,
          assistantName: config.assistantName,
          provider,
          model,
          baseUrl,
          enableThinking: true,
        };

        // Create message pipeline for streaming updates
        const pipeline: MessagePipelineHandle = yield* createMessagePipeline({
          chatJid,
          groupFolder: group.folder,
          thinkingEnabled: true,
          verboseEnabled: false,
        }).pipe(Effect.provideService(Telegram, telegram));

        // Build RPC handlers that bridge container events to pipeline
        const rpcHandlers = {
          onRequest: async () => null as unknown,
          onEvent: async () => {},
        };

        // Retry loop with exponential backoff
        const runWithRetries = Effect.gen(function* () {
          let lastError = '';

          for (let attempt = 0; attempt <= config.maxAgentRetries; attempt++) {
            const result = yield* semaphore.withPermits(1)(
              Effect.scoped(runner.runAgent(containerInput, rpcHandlers)),
            ).pipe(Effect.either);

            if (result._tag === 'Right') {
              const output = result.right;

              // Pipeline done
              yield* pipeline.onDone(output.result || '');

              // Store assistant response
              if (output.result) {
                yield* db
                  .storeAssistantMessage(
                    chatJid,
                    output.result,
                    new Date().toISOString(),
                    config.assistantName,
                  )
                  .pipe(Effect.ignore);
              }

              // Post-run: TTS (skip if code content)
              if (output.result && !looksLikeCode(output.result)) {
                yield* tts
                  .synthesize({
                    text: output.result,
                    groupFolder: group.folder,
                  })
                  .pipe(
                    Effect.flatMap((ttsResult) =>
                      telegram.sendVoice(chatJid, ttsResult.audioPath),
                    ),
                    Effect.ignore,
                  );
              }

              // Post-run: store memory
              if (output.result) {
                yield* memory
                  .save(output.result, group.folder)
                  .pipe(Effect.ignore);
              }

              return output;
            }

            // Error path
            lastError = String(result.left);

            // Non-retryable errors: bail immediately
            if (isNonRetryableError(lastError)) {
              yield* pipeline.onError(lastError);
              return yield* Effect.fail(lastError);
            }

            // Retryable: log and backoff
            if (attempt < config.maxAgentRetries) {
              yield* Effect.log(
                `Retrying agent for ${group.folder} (attempt ${attempt + 1}/${config.maxAgentRetries + 1}): ${lastError}`,
              );
              yield* Effect.sleep(
                `${config.agentRetryDelay * Math.pow(2, attempt)} millis`,
              );
              continue;
            }

            // Exhausted retries
            yield* pipeline.onError(
              `Failed after ${config.maxAgentRetries + 1} attempts: ${lastError}`,
            );
            return yield* Effect.fail(lastError);
          }
        });

        // Fork container run
        const fiber = yield* Effect.fork(runWithRetries);
        yield* Ref.set(activeFiberRef, fiber);

        // Await result (can be interrupted by next message)
        yield* Fiber.join(fiber).pipe(
          Effect.catchAllCause((cause) =>
            Cause.isInterruptedOnly(cause)
              ? pipeline.onError('Interrupted by new message')
              : Effect.failCause(cause),
          ),
          Effect.ignore,
        );

        yield* Ref.set(activeFiberRef, null);
      }).pipe(Effect.catchAll(() => Effect.void));

    // Main loop: take from queue, process sequentially
    const loop = Stream.fromQueue(queue).pipe(
      Stream.tap((msg) => processMessage(msg)),
      Stream.runDrain,
    );

    return { queue, loop } satisfies GroupCoordinatorHandle;
  });
