/**
 * AgentSemaphore — global concurrency limiter shared across all group coordinators.
 *
 * Limits the number of concurrent agent containers to MAX_CONCURRENT_AGENTS (default 4).
 */

import { Context, Effect, Layer } from 'effect';
import { AppConfig } from '../config.js';

// ─── Service Tag ─────────────────────────────────────────────────────────────

export class AgentSemaphore extends Context.Tag('AgentSemaphore')<
  AgentSemaphore,
  Effect.Semaphore
>() {}

// ─── Live Layer ──────────────────────────────────────────────────────────────

export const AgentSemaphoreLive: Layer.Layer<AgentSemaphore, never, AppConfig> =
  Layer.effect(
    AgentSemaphore,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      return yield* Effect.makeSemaphore(config.maxConcurrentAgents);
    }),
  );
