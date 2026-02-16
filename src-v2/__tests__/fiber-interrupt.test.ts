/**
 * Verify Cause.isInterruptedOnly works correctly for fiber interruption.
 *
 * This is a critical pattern used in GroupCoordinator for auto-interrupt:
 * when a new message arrives, the active container fiber is interrupted
 * and isInterruptedOnly distinguishes interrupts from real errors.
 */

import { describe, it, expect } from 'bun:test';
import { Cause, Effect, Fiber } from 'effect';

describe('Fiber Interrupt Detection', () => {
  it('isInterruptedOnly returns true for fiber interrupts', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        // Fork a long-running effect
        const fiber = yield* Effect.fork(Effect.sleep('10 seconds'));

        // Interrupt it immediately
        yield* Fiber.interrupt(fiber);

        // Get the exit result
        const exit = yield* fiber.await;
        if (exit._tag === 'Failure') {
          return Cause.isInterruptedOnly(exit.cause);
        }
        return false;
      }),
    );

    expect(result).toBe(true);
  });

  it('isInterruptedOnly returns false for non-interrupt failures', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        // Fork an effect that fails with an error
        const fiber = yield* Effect.fork(
          Effect.fail(new Error('test error')),
        );

        // Wait for it to complete
        const exit = yield* fiber.await;
        if (exit._tag === 'Failure') {
          return Cause.isInterruptedOnly(exit.cause);
        }
        return true; // Shouldn't reach here
      }),
    );

    expect(result).toBe(false);
  });

  it('isInterruptedOnly returns false for defects', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        // Fork an effect that dies with a defect
        const fiber = yield* Effect.fork(
          Effect.die(new Error('defect!')),
        );

        const exit = yield* fiber.await;
        if (exit._tag === 'Failure') {
          return Cause.isInterruptedOnly(exit.cause);
        }
        return true;
      }),
    );

    expect(result).toBe(false);
  });

  it('catchAllCause + isInterruptedOnly pattern works correctly', async () => {
    // This is the exact pattern used in GroupCoordinator
    const log: string[] = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          Effect.sleep('10 seconds').pipe(
            Effect.map(() => 'should not complete'),
          ),
        );

        // Interrupt after small delay
        yield* Effect.sleep('10 millis');
        yield* Fiber.interrupt(fiber);

        // Join and handle like GroupCoordinator does
        yield* Fiber.join(fiber).pipe(
          Effect.catchAllCause((cause) =>
            Cause.isInterruptedOnly(cause)
              ? Effect.sync(() => { log.push('interrupted'); })
              : Effect.failCause(cause),
          ),
          Effect.ignore,
        );
      }),
    );

    expect(log).toEqual(['interrupted']);
  });

  it('non-interrupt error propagates through catchAllCause', async () => {
    const log: string[] = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          Effect.fail('real error'),
        );

        yield* Fiber.join(fiber).pipe(
          Effect.catchAllCause((cause) =>
            Cause.isInterruptedOnly(cause)
              ? Effect.sync(() => { log.push('interrupted'); })
              : Effect.sync(() => { log.push('error'); }),
          ),
        );
      }),
    );

    expect(log).toEqual(['error']);
  });
});
