/**
 * Cancellation service — fiber-based interrupt signaling.
 * Replaces file-based isCancelled() polling.
 */

import { Context, Effect, Layer, Deferred, Fiber } from 'effect';
import { CancellationError } from '../errors/index.js';

// ─── Service Interface ─────────────────────────────────────────────────────

export interface CancellationService {
  /** Check if cancellation has been requested */
  readonly isCancelled: Effect.Effect<boolean>;

  /** Signal cancellation */
  readonly cancel: Effect.Effect<void>;

  /** Run an effect that will be interrupted on cancellation */
  readonly withCancellation: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | CancellationError, R>;
}

export class Cancellation extends Context.Tag('Cancellation')<
  Cancellation,
  CancellationService
>() {}

// ─── Live Layer ────────────────────────────────────────────────────────────

export const CancellationLive: Layer.Layer<Cancellation> = Layer.effect(
  Cancellation,
  Effect.gen(function* () {
    const signal = yield* Deferred.make<void, CancellationError>();

    return {
      isCancelled: Deferred.isDone(signal),

      cancel: Deferred.fail(
        signal,
        new CancellationError({ reason: 'User interrupt' }),
      ).pipe(Effect.ignore),

      withCancellation: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const mainFiber = yield* Effect.fork(effect);
          const cancelFiber = yield* Effect.fork(
            Effect.gen(function* () {
              yield* Deferred.await(signal);
              yield* Fiber.interrupt(mainFiber);
            }),
          );
          const result = yield* Fiber.join(mainFiber);
          yield* Fiber.interrupt(cancelFiber);
          return result;
        }) as Effect.Effect<A, E | CancellationError, R>,
    };
  }),
);
