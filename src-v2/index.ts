/**
 * NanoClaw v2 — Effect-based runtime entry point.
 *
 * Uses Effect.runFork with graceful shutdown:
 * - SIGINT/SIGTERM → interrupt root fiber → cascade to all child fibers
 * - Finalizers run in LIFO order: containers killed, sandbox stopped,
 *   Telegram disconnected, scheduler stopped, DB closed
 * - Hard 10s deadline if cleanup hangs
 * - Double Ctrl+C forces immediate exit (dev convenience)
 */

import { Cause, Effect, Exit, Fiber } from 'effect';

import { AppConfig } from './config.js';
import { Docker } from './services/Docker.js';
import { ContainerRunner } from './services/ContainerRunner.js';
import { Scheduler } from './services/Scheduler.js';
import { Sandbox } from './services/Sandbox.js';
import { TakeoverWeb } from './services/TakeoverWeb.js';
import { MainLive, MainLiveSim } from './layers/Live.js';

import { startMessageRouter } from './coordinators/MessageRouter.js';
import { startIpcWatcher } from './coordinators/IpcWatcher.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const SHUTDOWN_TIMEOUT_MS = 10_000;
const SIMULATE_LOCAL_IO = process.env.NANOCLAW_SIMULATE === '1';

// ─── Main Program ───────────────────────────────────────────────────────────

const program = Effect.gen(function* () {
  const config = yield* AppConfig;

  yield* Effect.log(
    `NanoClaw v2 starting (assistant: @${config.assistantName})`,
  );
  yield* Effect.log(`Provider: ${config.defaultProvider}`);
  yield* Effect.log(
    `Container image: ${config.containerImage} (agent v${config.containerAgentVersion})`,
  );
  if (SIMULATE_LOCAL_IO) {
    yield* Effect.log(
      'Local simulation mode enabled (terminal input/output transport)',
    );
  }

  // Validate required config
  if (!SIMULATE_LOCAL_IO && !config.telegramBotToken) {
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

  // Start takeover web service
  const takeoverWeb = yield* TakeoverWeb;
  yield* takeoverWeb.start;
  const takeoverBaseUrl = yield* takeoverWeb.getTakeoverBaseUrl;
  if (takeoverBaseUrl) {
    yield* Effect.log(`CUA takeover UI: ${takeoverBaseUrl}`);
  } else {
    yield* Effect.log('CUA takeover UI: disabled');
  }

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
  Effect.provide(SIMULATE_LOCAL_IO ? MainLiveSim : MainLive),
  Effect.scoped,
  Effect.tapErrorCause((cause) =>
    Effect.logError('Fatal error').pipe(
      Effect.annotateLogs('cause', String(cause)),
    ),
  ),
);

const fiber = Effect.runFork(main);

// ─── Graceful Shutdown ──────────────────────────────────────────────────────

let shuttingDown = false;

const shutdown = (signal: string) => {
  if (shuttingDown) {
    // Double signal = force exit (dev convenience: double Ctrl+C)
    console.log(`\n[shutdown] Forced exit (${signal} received twice)`);
    process.exit(1);
  }

  shuttingDown = true;
  console.log(`\n[shutdown] ${signal} received, shutting down gracefully...`);
  console.log(
    '[shutdown] Cleaning up: killing containers, stopping sandbox, disconnecting Telegram...',
  );

  // Hard deadline: if cleanup takes longer than SHUTDOWN_TIMEOUT_MS, force exit
  const hardDeadline = setTimeout(() => {
    console.error(
      `[shutdown] Cleanup timed out after ${SHUTDOWN_TIMEOUT_MS / 1000}s, forcing exit`,
    );
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  hardDeadline.unref(); // Don't keep the process alive just for this timer

  // Interrupt the root fiber — this cascades to all child fibers and runs
  // all Effect.addFinalizer callbacks in LIFO order:
  //   1. MessageRouter stops (interrupts GroupCoordinator fibers)
  //   2. IpcWatcher stops
  //   3. Scheduler fiber interrupted
  //   4. ContainerRunner kills all persistent containers
  //   5. Sandbox stopped
  //   6. Telegram bot disconnected
  //   7. Database closed
  const shutdownFiber = Effect.runFork(
    Effect.gen(function* () {
      const exit = yield* Fiber.interrupt(fiber).pipe(Effect.exit);

      if (Exit.isSuccess(exit)) {
        console.log('[shutdown] Clean shutdown complete');
      } else {
        const cause = exit.cause;
        if (Cause.isInterruptedOnly(cause)) {
          console.log('[shutdown] Clean shutdown complete (interrupted)');
        } else {
          console.error('[shutdown] Shutdown completed with errors:', Cause.pretty(cause));
        }
      }

      clearTimeout(hardDeadline);
      process.exit(0);
    }),
  );
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
