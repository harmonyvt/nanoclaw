/**
 * NanoClaw v2 — Effect-based runtime entry point.
 *
 * Uses Effect.runFork with proper signal handling for
 * graceful fiber cascade shutdown on SIGINT/SIGTERM.
 */

import { Effect, Fiber, Runtime } from 'effect';

import { AppConfig } from './config.js';
import { Docker } from './services/Docker.js';
import { ContainerRunner } from './services/ContainerRunner.js';
import { Scheduler } from './services/Scheduler.js';
import { Sandbox } from './services/Sandbox.js';
import { MainLive } from './layers/Live.js';

import { startMessageRouter } from './coordinators/MessageRouter.js';
import { startIpcWatcher } from './coordinators/IpcWatcher.js';

// ─── Main Program ───────────────────────────────────────────────────────────

const program = Effect.gen(function* () {
  const config = yield* AppConfig;

  yield* Effect.log(
    `NanoClaw v2 starting (assistant: @${config.assistantName})`,
  );
  yield* Effect.log(`Provider: ${config.defaultProvider}`);
  yield* Effect.log(`Container image: ${config.containerImage}`);

  // Validate required config
  if (!config.telegramBotToken) {
    return yield* Effect.die(new Error('TELEGRAM_BOT_TOKEN is required'));
  }
  if (!config.telegramOwnerId) {
    return yield* Effect.die(new Error('TELEGRAM_OWNER_ID is required'));
  }

  // Validate Docker is running
  const docker = yield* Docker;
  yield* docker.isRunning;
  yield* Effect.log('Docker is running');

  // Ensure agent image exists (auto-rebuild if missing)
  const runner = yield* ContainerRunner;
  yield* runner.ensureImage;
  yield* Effect.log('Agent image ready');

  // Cleanup orphan containers from previous runs
  yield* runner.cleanupOrphans.pipe(Effect.ignore);

  // Start sandbox idle watcher
  const sandbox = yield* Sandbox;
  yield* sandbox.startIdleWatcher;

  // Start scheduler fiber
  const scheduler = yield* Scheduler;
  yield* Effect.fork(scheduler.start);
  yield* Effect.log('Scheduler started');

  // Start IPC watcher fiber
  yield* Effect.fork(startIpcWatcher);
  yield* Effect.log('IPC watcher started');

  // Start message router (blocks until Telegram disconnects)
  yield* Effect.log('Starting message router...');
  yield* startMessageRouter;
});

// ─── Bootstrap ──────────────────────────────────────────────────────────────

const main = program.pipe(
  Effect.provide(MainLive),
  Effect.scoped,
  Effect.tapErrorCause((cause) =>
    Effect.logError('Fatal error').pipe(
      Effect.annotateLogs('cause', String(cause)),
    ),
  ),
);

// Run with proper signal handling
const fiber = Effect.runFork(main);

// Graceful shutdown on SIGINT/SIGTERM
const shutdown = () => {
  Effect.runFork(Fiber.interrupt(fiber));
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
