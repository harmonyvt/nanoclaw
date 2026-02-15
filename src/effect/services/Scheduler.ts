/**
 * Effect service: Task Scheduler
 *
 * Wraps the cron/interval/once task scheduling into an Effect fiber
 * that polls for due tasks at a configurable interval.
 */
import { Context, Effect, Layer, Schedule, Fiber, Ref } from 'effect';

import {
  startSchedulerLoop,
  runTaskNow,
} from '../../task-scheduler.js';
import type { SchedulerDependencies } from '../../task-scheduler.js';

export interface SchedulerService {
  readonly start: (deps: SchedulerDependencies) => Effect.Effect<void>;
  readonly runTaskNow: (
    taskId: string,
    deps: SchedulerDependencies,
  ) => Effect.Effect<{ success: boolean; error?: string; durationMs?: number }>;
}

export class Scheduler extends Context.Tag('nanoclaw/Scheduler')<
  Scheduler,
  SchedulerService
>() {}

export const SchedulerLive = Layer.succeed(Scheduler, {
  start: (deps) => Effect.sync(() => startSchedulerLoop(deps)),
  runTaskNow: (taskId, deps) => Effect.promise(() => runTaskNow(taskId, deps)),
} satisfies SchedulerService);
