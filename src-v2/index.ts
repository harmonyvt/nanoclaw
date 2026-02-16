/**
 * NanoClaw v2 — Effect-based runtime entry point.
 *
 * Phase 1: Minimal bootstrap that loads config and logs startup.
 * Subsequent phases will add service initialization, fiber spawning,
 * and the full message processing pipeline.
 */

import { Effect } from 'effect';
import { AppConfig } from './config.js';
import { MainLive } from './layers/Live.js';

const program = Effect.gen(function* () {
  const config = yield* AppConfig;

  yield* Effect.log(
    `NanoClaw v2 starting (assistant: @${config.assistantName})`,
  );
  yield* Effect.log(`Provider: ${config.defaultProvider}`);
  yield* Effect.log(`Container image: ${config.containerImage}`);
  yield* Effect.log(`Project root: ${config.projectRoot}`);

  if (!config.telegramBotToken) {
    yield* Effect.logError('TELEGRAM_BOT_TOKEN is required');
    return yield* Effect.fail(new Error('TELEGRAM_BOT_TOKEN is required'));
  }

  if (!config.telegramOwnerId) {
    yield* Effect.logError('TELEGRAM_OWNER_ID is required');
    return yield* Effect.fail(new Error('TELEGRAM_OWNER_ID is required'));
  }

  yield* Effect.log('Phase 1 scaffolding complete — services not yet wired');
});

const main = program.pipe(
  Effect.provide(MainLive),
  Effect.tapErrorCause((cause) =>
    Effect.logError('Fatal error').pipe(
      Effect.annotateLogs('cause', String(cause)),
    ),
  ),
);

Effect.runPromise(main).catch((err) => {
  console.error(`[nanoclaw-v2] Fatal: ${err}`);
  process.exit(1);
});
