/**
 * Provider-agnostic tool registry for NanoClaw.
 * All tool definitions and handlers live here; adapters wrap them for their SDK.
 */

import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';
import Supermemory from 'supermemory';
import type { NanoTool, IpcMcpContext, ToolResult } from './types.js';

// ─── IPC Constants ──────────────────────────────────────────────────────────

export const IPC_DIR = '/workspace/ipc';
export const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
export const TASKS_DIR = path.join(IPC_DIR, 'tasks');
export const BROWSE_DIR = path.join(IPC_DIR, 'browse');
export const SUPERMEMORY_KEY_ENV_VARS = [
  'SUPERMEMORY_API_KEY',
  'SUPERMEMORY_OPENCLAW_API_KEY',
  'SUPERMEMORY_CC_API_KEY',
] as const;

// ─── Helpers ────────────────────────────────────────────────────────────────

export function resolveSupermemoryApiKey(): {
  key: string;
  envVar: (typeof SUPERMEMORY_KEY_ENV_VARS)[number];
} | null {
  for (const envVar of SUPERMEMORY_KEY_ENV_VARS) {
    const raw = process.env[envVar];
    if (typeof raw !== 'string') continue;
    const key = raw.trim();
    if (!key) continue;
    return { key, envVar };
  }
  return null;
}

export function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

export async function writeBrowseRequest(
  action: string,
  params: Record<string, unknown>,
  timeoutMs = 60000,
): Promise<{
  status: string;
  result?: unknown;
  error?: string;
  analysis?: { summary?: string; metadataPath?: string };
}> {
  fs.mkdirSync(BROWSE_DIR, { recursive: true });

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const reqFile = path.join(BROWSE_DIR, `req-${id}.json`);
  const resFile = path.join(BROWSE_DIR, `res-${id}.json`);

  // Atomic write request
  const tempReq = `${reqFile}.tmp`;
  fs.writeFileSync(tempReq, JSON.stringify({ id, action, params }));
  fs.renameSync(tempReq, reqFile);

  // Poll for response
  const pollInterval = 500;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
    if (fs.existsSync(resFile)) {
      const data = JSON.parse(fs.readFileSync(resFile, 'utf-8'));
      // Clean up both files
      try {
        fs.unlinkSync(reqFile);
      } catch {}
      try {
        fs.unlinkSync(resFile);
      } catch {}
      return data;
    }
  }

  // Timeout - clean up request file
  try {
    fs.unlinkSync(reqFile);
  } catch {}
  return {
    status: 'error',
    error: `Browse request timed out after ${timeoutMs / 1000}s`,
  };
}

// ─── Tool Definitions ───────────────────────────────────────────────────────

export const NANOCLAW_TOOLS: NanoTool[] = [
  // ── Communication ───────────────────────────────────────────────────────

  {
    name: 'send_message',
    description:
      'Send a message to the current chat. Use this to proactively share information or updates.',
    schema: z.object({
      text: z.string().describe('The message text to send'),
    }),
    handler: async (args, ctx): Promise<ToolResult> => {
      const data = {
        type: 'message',
        chatJid: ctx.chatJid,
        text: args.text as string,
        groupFolder: ctx.groupFolder,
        timestamp: new Date().toISOString(),
      };

      const filename = writeIpcFile(MESSAGES_DIR, data);

      return { content: `Message queued for delivery (${filename})` };
    },
  },

  {
    name: 'send_file',
    description:
      'Send a file/document to the current chat via Telegram. Use this to share downloaded files, generated documents, or any file accessible to the agent.',
    schema: z.object({
      path: z
        .string()
        .describe(
          'Absolute path to the file inside the container (e.g., "/workspace/group/media/report.pdf")',
        ),
      caption: z
        .string()
        .optional()
        .describe('Optional caption to send with the file'),
    }),
    handler: async (args, ctx): Promise<ToolResult> => {
      const filePath = args.path as string;

      if (!fs.existsSync(filePath)) {
        return {
          content: `File not found: ${filePath}`,
          isError: true,
        };
      }

      const data = {
        type: 'file',
        chatJid: ctx.chatJid,
        filePath,
        caption: (args.caption as string) || null,
        groupFolder: ctx.groupFolder,
        timestamp: new Date().toISOString(),
      };

      const filename = writeIpcFile(MESSAGES_DIR, data);

      return { content: `File queued for delivery (${filename}): ${filePath}` };
    },
  },

  // ── Task Scheduling ─────────────────────────────────────────────────────

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
    handler: async (args, ctx): Promise<ToolResult> => {
      const scheduleType = args.schedule_type as string;
      const scheduleValue = args.schedule_value as string;

      // Validate schedule_value before writing IPC
      if (scheduleType === 'cron') {
        try {
          CronExpressionParser.parse(scheduleValue);
        } catch (_err) {
          return {
            content: `Invalid cron: "${scheduleValue}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
            isError: true,
          };
        }
      } else if (scheduleType === 'interval') {
        const ms = parseInt(scheduleValue, 10);
        if (isNaN(ms) || ms <= 0) {
          return {
            content: `Invalid interval: "${scheduleValue}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
            isError: true,
          };
        }
      } else if (scheduleType === 'once') {
        const date = new Date(scheduleValue);
        if (isNaN(date.getTime())) {
          return {
            content: `Invalid timestamp: "${scheduleValue}". Use ISO 8601 format like "2026-02-01T15:30:00.000Z".`,
            isError: true,
          };
        }
      }

      // Non-main groups can only schedule for themselves
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

      const filename = writeIpcFile(TASKS_DIR, data);

      return {
        content: `Task scheduled (${filename}): ${scheduleType} - ${scheduleValue}`,
      };
    },
  },

  {
    name: 'list_tasks',
    description:
      "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
    schema: z.object({}),
    handler: async (_args, ctx): Promise<ToolResult> => {
      const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

      try {
        if (!fs.existsSync(tasksFile)) {
          return { content: 'No scheduled tasks found.' };
        }

        const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

        const tasks = ctx.isMain
          ? allTasks
          : allTasks.filter(
              (t: { groupFolder: string }) =>
                t.groupFolder === ctx.groupFolder,
            );

        if (tasks.length === 0) {
          return { content: 'No scheduled tasks found.' };
        }

        const formatted = tasks
          .map(
            (t: {
              id: string;
              prompt: string;
              schedule_type: string;
              schedule_value: string;
              status: string;
              next_run: string;
            }) =>
              `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
          )
          .join('\n');

        return { content: `Scheduled tasks:\n${formatted}` };
      } catch (err) {
        return {
          content: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  },

  {
    name: 'pause_task',
    description: 'Pause a scheduled task. It will not run until resumed.',
    schema: z.object({
      task_id: z.string().describe('The task ID to pause'),
    }),
    handler: async (args, ctx): Promise<ToolResult> => {
      const data = {
        type: 'pause_task',
        taskId: args.task_id as string,
        groupFolder: ctx.groupFolder,
        isMain: ctx.isMain,
        timestamp: new Date().toISOString(),
      };

      writeIpcFile(TASKS_DIR, data);

      return { content: `Task ${args.task_id} pause requested.` };
    },
  },

  {
    name: 'resume_task',
    description: 'Resume a paused task.',
    schema: z.object({
      task_id: z.string().describe('The task ID to resume'),
    }),
    handler: async (args, ctx): Promise<ToolResult> => {
      const data = {
        type: 'resume_task',
        taskId: args.task_id as string,
        groupFolder: ctx.groupFolder,
        isMain: ctx.isMain,
        timestamp: new Date().toISOString(),
      };

      writeIpcFile(TASKS_DIR, data);

      return { content: `Task ${args.task_id} resume requested.` };
    },
  },

  {
    name: 'cancel_task',
    description: 'Cancel and delete a scheduled task.',
    schema: z.object({
      task_id: z.string().describe('The task ID to cancel'),
    }),
    handler: async (args, ctx): Promise<ToolResult> => {
      const data = {
        type: 'cancel_task',
        taskId: args.task_id as string,
        groupFolder: ctx.groupFolder,
        isMain: ctx.isMain,
        timestamp: new Date().toISOString(),
      };

      writeIpcFile(TASKS_DIR, data);

      return { content: `Task ${args.task_id} cancellation requested.` };
    },
  },

  // ── Group Management ────────────────────────────────────────────────────

  {
    name: 'register_group',
    description: `Register a new Telegram chat so the agent can respond to messages there. Main group only.

Use available_groups.json to find the chat ID. The folder name should be lowercase with hyphens (e.g., "family-chat").`,
    schema: z.object({
      jid: z
        .string()
        .describe('The chat identifier (e.g., "tg:-1001234567890")'),
      name: z.string().describe('Display name for the group'),
      folder: z
        .string()
        .describe(
          'Folder name for group files (lowercase, hyphens, e.g., "family-chat")',
        ),
      trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
      provider: z
        .string()
        .optional()
        .describe(
          'AI provider for this group (e.g., "claude", "openai"). Defaults to the system default.',
        ),
      model: z
        .string()
        .optional()
        .describe(
          'Model to use for this group (e.g., "gpt-4o", "claude-sonnet-4-20250514"). Defaults to the provider default.',
        ),
    }),
    handler: async (args, ctx): Promise<ToolResult> => {
      if (!ctx.isMain) {
        return {
          content: 'Only the main group can register new groups.',
          isError: true,
        };
      }

      const data: Record<string, unknown> = {
        type: 'register_group',
        jid: args.jid as string,
        name: args.name as string,
        folder: args.folder as string,
        trigger: args.trigger as string,
        timestamp: new Date().toISOString(),
      };

      // Include provider config if specified
      if (args.provider || args.model) {
        data.providerConfig = {
          ...(args.provider ? { provider: args.provider as string } : {}),
          ...(args.model ? { model: args.model as string } : {}),
        };
      }

      writeIpcFile(TASKS_DIR, data);

      return {
        content: `Group "${args.name}" registered. It will start receiving messages immediately.`,
      };
    },
  },

  // ── Firecrawl (direct API, no IPC) ──────────────────────────────────────

  {
    name: 'firecrawl_scrape',
    description:
      'Scrape a single URL and return its content as markdown. Useful for reading web pages, articles, documentation, etc.',
    schema: z.object({
      url: z.string().describe('The URL to scrape'),
      formats: z
        .array(z.string())
        .optional()
        .describe('Output formats (default: ["markdown"])'),
    }),
    handler: async (args): Promise<ToolResult> => {
      const apiKey = process.env.FIRECRAWL_API_KEY;
      if (!apiKey) {
        return {
          content:
            'FIRECRAWL_API_KEY is not set. Ask the admin to configure the Firecrawl API key.',
          isError: true,
        };
      }

      try {
        const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            url: args.url as string,
            formats: (args.formats as string[] | undefined) ?? ['markdown'],
          }),
        });

        if (res.status === 429) {
          return {
            content:
              'Firecrawl rate limit exceeded. Please wait a moment and try again.',
            isError: true,
          };
        }

        if (!res.ok) {
          const body = await res.text();
          return {
            content: `Firecrawl scrape failed (HTTP ${res.status}): ${body.slice(0, 500)}`,
            isError: true,
          };
        }

        const json = (await res.json()) as {
          success: boolean;
          data?: { markdown?: string };
        };
        if (!json.success || !json.data?.markdown) {
          return {
            content: `Firecrawl scrape returned no markdown content. Response: ${JSON.stringify(json).slice(0, 500)}`,
            isError: true,
          };
        }

        const MAX_SIZE = 50 * 1024; // 50KB
        let markdown = json.data.markdown;
        if (markdown.length > MAX_SIZE) {
          markdown =
            markdown.slice(0, MAX_SIZE) + '\n\n[Content truncated at 50KB]';
        }

        return { content: markdown };
      } catch (err) {
        return {
          content: `Firecrawl scrape error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  },

  {
    name: 'firecrawl_crawl',
    description:
      'Crawl a website starting from a URL, following links up to a depth limit. Returns markdown content for each page found. Useful for indexing documentation sites or exploring a domain.',
    schema: z.object({
      url: z.string().describe('The starting URL to crawl'),
      limit: z
        .number()
        .optional()
        .describe('Max number of pages to crawl (default: 10)'),
      maxDepth: z
        .number()
        .optional()
        .describe('Max link depth to follow (default: 2)'),
    }),
    handler: async (args): Promise<ToolResult> => {
      const apiKey = process.env.FIRECRAWL_API_KEY;
      if (!apiKey) {
        return {
          content:
            'FIRECRAWL_API_KEY is not set. Ask the admin to configure the Firecrawl API key.',
          isError: true,
        };
      }

      try {
        // Start the crawl job
        const startRes = await fetch('https://api.firecrawl.dev/v1/crawl', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            url: args.url as string,
            limit: (args.limit as number | undefined) ?? 10,
            maxDepth: (args.maxDepth as number | undefined) ?? 2,
          }),
        });

        if (startRes.status === 429) {
          return {
            content:
              'Firecrawl rate limit exceeded. Please wait a moment and try again.',
            isError: true,
          };
        }

        if (!startRes.ok) {
          const body = await startRes.text();
          return {
            content: `Firecrawl crawl failed to start (HTTP ${startRes.status}): ${body.slice(0, 500)}`,
            isError: true,
          };
        }

        const startJson = (await startRes.json()) as {
          success: boolean;
          id?: string;
        };
        if (!startJson.success || !startJson.id) {
          return {
            content: `Firecrawl crawl failed to start. Response: ${JSON.stringify(startJson).slice(0, 500)}`,
            isError: true,
          };
        }

        const jobId = startJson.id;
        const POLL_INTERVAL = 5000;
        const TIMEOUT = 120_000;
        const startTime = Date.now();

        // Poll for completion
        while (Date.now() - startTime < TIMEOUT) {
          await new Promise((resolve) =>
            setTimeout(resolve, POLL_INTERVAL),
          );

          const pollRes = await fetch(
            `https://api.firecrawl.dev/v1/crawl/${jobId}`,
            {
              headers: { Authorization: `Bearer ${apiKey}` },
            },
          );

          if (pollRes.status === 429) {
            // Wait longer on rate limit during polling
            await new Promise((resolve) =>
              setTimeout(resolve, POLL_INTERVAL),
            );
            continue;
          }

          if (!pollRes.ok) {
            const body = await pollRes.text();
            return {
              content: `Firecrawl crawl poll failed (HTTP ${pollRes.status}): ${body.slice(0, 500)}`,
              isError: true,
            };
          }

          const pollJson = (await pollRes.json()) as {
            status: string;
            data?: Array<{
              metadata?: { sourceURL?: string };
              markdown?: string;
            }>;
          };

          if (pollJson.status === 'completed') {
            const results = (pollJson.data ?? []).map((page) => ({
              url: page.metadata?.sourceURL ?? 'unknown',
              markdown: page.markdown ?? '',
            }));

            const MAX_SIZE = 100 * 1024; // 100KB
            let output = JSON.stringify(results, null, 2);
            if (output.length > MAX_SIZE) {
              // Truncate by removing pages from the end until under limit
              while (output.length > MAX_SIZE && results.length > 1) {
                results.pop();
                output = JSON.stringify(results, null, 2);
              }
              if (output.length > MAX_SIZE) {
                output =
                  output.slice(0, MAX_SIZE) +
                  '\n\n[Content truncated at 100KB]';
              }
            }

            return {
              content: `Crawled ${pollJson.data?.length ?? 0} pages:\n\n${output}`,
            };
          }

          if (pollJson.status === 'failed') {
            return {
              content: 'Firecrawl crawl job failed.',
              isError: true,
            };
          }

          // Status is 'scraping' or similar -- keep polling
        }

        return {
          content: `Firecrawl crawl timed out after ${TIMEOUT / 1000}s. Job ID: ${jobId}`,
          isError: true,
        };
      } catch (err) {
        return {
          content: `Firecrawl crawl error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  },

  {
    name: 'firecrawl_map',
    description:
      'Discover all URLs on a website. Returns a list of URLs found on the domain. Useful for understanding site structure before crawling or scraping specific pages.',
    schema: z.object({
      url: z.string().describe('The URL to map'),
    }),
    handler: async (args): Promise<ToolResult> => {
      const apiKey = process.env.FIRECRAWL_API_KEY;
      if (!apiKey) {
        return {
          content:
            'FIRECRAWL_API_KEY is not set. Ask the admin to configure the Firecrawl API key.',
          isError: true,
        };
      }

      try {
        const res = await fetch('https://api.firecrawl.dev/v1/map', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ url: args.url as string }),
        });

        if (res.status === 429) {
          return {
            content:
              'Firecrawl rate limit exceeded. Please wait a moment and try again.',
            isError: true,
          };
        }

        if (!res.ok) {
          const body = await res.text();
          return {
            content: `Firecrawl map failed (HTTP ${res.status}): ${body.slice(0, 500)}`,
            isError: true,
          };
        }

        const json = (await res.json()) as {
          success: boolean;
          links?: string[];
        };
        if (!json.success || !json.links) {
          return {
            content: `Firecrawl map returned no links. Response: ${JSON.stringify(json).slice(0, 500)}`,
            isError: true,
          };
        }

        return {
          content: `Found ${json.links.length} URLs:\n\n${json.links.join('\n')}`,
        };
      } catch (err) {
        return {
          content: `Firecrawl map error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  },

  // ── Supermemory (direct API via SDK) ────────────────────────────────────

  {
    name: 'memory_save',
    description:
      'Save a note, fact, or piece of information to long-term memory (Supermemory). Use this to explicitly remember important context, preferences, or decisions that should persist across conversations.',
    schema: z.object({
      content: z
        .string()
        .describe(
          'The text content to save to memory. Can be a fact, note, summary, or any information worth remembering.',
        ),
      metadata: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          'Optional key-value metadata (e.g., {"category": "preference", "topic": "coding"})',
        ),
    }),
    handler: async (args, ctx): Promise<ToolResult> => {
      const resolvedSmKey = resolveSupermemoryApiKey();
      if (!resolvedSmKey) {
        return {
          content:
            'No Supermemory API key found. Set SUPERMEMORY_API_KEY (or SUPERMEMORY_OPENCLAW_API_KEY / SUPERMEMORY_CC_API_KEY).',
          isError: true,
        };
      }

      try {
        const sm = new Supermemory({ apiKey: resolvedSmKey.key });
        await sm.add({
          content: args.content as string,
          containerTags: [`nanoclaw_${ctx.groupFolder}`],
          metadata: {
            type: 'explicit_save',
            ...(args.metadata as Record<string, string> | undefined),
          },
        });

        return { content: 'Memory saved successfully.' };
      } catch (err) {
        return {
          content: `Supermemory save error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  },

  {
    name: 'memory_search',
    description:
      'Search long-term memory (Supermemory) for relevant past information, conversations, and facts. Use this to recall context from previous conversations or explicitly saved memories.',
    schema: z.object({
      query: z
        .string()
        .describe(
          'Natural language search query describing what you want to recall',
        ),
      limit: z
        .number()
        .optional()
        .describe('Maximum number of results to return (default: 10)'),
    }),
    handler: async (args, ctx): Promise<ToolResult> => {
      const resolvedSmKey = resolveSupermemoryApiKey();
      if (!resolvedSmKey) {
        return {
          content:
            'No Supermemory API key found. Set SUPERMEMORY_API_KEY (or SUPERMEMORY_OPENCLAW_API_KEY / SUPERMEMORY_CC_API_KEY).',
          isError: true,
        };
      }

      try {
        const sm = new Supermemory({ apiKey: resolvedSmKey.key });
        const response = await sm.search.memories({
          q: args.query as string,
          containerTag: `nanoclaw_${ctx.groupFolder}`,
          searchMode: 'hybrid',
          limit: (args.limit as number | undefined) ?? 10,
        });

        const results = (response.results || [])
          .map(
            (r: {
              memory?: string;
              chunk?: string;
              similarity?: number;
            }) => ({
              text: r.memory || r.chunk || '',
              similarity: r.similarity ?? 0,
            }),
          )
          .filter((r: { text: string }) => r.text.trim());

        if (results.length === 0) {
          return { content: 'No matching memories found.' };
        }

        const formatted = results
          .map(
            (r: { text: string; similarity: number }, i: number) =>
              `${i + 1}. [relevance: ${r.similarity.toFixed(2)}] ${r.text}`,
          )
          .join('\n\n');

        return {
          content: `Found ${results.length} memories:\n\n${formatted}`,
        };
      } catch (err) {
        return {
          content: `Supermemory search error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  },

  // ── Browser Automation (IPC request/response to host) ───────────────────

  {
    name: 'browse_navigate',
    description:
      'Navigate the sandboxed browser/desktop to a URL. Returns a short navigation result.',
    schema: z.object({
      url: z.string().describe('The URL to navigate to'),
    }),
    handler: async (args): Promise<ToolResult> => {
      const res = await writeBrowseRequest('navigate', {
        url: args.url as string,
      });
      if (res.status === 'error') {
        return {
          content: `Navigation failed: ${res.error}`,
          isError: true,
        };
      }
      return { content: `Navigated to page: ${res.result}` };
    },
  },

  {
    name: 'browse_snapshot',
    description:
      'Get an accessibility tree / simplified snapshot of the current page or desktop UI. Useful for understanding visible structure and finding elements to interact with.',
    schema: z.object({}),
    handler: async (): Promise<ToolResult> => {
      const res = await writeBrowseRequest('snapshot', {});
      if (res.status === 'error') {
        return {
          content: `Snapshot failed: ${res.error}`,
          isError: true,
        };
      }
      return { content: String(res.result) };
    },
  },

  {
    name: 'browse_click',
    description:
      'Click an element by human-readable description text (selector-like hints are best-effort).',
    schema: z.object({
      selector: z
        .string()
        .describe(
          'Description text to click (e.g., "text=Sign In", "Search"); CSS-like selectors are treated as hints',
        ),
    }),
    handler: async (args): Promise<ToolResult> => {
      const res = await writeBrowseRequest('click', {
        selector: args.selector as string,
      });
      if (res.status === 'error') {
        return {
          content: `Click failed: ${res.error}`,
          isError: true,
        };
      }
      return { content: `Click result: ${res.result}` };
    },
  },

  {
    name: 'browse_click_xy',
    description:
      'Click at exact pixel coordinates on the screen. Use this when browse_click fails to find an element, or when you know the coordinates from a screenshot analysis or visual inspection.',
    schema: z.object({
      x: z.number().int().describe('X coordinate in pixels from left edge of screen'),
      y: z.number().int().describe('Y coordinate in pixels from top edge of screen'),
    }),
    handler: async (args): Promise<ToolResult> => {
      const res = await writeBrowseRequest('click_xy', {
        x: args.x as number,
        y: args.y as number,
      });
      if (res.status === 'error') {
        return {
          content: `Click at (${args.x}, ${args.y}) failed: ${res.error}`,
          isError: true,
        };
      }
      return { content: `Click result: ${res.result}` };
    },
  },

  {
    name: 'browse_type_at_xy',
    description:
      'Click at exact pixel coordinates then type text. Use when browse_fill fails to find the input field. Clicks the coordinates first, then types the value.',
    schema: z.object({
      x: z.number().int().describe('X coordinate of the input field in pixels'),
      y: z.number().int().describe('Y coordinate of the input field in pixels'),
      value: z.string().describe('The text to type into the field'),
    }),
    handler: async (args): Promise<ToolResult> => {
      const res = await writeBrowseRequest('type_at_xy', {
        x: args.x as number,
        y: args.y as number,
        value: args.value as string,
      });
      if (res.status === 'error') {
        return {
          content: `Type at (${args.x}, ${args.y}) failed: ${res.error}`,
          isError: true,
        };
      }
      return { content: `Type result: ${res.result}` };
    },
  },

  {
    name: 'browse_fill',
    description:
      'Fill a form field with a value. Finds the target element and types the value.',
    schema: z.object({
      selector: z
        .string()
        .describe(
          'Description text of the input field (e.g., "Email", "Search"); CSS-like selectors are treated as hints',
        ),
      value: z.string().describe('The value to type into the field'),
    }),
    handler: async (args): Promise<ToolResult> => {
      const res = await writeBrowseRequest('fill', {
        selector: args.selector as string,
        value: args.value as string,
      });
      if (res.status === 'error') {
        return {
          content: `Fill failed: ${res.error}`,
          isError: true,
        };
      }
      return { content: `Fill result: ${res.result}` };
    },
  },

  {
    name: 'browse_scroll',
    description:
      'Scroll the current page by delta values. Positive dy scrolls down; negative dy scrolls up.',
    schema: z.object({
      dy: z
        .number()
        .int()
        .describe('Vertical scroll delta. Positive=down, negative=up'),
      dx: z
        .number()
        .int()
        .optional()
        .describe(
          'Optional horizontal scroll delta. Positive=right, negative=left',
        ),
    }),
    handler: async (args): Promise<ToolResult> => {
      const res = await writeBrowseRequest('scroll', {
        deltaY: args.dy as number,
        deltaX: (args.dx as number | undefined) ?? 0,
      });
      if (res.status === 'error') {
        return {
          content: `Scroll failed: ${res.error}`,
          isError: true,
        };
      }
      return { content: `Scroll complete: ${res.result}` };
    },
  },

  {
    name: 'browse_screenshot',
    description:
      'Take a screenshot of the current browser page. Returns the saved image path plus labeled UI elements mapped to grid cells. If the text summary is insufficient or elements are missing, use the Read tool on the screenshot file path to visually inspect the image.',
    schema: z.object({}),
    handler: async (): Promise<ToolResult> => {
      const res = await writeBrowseRequest('screenshot', {});
      if (res.status === 'error') {
        return {
          content: `Screenshot failed: ${res.error}`,
          isError: true,
        };
      }
      const summary =
        res.analysis && typeof res.analysis.summary === 'string'
          ? res.analysis.summary
          : null;
      const screenshotPath = typeof res.result === 'string' ? res.result : '';
      const hint = screenshotPath
        ? `\n\nTo visually inspect this screenshot, use the Read tool on: ${screenshotPath}`
        : '';
      return {
        content: (summary || `Screenshot saved: ${res.result}`) + hint,
      };
    },
  },

  {
    name: 'browse_wait_for_user',
    description:
      'Ask the user to take over the sandbox directly (e.g., to log in), then wait for control to return. Sends a chat message with a takeover web URL (and direct noVNC fallback) plus your instructions.',
    schema: z.object({
      message: z
        .string()
        .describe(
          'Message to send to the user explaining what they need to do in takeover mode (e.g., "Please log in and click Return Control To Agent when done")',
        ),
    }),
    handler: async (args): Promise<ToolResult> => {
      const res = await writeBrowseRequest(
        'wait_for_user',
        { message: args.message as string },
        300000,
      );
      if (res.status === 'error') {
        return {
          content: `Wait for user failed: ${res.error}`,
          isError: true,
        };
      }
      return { content: 'User has continued.' };
    },
  },

  {
    name: 'browse_go_back',
    description:
      'Navigate back in browser history (like clicking the back button).',
    schema: z.object({}),
    handler: async (): Promise<ToolResult> => {
      const res = await writeBrowseRequest('go_back', {});
      if (res.status === 'error') {
        return {
          content: `Go back failed: ${res.error}`,
          isError: true,
        };
      }
      return { content: `Navigated back to: ${res.result}` };
    },
  },

  {
    name: 'browse_evaluate',
    description:
      'Execute a JavaScript expression on the current page and return the result. Currently unsupported in CUA sandbox mode and returns an error.',
    schema: z.object({
      expression: z
        .string()
        .describe(
          'JavaScript expression to evaluate (e.g., "document.title", "window.location.href", "document.querySelectorAll(\'a\').length")',
        ),
    }),
    handler: async (args): Promise<ToolResult> => {
      const res = await writeBrowseRequest('evaluate', {
        expression: args.expression as string,
      });
      if (res.status === 'error') {
        return {
          content: `Evaluate failed: ${res.error}`,
          isError: true,
        };
      }
      return { content: String(res.result) };
    },
  },

  {
    name: 'browse_close',
    description: 'Close the current browser page/tab.',
    schema: z.object({}),
    handler: async (): Promise<ToolResult> => {
      const res = await writeBrowseRequest('close', {});
      if (res.status === 'error') {
        return {
          content: `Close failed: ${res.error}`,
          isError: true,
        };
      }
      return { content: 'Browser page closed.' };
    },
  },

  {
    name: 'browse_extract_file',
    description:
      'Extract/download a file from the CUA sandbox desktop to the agent. Returns the local file path which can then be sent to the user via send_file. Useful for downloading files the browser saved, exporting documents, etc.',
    schema: z.object({
      path: z
        .string()
        .describe(
          'Absolute path to the file inside the CUA sandbox (e.g., "/root/Downloads/report.pdf", "~/Documents/data.csv")',
        ),
    }),
    handler: async (args): Promise<ToolResult> => {
      const res = await writeBrowseRequest(
        'extract_file',
        { path: args.path as string },
        120000,
      );
      if (res.status === 'error') {
        return {
          content: `File extraction failed: ${res.error}`,
          isError: true,
        };
      }
      return {
        content: `File extracted to: ${res.result}`,
      };
    },
  },

  {
    name: 'browse_upload_file',
    description:
      'Upload a file from the agent into the CUA sandbox desktop. Useful for making files received from Telegram available in the browser environment (e.g., uploading a document to a web form).',
    schema: z.object({
      source_path: z
        .string()
        .describe(
          'Path to the file inside the agent container (e.g., "/workspace/group/media/document.pdf")',
        ),
      destination_path: z
        .string()
        .optional()
        .describe(
          'Destination path inside the CUA sandbox (default: ~/Downloads/{filename})',
        ),
    }),
    handler: async (args): Promise<ToolResult> => {
      const res = await writeBrowseRequest(
        'upload_file',
        {
          source_path: args.source_path as string,
          destination_path: (args.destination_path as string) || null,
        },
        120000,
      );
      if (res.status === 'error') {
        return {
          content: `File upload failed: ${res.error}`,
          isError: true,
        };
      }
      return {
        content: `File uploaded: ${res.result}`,
      };
    },
  },
];
