/**
 * SchedulerLive — task scheduler on a 60-second polling loop.
 *
 * Port of src/task-scheduler.ts (v1).
 */

import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';
import { Effect, Fiber, Layer, Schedule, Scope } from 'effect';

import { AppConfig } from '../config.js';
import { Database } from './Database.js';
import { ContainerRunner } from './ContainerRunner.js';
import { GroupRegistry } from '../state/GroupRegistry.js';
import { SchedulerError } from '../errors.js';
import { Scheduler } from './Scheduler.js';
import type { SchedulerService, TaskRunResult } from './Scheduler.js';
import type { ScheduledTask } from '../schemas/Tasks.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const SCHEDULER_FILE_PATH = 'src-v2/services/SchedulerLive.ts';

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (
    typeof err === 'object' &&
    err !== null &&
    'message' in err &&
    typeof (err as { message?: unknown }).message === 'string'
  ) {
    return (err as { message: string }).message;
  }
  return String(err);
}

function logSchedulerError(
  message: string,
  err: unknown,
  context: Record<string, unknown> = {},
): Effect.Effect<void> {
  const details = err instanceof Error
    ? { message: err.message, stack: err.stack }
    : { message: errorMessage(err), stack: undefined };

  return Effect.logError(
    JSON.stringify({
      component: 'SchedulerLive',
      file: SCHEDULER_FILE_PATH,
      message,
      ...context,
      error: details.message,
      stack: details.stack,
    }),
  );
}

function computeNextRun(
  task: ScheduledTask,
  timezone: string,
): string | null {
  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: timezone,
    });
    return interval.next().toISOString();
  }
  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    return new Date(Date.now() + ms).toISOString();
  }
  // 'once' tasks have no next run
  return null;
}

// ─── Live Layer ─────────────────────────────────────────────────────────────

export const SchedulerLive: Layer.Layer<
  Scheduler,
  never,
  Database | ContainerRunner | GroupRegistry | AppConfig
> = Layer.scoped(
  Scheduler,
  Effect.gen(function* () {
    const db = yield* Database;
    const runner = yield* ContainerRunner;
    const registry = yield* GroupRegistry;
    const config = yield* AppConfig;

    /** Write tasks snapshot for container to read. */
    const writeTaskSnapshot = (
      groupFolder: string,
      isMain: boolean,
      taskId?: string,
    ) =>
      Effect.gen(function* () {
        const allTasks = yield* db.getAllTasks;
        const visibleTasks = isMain
          ? allTasks
          : allTasks.filter((t) => t.group_folder === groupFolder);

        const snapshotPath = path.join(
          config.dataDir,
          'ipc',
          groupFolder,
          'current_tasks.json',
        );
        yield* Effect.try({
          try: () => {
            fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
            fs.writeFileSync(
              snapshotPath,
              JSON.stringify(
                visibleTasks.map((t) => ({
                  id: t.id,
                  groupFolder: t.group_folder,
                  prompt: t.prompt,
                  schedule_type: t.schedule_type,
                  schedule_value: t.schedule_value,
                  status: t.status,
                  next_run: t.next_run,
                })),
                null,
                2,
              ),
            );
          },
          catch: (err) =>
            new SchedulerError({
              message: `Failed to write task snapshot: ${errorMessage(err)}`,
              taskId,
              cause: err,
            }),
        });
      });

    /** Run a single task. */
    const runTask = (task: ScheduledTask) => {
      const startTime = Date.now();
      const runAt = new Date().toISOString();
      const isMain = task.group_folder === config.mainGroupFolder;

      return Effect.gen(function* () {
        // Write snapshot before running
        yield* writeTaskSnapshot(task.group_folder, isMain, task.id).pipe(
          Effect.catchAll((err) =>
            logSchedulerError(
              'write_snapshot_before_run_failed',
              err,
              {
                taskId: task.id,
                groupFolder: task.group_folder,
              },
            ),
          ),
        );

        // Resolve group
        const group = yield* registry.get(task.chat_jid);
        if (!group) {
          yield* db.logTaskRun({
            task_id: task.id,
            run_at: runAt,
            duration_ms: Date.now() - startTime,
            status: 'error',
            result: null,
            error: `Group not found: ${task.group_folder}`,
          });
          return;
        }

        // Build container input
        const containerInput = {
          prompt: task.prompt,
          groupFolder: task.group_folder,
          chatJid: task.chat_jid,
          isMain,
          isScheduledTask: true,
          assistantName: config.assistantName,
          provider:
            group.providerConfig?.provider || config.defaultProvider,
          model:
            group.providerConfig?.model || config.defaultModel || undefined,
          baseUrl: group.providerConfig?.baseUrl || undefined,
          enableThinking: true,
        };

        // Run in a fresh scope
        const result = yield* Effect.scoped(
          runner.runAgent(containerInput, {}),
        ).pipe(
          Effect.map(
            (output) =>
              ({
                taskId: task.id,
                status: output.status === 'error' ? 'error' : 'success',
                result: output.result || null,
                error: output.error || undefined,
                durationMs: Date.now() - startTime,
              }) satisfies TaskRunResult,
          ),
          Effect.catchAll((err) =>
            Effect.succeed({
              taskId: task.id,
              status: 'error' as const,
              result: null,
              error: errorMessage(err),
              durationMs: Date.now() - startTime,
            } satisfies TaskRunResult),
          ),
        );

        // Log run
        yield* db.logTaskRun({
          task_id: task.id,
          run_at: runAt,
          duration_ms: result.durationMs,
          status: result.status,
          result: result.result,
          error: result.error || null,
        });

        // Compute next run
        const nextRun = computeNextRun(task, config.timezone);
        const resultSummary = result.error
          ? `Error: ${result.error}`
          : result.result
            ? result.result.slice(0, 200)
            : 'Completed';
        yield* db.updateTaskAfterRun(task.id, nextRun, resultSummary);

        // Update snapshot after run
        yield* writeTaskSnapshot(task.group_folder, isMain, task.id).pipe(
          Effect.catchAll((err) =>
            logSchedulerError(
              'write_snapshot_after_run_failed',
              err,
              {
                taskId: task.id,
                groupFolder: task.group_folder,
              },
            ),
          ),
        );
      }).pipe(
        Effect.catchAll((err) =>
          Effect.gen(function* () {
            const errMsg = errorMessage(err);
            yield* logSchedulerError('task_run_failed', err, {
              taskId: task.id,
              groupFolder: task.group_folder,
            });

            yield* db.logTaskRun({
              task_id: task.id,
              run_at: runAt,
              duration_ms: Date.now() - startTime,
              status: 'error',
              result: null,
              error: errMsg,
            }).pipe(
              Effect.catchAll((logErr) =>
                logSchedulerError('task_run_log_failed', logErr, {
                  taskId: task.id,
                }),
              ),
            );
          }),
        ),
      );
    };

    /** Poll for due tasks. */
    const pollDueTasks = Effect.gen(function* () {
      const dueTasks = yield* db.getDueTasks;
      for (const task of dueTasks) {
        // Re-check status (may have been paused/cancelled)
        const current = yield* db.getTaskById(task.id);
        if (!current || current.status !== 'active') continue;

        // Fork each task so they don't block each other
        yield* Effect.fork(runTask(current));
      }
    }).pipe(
      Effect.catchAll((err) =>
        logSchedulerError('poll_due_tasks_failed', err, {
          phase: 'poll_due_tasks',
        }),
      ),
    );

    // ── Start scheduler fiber ────────────────────────────────────────

    let schedulerFiber: Fiber.Fiber<void, never> | null = null;

    const service: SchedulerService = {
      start: Effect.gen(function* () {
        if (schedulerFiber) return;
        const fiber = yield* Effect.fork(
          pollDueTasks.pipe(
            Effect.repeat(Schedule.fixed('60 seconds')),
            Effect.asVoid,
          ),
        );
        schedulerFiber = fiber;
      }),

      runTaskNow: (taskId) =>
        Effect.gen(function* () {
          const task = yield* db.getTaskById(taskId).pipe(
            Effect.catchAll((err) =>
              Effect.fail(
                new SchedulerError({
                  message: `DB error: ${err.message}`,
                  taskId,
                }),
              ),
            ),
          );
          if (!task) {
            return yield* Effect.fail(
              new SchedulerError({
                message: 'Task not found',
                taskId,
              }),
            );
          }
          const startTime = Date.now();
          yield* runTask(task);
          return {
            taskId,
            status: 'success' as const,
            result: null,
            durationMs: Date.now() - startTime,
          };
        }),
    };

    // Finalizer: stop scheduler fiber
    yield* Effect.addFinalizer(() =>
      schedulerFiber
        ? Fiber.interrupt(schedulerFiber).pipe(Effect.ignore)
        : Effect.void,
    );

    return service;
  }),
);
