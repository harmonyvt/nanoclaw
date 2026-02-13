import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  GROUPS_DIR,
  MAIN_GROUP_FOLDER,
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import {
  HostRpcRequest,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllTasks,
  getDueTasks,
  getTaskById,
  logTaskRun,
  updateTaskAfterRun,
} from './db.js';
import { logger } from './logger.js';
import { logDebugEvent } from './debug-log.js';
import { RegisteredGroup, ScheduledTask } from './types.js';
import { resolveAssistantIdentity } from './soul.js';

export interface SchedulerDependencies {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  handleHostRpcRequest?: (sourceGroup: string, req: HostRpcRequest) => Promise<unknown>;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  const groupDir = path.join(GROUPS_DIR, task.group_folder);
  fs.mkdirSync(groupDir, { recursive: true });

  logDebugEvent('sdk', 'task_run_start', task.group_folder, {
    taskId: task.id,
    scheduleType: task.schedule_type,
  });
  logger.info(
    { module: 'scheduler', taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { module: 'scheduler', taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = task.group_folder === MAIN_GROUP_FOLDER;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  try {
    const provider = group.providerConfig?.provider || DEFAULT_PROVIDER;
    const model = group.providerConfig?.model || DEFAULT_MODEL || undefined;

    const output = await runContainerAgent(group, {
      prompt: task.prompt,
      groupFolder: task.group_folder,
      chatJid: task.chat_jid,
      isMain,
      isScheduledTask: true,
      assistantName: resolveAssistantIdentity(task.group_folder, ASSISTANT_NAME),
      provider,
      model,
      enableThinking: true,
    }, deps.handleHostRpcRequest
      ? {
          onRequest: (req) => deps.handleHostRpcRequest!(task.group_folder, req),
        }
      : undefined);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else {
      result = output.result;
    }

    logger.info(
      { module: 'scheduler', taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger.error({ module: 'scheduler', taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logDebugEvent('sdk', 'task_run_complete', task.group_folder, {
    taskId: task.id,
    durationMs,
    status: error ? 'error' : 'success',
  });
  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  let nextRun: string | null = null;
  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    nextRun = interval.next().toISOString();
  } else if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    nextRun = new Date(Date.now() + ms).toISOString();
  }
  // 'once' tasks have no next run

  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

/**
 * Manually trigger a task for immediate execution.
 * Does not affect the task's next_run or status -- the regular scheduler handles that.
 */
export async function runTaskNow(
  taskId: string,
  deps: SchedulerDependencies,
): Promise<{ success: boolean; error?: string; durationMs?: number }> {
  const task = getTaskById(taskId);
  if (!task) {
    return { success: false, error: 'Task not found' };
  }

  const startTime = Date.now();
  try {
    await runTask(task, deps);
    return { success: true, durationMs: Date.now() - startTime };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startTime,
    };
  }
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug({ module: 'scheduler' }, 'Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info({ module: 'scheduler' }, 'Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ module: 'scheduler', count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        await runTask(currentTask, deps);
      }
    } catch (err) {
      logger.error({ module: 'scheduler', err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}
