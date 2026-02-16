/**
 * Task scheduling tools: schedule_task, list_tasks, pause_task, resume_task, cancel_task.
 */

import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';
import { Effect } from 'effect';
import type { NanoTool } from './types.js';
import type { HostBridge } from '../services/HostBridge.js';
import type { ToolError } from '../errors/index.js';
import { requestHost, writeIpcFile, IPC_DIR, TASKS_DIR } from './utils.js';

/** Try RPC first, fall back to file IPC. */
function dispatchTaskAction(
  data: Record<string, unknown>,
): Effect.Effect<string | null, ToolError, HostBridge> {
  return Effect.gen(function* () {
    const viaRpc = yield* requestHost('tasks.handle', data);
    if (viaRpc) {
      const rpc = viaRpc as { ok?: boolean; message?: string };
      return rpc.message || 'Task action handled.';
    }
    return writeIpcFile(TASKS_DIR, data);
  });
}

export const taskTools: NanoTool[] = [
  {
    name: 'schedule_task',
    description: `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE - Choose based on task type:
\u2022 "group" (recommended for most tasks): Task runs in the group's conversation context, with access to chat history and memory. Use for tasks that need context about ongoing discussions, user preferences, or previous interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
    schema: z.object({
      prompt: z
        .string()
        .describe(
          'What the agent should do when the task runs. For isolated mode, include all necessary context here.',
        ),
      schedule_type: z
        .enum(['cron', 'interval', 'once'])
        .describe(
          'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time',
        ),
      schedule_value: z
        .string()
        .describe(
          'cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)',
        ),
      context_mode: z
        .enum(['group', 'isolated'])
        .default('group')
        .describe(
          'group=runs with chat history and memory, isolated=fresh session (include context in prompt)',
        ),
      target_group: z
        .string()
        .optional()
        .describe(
          'Target group folder (main only, defaults to current group)',
        ),
    }),
    handler: (args, ctx) =>
      Effect.gen(function* () {
        const scheduleType = args.schedule_type as string;
        const scheduleValue = args.schedule_value as string;

        // Validate schedule_value
        if (scheduleType === 'cron') {
          try {
            CronExpressionParser.parse(scheduleValue);
          } catch {
            return {
              content: `Invalid cron: "${scheduleValue}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
              isError: true as const,
            };
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(scheduleValue, 10);
          if (isNaN(ms) || ms <= 0) {
            return {
              content: `Invalid interval: "${scheduleValue}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
              isError: true as const,
            };
          }
        } else if (scheduleType === 'once') {
          const date = new Date(scheduleValue);
          if (isNaN(date.getTime())) {
            return {
              content: `Invalid timestamp: "${scheduleValue}". Use ISO 8601 format like "2026-02-01T15:30:00.000Z".`,
              isError: true as const,
            };
          }
        }

        const targetGroup =
          ctx.isMain && args.target_group
            ? (args.target_group as string)
            : ctx.groupFolder;

        const data = {
          type: 'schedule_task',
          prompt: args.prompt as string,
          schedule_type: scheduleType,
          schedule_value: scheduleValue,
          context_mode: (args.context_mode as string) || 'group',
          groupFolder: targetGroup,
          chatJid: ctx.chatJid,
          createdBy: ctx.groupFolder,
          timestamp: new Date().toISOString(),
        };

        const result = yield* dispatchTaskAction(data);
        const tag = result || 'handled';

        return {
          content: `Task scheduled (${tag}): ${scheduleType} - ${scheduleValue}`,
        };
      }),
  },

  {
    name: 'list_tasks',
    description:
      "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
    schema: z.object({}),
    handler: (_args, ctx) =>
      Effect.gen(function* () {
        yield* Effect.succeed(undefined);

        const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

        try {
          if (!fs.existsSync(tasksFile)) {
            return { content: 'No scheduled tasks found.' };
          }

          const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8')) as Array<{
            id: string;
            prompt: string;
            schedule_type: string;
            schedule_value: string;
            status: string;
            next_run: string;
            groupFolder: string;
          }>;

          const tasks = ctx.isMain
            ? allTasks
            : allTasks.filter((t) => t.groupFolder === ctx.groupFolder);

          if (tasks.length === 0) {
            return { content: 'No scheduled tasks found.' };
          }

          const formatted = tasks
            .map(
              (t) =>
                `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
            )
            .join('\n');

          return { content: `Scheduled tasks:\n${formatted}` };
        } catch (err) {
          return {
            content: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }),
  },

  {
    name: 'pause_task',
    description: 'Pause a scheduled task. It will not run until resumed.',
    schema: z.object({
      task_id: z.string().describe('The task ID to pause'),
    }),
    handler: (args, ctx) =>
      Effect.gen(function* () {
        const data = {
          type: 'pause_task',
          taskId: args.task_id as string,
          groupFolder: ctx.groupFolder,
          isMain: ctx.isMain,
          timestamp: new Date().toISOString(),
        };

        yield* dispatchTaskAction(data);
        return { content: `Task ${args.task_id} pause requested.` };
      }),
  },

  {
    name: 'resume_task',
    description: 'Resume a paused task.',
    schema: z.object({
      task_id: z.string().describe('The task ID to resume'),
    }),
    handler: (args, ctx) =>
      Effect.gen(function* () {
        const data = {
          type: 'resume_task',
          taskId: args.task_id as string,
          groupFolder: ctx.groupFolder,
          isMain: ctx.isMain,
          timestamp: new Date().toISOString(),
        };

        yield* dispatchTaskAction(data);
        return { content: `Task ${args.task_id} resume requested.` };
      }),
  },

  {
    name: 'cancel_task',
    description: 'Cancel and delete a scheduled task.',
    schema: z.object({
      task_id: z.string().describe('The task ID to cancel'),
    }),
    handler: (args, ctx) =>
      Effect.gen(function* () {
        const data = {
          type: 'cancel_task',
          taskId: args.task_id as string,
          groupFolder: ctx.groupFolder,
          isMain: ctx.isMain,
          timestamp: new Date().toISOString(),
        };

        yield* dispatchTaskAction(data);
        return { content: `Task ${args.task_id} cancellation requested.` };
      }),
  },
];
