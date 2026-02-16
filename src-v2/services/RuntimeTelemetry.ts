/**
 * RuntimeTelemetry — Effect-based runtime observability.
 *
 * Uses Effect best practices:
 * - SubscriptionRef for reactive state broadcasting
 * - Ref for mutable state within service
 * - Metric for counters/gauges
 * - Effect.addFinalizer for lifecycle hooks
 */

import { Context, Effect, Layer, Metric, Option, Ref, Stream, SubscriptionRef } from 'effect';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FiberInfo {
  readonly id: string;
  readonly name: string;
  readonly status: 'running' | 'suspended' | 'done';
  readonly groupFolder: string | null;
  readonly startedAt: number;
}

export interface CoordinatorInfo {
  readonly groupFolder: string;
  readonly chatJid: string;
  readonly queueLength: number;
  readonly activeFiber: string | null;
  readonly lastActivity: number;
}

export interface SemaphoreState {
  readonly available: number;
  readonly max: number;
  readonly waiting: number;
}

export interface RuntimeSnapshot {
  readonly fibers: ReadonlyArray<FiberInfo>;
  readonly coordinators: ReadonlyArray<CoordinatorInfo>;
  readonly semaphore: SemaphoreState;
  readonly uptimeMs: number;
  readonly timestamp: number;
}

export type RuntimeEventType =
  | 'fiber_spawned'
  | 'fiber_done'
  | 'fiber_interrupted'
  | 'message_queued'
  | 'message_processed'
  | 'semaphore_acquired'
  | 'semaphore_released'
  | 'snapshot';

export interface RuntimeEvent {
  readonly type: RuntimeEventType;
  readonly payload: unknown;
  readonly timestamp: number;
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

const fiberSpawnCounter = Metric.counter('runtime_fibers_spawned', {
  description: 'Total fibers spawned',
});

const fiberDoneCounter = Metric.counter('runtime_fibers_done', {
  description: 'Total fibers completed',
});

const messageQueuedCounter = Metric.counter('runtime_messages_queued', {
  description: 'Total messages queued',
});

const messageProcessedCounter = Metric.counter('runtime_messages_processed', {
  description: 'Total messages processed',
});

// ─── Service Interface ───────────────────────────────────────────────────────

export interface RuntimeTelemetryService {
  readonly getSnapshot: Effect.Effect<RuntimeSnapshot>;
  readonly getEvents: Effect.Effect<ReadonlyArray<RuntimeEvent>>;
  readonly eventsStream: Stream.Stream<RuntimeEvent>;

  readonly registerFiber: (
    name: string,
    groupFolder: string | null,
  ) => Effect.Effect<{ id: string; onDone: () => Effect.Effect<void> }>;

  readonly registerCoordinator: (
    groupFolder: string,
    chatJid: string,
  ) => Effect.Effect<{
    onMessageQueued: () => Effect.Effect<void>;
    onMessageProcessed: () => Effect.Effect<void>;
    setActiveFiber: (fiberId: string | null) => Effect.Effect<void>;
    setQueueLength: (length: number) => Effect.Effect<void>;
    cleanup: () => Effect.Effect<void>;
  }>;

  readonly initSemaphore: (
    max: number,
  ) => Effect.Effect<{
    onAcquired: () => Effect.Effect<void>;
    onReleased: () => Effect.Effect<void>;
    onWaiting: () => Effect.Effect<void>;
  }>;
}

export class RuntimeTelemetry extends Context.Tag('RuntimeTelemetry')<
  RuntimeTelemetry,
  RuntimeTelemetryService
>() {}

// ─── Live Layer ─────────────────────────────────────────────────────────────

export const RuntimeTelemetryLive: Layer.Layer<RuntimeTelemetry> = Layer.effect(
  RuntimeTelemetry,
  Effect.gen(function* () {
    const startTime = Date.now();

    const fiberRegistry = yield* Ref.make<Map<string, FiberInfo>>(new Map());
    const coordinatorRegistry = yield* Ref.make<Map<string, CoordinatorInfo>>(
      new Map(),
    );
    const semaphoreRef = yield* Ref.make<SemaphoreState>({
      available: 4,
      max: 4,
      waiting: 0,
    });
    const eventQueue = yield* Ref.make<RuntimeEvent[]>([]);
    const eventQueueRef = yield* SubscriptionRef.make<RuntimeEvent | null>(null);

    const recordEvent = (type: RuntimeEventType, payload: unknown) =>
      Effect.gen(function* () {
        const event: RuntimeEvent = {
          type,
          payload,
          timestamp: Date.now(),
        };

        yield* Ref.update(eventQueue, (q) => {
          const next = [...q, event];
          return next.slice(-500);
        });

        yield* SubscriptionRef.set(eventQueueRef, event);
      });

    const getSnapshot = Effect.gen(function* () {
      const fibers = Array.from((yield* Ref.get(fiberRegistry)).values());
      const coordinators = Array.from(
        (yield* Ref.get(coordinatorRegistry)).values(),
      );
      const semaphore = yield* Ref.get(semaphoreRef);

      return {
        fibers,
        coordinators,
        semaphore,
        uptimeMs: Date.now() - startTime,
        timestamp: Date.now(),
      } satisfies RuntimeSnapshot;
    });

    const getEvents = Ref.get(eventQueue);

    const eventsStream = eventQueueRef.changes.pipe(
      Stream.filterMap((e) => (e ? Option.some(e) : Option.none())),
    );

    const registerFiber = (name: string, groupFolder: string | null) =>
      Effect.gen(function* () {
        const fiberId = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

        const info: FiberInfo = {
          id: fiberId,
          name,
          status: 'running',
          groupFolder,
          startedAt: Date.now(),
        };

        yield* Ref.update(fiberRegistry, (m) => new Map(m).set(fiberId, info));
        yield* recordEvent('fiber_spawned', { fiberId, name, groupFolder });
        yield* fiberSpawnCounter(Effect.succeed(1));

        const onDone = Effect.gen(function* () {
          yield* Ref.update(fiberRegistry, (m) => {
            const next = new Map(m);
            next.delete(fiberId);
            return next;
          });
          yield* recordEvent('fiber_done', { fiberId, name });
          yield* fiberDoneCounter(Effect.succeed(1));
        });

        return { id: fiberId, onDone };
      });

    const registerCoordinator = (groupFolder: string, chatJid: string) =>
      Effect.gen(function* () {
        const info: CoordinatorInfo = {
          groupFolder,
          chatJid,
          queueLength: 0,
          activeFiber: null,
          lastActivity: Date.now(),
        };

        yield* Ref.update(
          coordinatorRegistry,
          (m) => new Map(m).set(groupFolder, info),
        );

        const onMessageQueued = Effect.gen(function* () {
          yield* Ref.update(coordinatorRegistry, (m) => {
            const existing = m.get(groupFolder);
            if (!existing) return m;
            const next = new Map(m);
            next.set(groupFolder, {
              ...existing,
              queueLength: existing.queueLength + 1,
              lastActivity: Date.now(),
            });
            return next;
          });
          yield* recordEvent('message_queued', { groupFolder });
          yield* messageQueuedCounter(Effect.succeed(1));
        });

        const onMessageProcessed = Effect.gen(function* () {
          yield* Ref.update(coordinatorRegistry, (m) => {
            const existing = m.get(groupFolder);
            if (!existing) return m;
            const next = new Map(m);
            next.set(groupFolder, {
              ...existing,
              queueLength: Math.max(0, existing.queueLength - 1),
              lastActivity: Date.now(),
            });
            return next;
          });
          yield* recordEvent('message_processed', { groupFolder });
          yield* messageProcessedCounter(Effect.succeed(1));
        });

        const setActiveFiber = (fiberId: string | null) =>
          Ref.update(coordinatorRegistry, (m) => {
            const existing = m.get(groupFolder);
            if (!existing) return m;
            const next = new Map(m);
            next.set(groupFolder, {
              ...existing,
              activeFiber: fiberId,
              lastActivity: Date.now(),
            });
            return next;
          });

        const setQueueLength = (length: number) =>
          Ref.update(coordinatorRegistry, (m) => {
            const existing = m.get(groupFolder);
            if (!existing) return m;
            const next = new Map(m);
            next.set(groupFolder, { ...existing, queueLength: length });
            return next;
          });

        const cleanup = Ref.update(coordinatorRegistry, (m) => {
          const next = new Map(m);
          next.delete(groupFolder);
          return next;
        });

        return {
          onMessageQueued,
          onMessageProcessed,
          setActiveFiber,
          setQueueLength,
          cleanup,
        };
      });

    const initSemaphore = (max: number) =>
      Effect.gen(function* () {
        yield* Ref.set(semaphoreRef, { available: max, max, waiting: 0 });

        const onAcquired = Effect.gen(function* () {
          yield* Ref.update(semaphoreRef, (s) => ({
            ...s,
            available: s.available - 1,
          }));
          yield* recordEvent('semaphore_acquired', {
            available: (yield* Ref.get(semaphoreRef)).available,
          });
        });

        const onReleased = Effect.gen(function* () {
          yield* Ref.update(semaphoreRef, (s) => ({
            ...s,
            available: s.available + 1,
          }));
          yield* recordEvent('semaphore_released', {
            available: (yield* Ref.get(semaphoreRef)).available,
          });
        });

        const onWaiting = Effect.gen(function* () {
          yield* Ref.update(semaphoreRef, (s) => ({
            ...s,
            waiting: s.waiting + 1,
          }));
        });

        return { onAcquired, onReleased, onWaiting };
      });

    yield* Effect.addFinalizer(() => Effect.log('RuntimeTelemetry shutdown'));

    return {
      getSnapshot,
      getEvents,
      eventsStream,
      registerFiber,
      registerCoordinator,
      initSemaphore,
    } satisfies RuntimeTelemetryService;
  }),
);
