/**
 * MessagePipeline — per-run Telegram message lifecycle manager.
 * Handles status messages, streaming response, CUA logs, and cleanup.
 *
 * Port of src/streaming-pipeline.ts (v1).
 */

import { Effect } from 'effect';

import { Telegram } from '../services/Telegram.js';
import type { PipelineEvent } from '../schemas/IpcMessages.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Minimum interval between Telegram message edits (ms) */
const STATUS_EDIT_INTERVAL_MS = 2500;

/** Max chars in a single Telegram message (accounting for HTML tags) */
const MAX_CHUNK = 4000;

/** Tool names that shouldn't appear as status (agent sending its reply) */
const HIDDEN_TOOLS = new Set(['send_message', 'send_file', 'send_voice']);

/** Human-readable tool display names */
export const TOOL_DISPLAY_NAMES: Record<string, string> = {
  Bash: 'running command',
  Read: 'reading file',
  Write: 'writing file',
  Edit: 'editing file',
  Glob: 'searching files',
  Grep: 'searching code',
  WebSearch: 'searching the web',
  WebFetch: 'fetching page',
  browse_navigate: 'browsing',
  browse_snapshot: 'reading page',
  browse_click: 'clicking',
  browse_click_xy: 'clicking',
  browse_fill: 'filling form',
  browse_type_at_xy: 'typing',
  browse_perform: 'performing actions',
  browse_screenshot: 'taking screenshot',
  browse_wait_for_user: 'waiting for you',
  browse_go_back: 'going back',
  browse_close: 'closing browser',
  browse_extract_file: 'extracting file',
  browse_upload_file: 'uploading file',
  browse_evaluate: 'running script',
  firecrawl_scrape: 'scraping page',
  firecrawl_crawl: 'crawling site',
  firecrawl_map: 'mapping URLs',
  memory_save: 'saving to memory',
  memory_search: 'searching memory',
  schedule_task: 'scheduling task',
  list_tasks: 'checking tasks',
  pause_task: 'pausing task',
  resume_task: 'resuming task',
  cancel_task: 'cancelling task',
  register_group: 'registering group',
};

export function humanizeToolName(rawName: string): string {
  const name = rawName.replace(/^mcp__nanoclaw__/, '');
  return TOOL_DISPLAY_NAMES[name] || name.replace(/_/g, ' ');
}

// ─── Types ──────────────────────────────────────────────────────────────────

type PipelinePhase = 'idle' | 'thinking' | 'tool_active' | 'responding' | 'done';

export interface PipelineConfig {
  readonly chatJid: string;
  readonly groupFolder: string;
  readonly thinkingEnabled: boolean;
  readonly verboseEnabled: boolean;
}

export interface MessagePipelineHandle {
  readonly onThinking: () => Effect.Effect<void>;
  readonly onStatusText: (text: string) => Effect.Effect<void>;
  readonly onToolUse: (
    toolName: string,
  ) => Effect.Effect<void>;
  readonly onTextDelta: (text: string) => Effect.Effect<void>;
  readonly onCuaStatus: (
    screenshotPath: string | null,
    statusText: string,
  ) => Effect.Effect<void>;
  readonly onDone: (finalText: string) => Effect.Effect<void>;
  readonly onError: (error: string) => Effect.Effect<void>;
  readonly handleEvent: (event: PipelineEvent) => Effect.Effect<void>;
  readonly hasVoiceSent: (key: string) => boolean;
  readonly markVoiceSent: (key: string) => void;
}

// ─── Utility ────────────────────────────────────────────────────────────────

function splitIntoChunks(text: string, maxChunk: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxChunk) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', maxChunk);
    if (splitAt === -1) splitAt = maxChunk;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  return chunks;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a MessagePipeline for a single agent run.
 * Requires Telegram service in the Effect context.
 */
export const createMessagePipeline = (
  pipelineConfig: PipelineConfig,
): Effect.Effect<MessagePipelineHandle, never, Telegram> =>
  Effect.gen(function* () {
    const telegram = yield* Telegram;

    // Mutable state for this pipeline instance
    let phase: PipelinePhase = 'idle';
    let statusMsgId: number | null = null;
    let statusExtraIds: number[] = [];
    let buffer = '';
    let lastEditTime = 0;
    let lastStatusText = '';
    let toolHistory: string[] = [];
    let overflowMessageIds: number[] = [];
    const voiceDedupSet = new Set<string>();
    let cuaTextMsgId: number | null = null;
    let cuaScreenshotMsgId: number | null = null;
    let cuaLastText = '';

    const handle: MessagePipelineHandle = {
      onStatusText: (text) =>
        Effect.gen(function* () {
          phase = 'thinking';
          if (!pipelineConfig.thinkingEnabled) return;
          yield* updateStatusMessage(text);
        }).pipe(Effect.ignore),

      onThinking: () =>
        Effect.gen(function* () {
          yield* handle.onStatusText('thinking');
        }).pipe(Effect.ignore),

      onToolUse: (toolName) =>
        Effect.gen(function* () {
          const cleanName = toolName.replace(/^mcp__nanoclaw__/, '');
          if (HIDDEN_TOOLS.has(cleanName)) return;

          phase = 'tool_active';
          const displayName = humanizeToolName(toolName);
          toolHistory.push(displayName);

          if (statusMsgId) {
            const now = Date.now();
            if (now - lastEditTime < STATUS_EDIT_INTERVAL_MS) return;

            const edited = yield* telegram.editStatusMessage(
              pipelineConfig.chatJid,
              statusMsgId,
              toolHistory.join('\n'),
            );
            if (edited) lastEditTime = now;
          }
        }).pipe(Effect.ignore),

      onTextDelta: (text) =>
        Effect.gen(function* () {
          phase = 'responding';
          buffer += text;

          const now = Date.now();
          if (now - lastEditTime < STATUS_EDIT_INTERVAL_MS) return;
          lastEditTime = now;

          // Delete previous overflow messages
          for (const id of overflowMessageIds) {
            yield* telegram
              .deleteMessage(pipelineConfig.chatJid, id)
              .pipe(Effect.ignore);
          }
          overflowMessageIds = [];

          // Split into chunks
          const chunks = splitIntoChunks(buffer, MAX_CHUNK);
          if (statusMsgId) {
            yield* telegram.editMessageText(
              pipelineConfig.chatJid,
              statusMsgId,
              chunks[0],
            ).pipe(Effect.ignore);
          }

          // Send overflow chunks
          for (const chunk of chunks.slice(1)) {
            const msgId = yield* telegram.sendMessageWithId(
              pipelineConfig.chatJid,
              chunk,
            );
            if (msgId) overflowMessageIds.push(msgId);
          }
        }).pipe(Effect.ignore),

      onCuaStatus: (screenshotPath, statusText) =>
        Effect.gen(function* () {
          // Update text status
          if (statusText !== cuaLastText) {
            if (cuaTextMsgId) {
              yield* telegram
                .editMessageText(
                  pipelineConfig.chatJid,
                  cuaTextMsgId,
                  statusText,
                )
                .pipe(Effect.ignore);
            } else {
              const msgId = yield* telegram.sendMessageWithId(
                pipelineConfig.chatJid,
                statusText,
              );
              if (msgId) cuaTextMsgId = msgId;
            }
            cuaLastText = statusText;
          }

          // Update screenshot
          if (screenshotPath) {
            if (cuaScreenshotMsgId) {
              yield* telegram
                .editPhoto(
                  pipelineConfig.chatJid,
                  cuaScreenshotMsgId,
                  screenshotPath,
                  'Screenshot',
                )
                .pipe(Effect.ignore);
            } else {
              const msgId = yield* telegram.sendPhoto(
                pipelineConfig.chatJid,
                screenshotPath,
                'Screenshot',
              );
              if (msgId) cuaScreenshotMsgId = msgId;
            }
          }
        }).pipe(Effect.ignore),

      onDone: (finalText) =>
        Effect.gen(function* () {
          phase = 'done';

          // Clean up overflow messages
          for (const id of overflowMessageIds) {
            yield* telegram
              .deleteMessage(pipelineConfig.chatJid, id)
              .pipe(Effect.ignore);
          }
          overflowMessageIds = [];

          if (finalText) {
            const chunks = splitIntoChunks(finalText, MAX_CHUNK);
            if (statusMsgId) {
              // Edit existing status message with the final text
              yield* telegram
                .editMessageText(
                  pipelineConfig.chatJid,
                  statusMsgId,
                  chunks[0],
                )
                .pipe(Effect.ignore);
            } else {
              // No status message was created (e.g. one-shot mode with no streaming)
              // Send the response as a new message
              yield* telegram
                .sendMessage(pipelineConfig.chatJid, chunks[0])
                .pipe(Effect.ignore);
            }

            for (const chunk of chunks.slice(1)) {
              yield* telegram
                .sendMessage(pipelineConfig.chatJid, chunk)
                .pipe(Effect.ignore);
            }
          }

          // Clean up CUA messages
          if (cuaTextMsgId) {
            yield* telegram
              .deleteMessage(pipelineConfig.chatJid, cuaTextMsgId)
              .pipe(Effect.ignore);
          }
          if (cuaScreenshotMsgId) {
            yield* telegram
              .deleteMessage(pipelineConfig.chatJid, cuaScreenshotMsgId)
              .pipe(Effect.ignore);
          }

          // Clean up status extras
          for (const extraId of statusExtraIds) {
            yield* telegram
              .deleteMessage(pipelineConfig.chatJid, extraId)
              .pipe(Effect.ignore);
          }
        }).pipe(Effect.ignore),

      onError: (error) =>
        Effect.gen(function* () {
          phase = 'done';
          if (statusMsgId) {
            const truncated =
              error.length > MAX_CHUNK ? error.slice(-MAX_CHUNK) : error;
            yield* telegram
              .editMessageText(
                pipelineConfig.chatJid,
                statusMsgId,
                truncated,
              )
              .pipe(Effect.ignore);
          }
        }).pipe(Effect.ignore),

      handleEvent: (event) =>
        Effect.gen(function* () {
          if (event.type === 'thinking' && event.content) {
            yield* handle.onThinking();
          } else if (event.type === 'tool_start' && event.tool_name) {
            yield* handle.onToolUse(event.tool_name);
          } else if (event.type === 'response_delta' && event.content) {
            yield* handle.onTextDelta(event.content);
          }
        }).pipe(Effect.ignore),

      hasVoiceSent: (key) => voiceDedupSet.has(key),
      markVoiceSent: (key) => {
        voiceDedupSet.add(key);
      },
    };

    const updateStatusMessage = (newText: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!newText) return;

        const now = Date.now();

        if (statusMsgId) {
          if (newText === lastStatusText) return;
          if (now - lastEditTime < STATUS_EDIT_INTERVAL_MS) return;

          // Delete previous overflow messages
          for (const id of statusExtraIds) {
            yield* telegram.deleteMessage(pipelineConfig.chatJid, id).pipe(
              Effect.ignore,
            );
          }
          statusExtraIds = [];

          const chunks = splitIntoChunks(newText, MAX_CHUNK);
          const edited = yield* telegram
            .editStatusMessage(
              pipelineConfig.chatJid,
              statusMsgId,
              chunks[0],
            )
            .pipe(Effect.orElseSucceed(() => false));
          if (!edited) return;

          lastStatusText = newText;
          lastEditTime = now;

          for (const chunk of chunks.slice(1)) {
            const msgId = yield* telegram
              .sendStatusMessage(pipelineConfig.chatJid, chunk)
              .pipe(Effect.orElseSucceed(() => null));
            if (msgId) statusExtraIds.push(msgId);
          }
          return;
        }

        const msgId = yield* telegram
          .sendStatusMessage(pipelineConfig.chatJid, newText)
          .pipe(Effect.orElseSucceed(() => null));
        if (msgId) {
          statusMsgId = msgId;
          lastStatusText = newText;
          lastEditTime = now;
        }
      }).pipe(Effect.catchAll(() => Effect.void));

    return handle;
  });
