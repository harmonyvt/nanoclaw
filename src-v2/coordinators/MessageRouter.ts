/**
 * MessageRouter — routes incoming Telegram messages to group coordinators.
 * Consumes the Stream<IncomingMessage> from the Telegram service and
 * dispatches to per-group coordinator fibers.
 *
 * Port of top-level message routing from src/index.ts (v1).
 */

import { Effect, Queue, Ref, Stream } from 'effect';

import { AppConfig } from '../config.js';
import { Database } from '../services/Database.js';
import { Telegram, type IncomingMessage } from '../services/Telegram.js';
import { ContainerRunner } from '../services/ContainerRunner.js';
import { Supermemory } from '../services/Supermemory.js';
import { TTS } from '../services/TTS.js';
import { BrowseHost } from '../services/BrowseHost.js';
import { GroupRegistry } from '../state/GroupRegistry.js';
import { AgentSemaphore } from './AgentSemaphore.js';
import {
  createGroupCoordinator,
  type GroupCoordinatorHandle,
} from './GroupCoordinator.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MessageRouterDeps {
  readonly AppConfig: AppConfig;
  readonly Database: Database;
  readonly Telegram: Telegram;
  readonly ContainerRunner: ContainerRunner;
  readonly Supermemory: Supermemory;
  readonly TTS: TTS;
  readonly BrowseHost: BrowseHost;
  readonly GroupRegistry: GroupRegistry;
  readonly AgentSemaphore: AgentSemaphore;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Filter out the bot's own messages.
 * In v1, messages prefixed with "ASSISTANT_NAME:" are the bot's own messages.
 */
function isBotOwnMessage(msg: IncomingMessage, assistantName: string): boolean {
  return msg.senderName === assistantName;
}

// ─── Router ─────────────────────────────────────────────────────────────────

/**
 * Start the message router. This connects to Telegram, catches up missed
 * messages, then routes the incoming stream to per-group coordinator fibers.
 *
 * Blocks until Telegram disconnects or the fiber is interrupted.
 */
export const startMessageRouter: Effect.Effect<
  void,
  never,
  | AppConfig
  | Database
  | Telegram
  | ContainerRunner
  | Supermemory
  | TTS
  | BrowseHost
  | GroupRegistry
  | AgentSemaphore
> = Effect.gen(function* () {
  const config = yield* AppConfig;
  const telegram = yield* Telegram;
  const registry = yield* GroupRegistry;

  // Map of group folder -> coordinator handle
  const coordinatorsRef = yield* Ref.make<
    Record<string, GroupCoordinatorHandle>
  >({});

  // Connect to Telegram and get the message stream
  const messageStream = yield* telegram.connect;

  // Route each message to the appropriate group coordinator
  yield* messageStream.pipe(
    // Filter out bot's own messages
    Stream.filter((msg) => !isBotOwnMessage(msg, config.assistantName)),
    Stream.tap((msg) =>
      Effect.gen(function* () {
        // Look up the group for this chat
        const group = yield* registry.get(msg.chatJid);
        if (!group) {
          yield* Effect.log(
            `Ignoring message from unregistered chat: ${msg.chatJid}`,
          );
          return;
        }

        // Get or create coordinator for this group
        const coordinators = yield* Ref.get(coordinatorsRef);
        let coordinator = coordinators[group.folder];

        if (!coordinator) {
          coordinator = yield* createGroupCoordinator(msg.chatJid, group);
          yield* Ref.update(coordinatorsRef, (c) => ({
            ...c,
            [group.folder]: coordinator!,
          }));
          // Fork the coordinator's processing loop
          yield* Effect.fork(coordinator.loop);
          yield* Effect.log(`Started coordinator for group: ${group.name}`);
        }

        // Enqueue message
        yield* Queue.offer(coordinator.queue, msg);
      }),
    ),
    Stream.runDrain,
  );
}).pipe(Effect.catchAll((err) => Effect.log(`MessageRouter error: ${err}`)));
