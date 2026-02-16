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
    const writeTaskSnapshot = (groupFolder: string, isMain: boolean) =>
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
          catch: () =>
            new SchedulerError({ message: 'Failed to write task snapshot' }),
        });
      }).pipe(Effect.ignore);

    /** Run a single task. */
    const runTask = (task: ScheduledTask) =>
      Effect.gen(function* () {
        const startTime = Date.now();
        const isMain = task.group_folder === config.mainGroupFolder;

        // Write snapshot before running
        yield* writeTaskSnapshot(task.group_folder, isMain);

        // Resolve group
        const group = yield* registry.get(task.chat_jid);
        if (!group) {
          yield* db.logTaskRun({
            task_id: task.id,
            run_at: new Date().toISOString(),
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
              error: String(err),
              durationMs: Date.now() - startTime,
            } satisfies TaskRunResult),
          ),
        );

        // Log run
        yield* db.logTaskRun({
          task_id: task.id,
          run_at: new Date().toISOString(),
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
        yield* writeTaskSnapshot(task.group_folder, isMain);
      }).pipe(Effect.catchAll(() => Effect.void));

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
    }).pipe(Effect.catchAll(() => Effect.void));

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
