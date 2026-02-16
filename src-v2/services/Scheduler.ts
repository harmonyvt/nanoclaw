/**
 * Scheduler service — manages cron/interval/once task scheduling.
 */

import { Context, Effect } from 'effect';
import type { SchedulerError } from '../errors.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface TaskRunResult {
  readonly taskId: string;
  readonly status: 'success' | 'error';
  readonly result: string | null;
  readonly error?: string;
  readonly durationMs: number;
}

// ─── Service Interface ─────────────────────────────────────────────────────

export interface SchedulerService {
  /** Start the scheduler fiber (polls DB for due tasks). */
  readonly start: Effect.Effect<void, SchedulerError>;

  /** Run a specific task immediately by ID */
  readonly runTaskNow: (
    taskId: string,
  ) => Effect.Effect<TaskRunResult, SchedulerError>;
}

export class Scheduler extends Context.Tag('Scheduler')<
  Scheduler,
  SchedulerService
>() {}
