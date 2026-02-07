/**
 * Claude Agent SDK wrapper for NanoClaw tools.
 * Thin adapter: maps provider-agnostic NANOCLAW_TOOLS into the Claude SDK MCP format.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { NANOCLAW_TOOLS } from './tool-registry.js';
import type { IpcMcpContext } from './types.js';

export type { IpcMcpContext } from './types.js';

export function createIpcMcp(ctx: IpcMcpContext) {
  return createSdkMcpServer({
    name: 'nanoclaw',
    version: '1.0.0',
    tools: [
      ...NANOCLAW_TOOLS.map((t) =>
        tool(
          t.name,
          t.description,
          t.schema.shape,
          async (args: Record<string, unknown>) => {
            const result = await t.handler(args, ctx);
            return {
              content: [{ type: 'text' as const, text: result.content }],
              isError: result.isError,
            };
          },
        ),
      ),

      tool(
        'send_voice',
        `Send a voice message to the current chat using text-to-speech. The text will be synthesized into expressive speech and sent as a Telegram voice message.

EMOTION (optional): Control vocal expression. Format: "emotion" or "emotion:intensity" (e.g. "happy", "sad:2", "whisper:3").
Available emotions:
- Basic: neutral, happy[1-3], sad[1-3], angry[1-4], fear[1-4], surprise[1-2]
- Nuanced: shy[1-3], caring[1-3], jealous[1-3], tsun[1-3], embarrassed, lonely, awkward, protective, relieved[1-2], worried[1-2], anxious, annoyed[1-4], frustrated, disappointed, sarcastic, playful[1-3], proud, pout, cold[1-3], awe
- Special: whisper[1-3], tired[1-2], sleepy, breathy, monotone, firm, mumbling
Higher numbers = stronger intensity. Auto-detected from text if omitted. Keep text under ~500 chars for best quality.`,
        {
          text: z
            .string()
            .describe('The text to speak as a voice message'),
          emotion: z
            .string()
            .optional()
            .describe(
              'Emotion for the voice (e.g. "happy", "sad:2", "whisper:3"). Auto-detected if omitted.',
            ),
        },
        async (args) => {
          const data = {
            type: 'voice',
            chatJid,
            text: args.text,
            emotion: args.emotion || null,
            groupFolder,
            timestamp: new Date().toISOString(),
          };

          const filename = writeIpcFile(MESSAGES_DIR, data);

          return {
            content: [
              {
                type: 'text',
                text: `Voice message queued for delivery (${filename})`,
              },
            ],
          };
        },
      ),

      tool(
        'schedule_task',
        `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE - Choose based on task type:
• "group" (recommended for most tasks): Task runs in the group's conversation context, with access to chat history and memory. Use for tasks that need context about ongoing discussions, user preferences, or previous interactions.
• "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, ask the user. Examples:
- "Remind me about our discussion" → group (needs conversation context)
- "Check the weather every morning" → isolated (self-contained task)
- "Follow up on my request" → group (needs to know what was requested)
- "Generate a daily report" → isolated (just needs instructions in prompt)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
• cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
• interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
• once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
        {
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
        },
        async (args) => {
          // Validate schedule_value before writing IPC
          if (args.schedule_type === 'cron') {
            try {
              CronExpressionParser.parse(args.schedule_value);
            } catch (err) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
                  },
                ],
                isError: true,
              };
            }
          } else if (args.schedule_type === 'interval') {
            const ms = parseInt(args.schedule_value, 10);
            if (isNaN(ms) || ms <= 0) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
                  },
                ],
                isError: true,
              };
            }
          } else if (args.schedule_type === 'once') {
            const date = new Date(args.schedule_value);
            if (isNaN(date.getTime())) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Invalid timestamp: "${args.schedule_value}". Use ISO 8601 format like "2026-02-01T15:30:00.000Z".`,
                  },
                ],
                isError: true,
              };
            }
          }

          // Non-main groups can only schedule for themselves
          const targetGroup =
            isMain && args.target_group ? args.target_group : groupFolder;

          const data = {
            type: 'schedule_task',
            prompt: args.prompt,
            schedule_type: args.schedule_type,
            schedule_value: args.schedule_value,
            context_mode: args.context_mode || 'group',
            groupFolder: targetGroup,
            chatJid,
            createdBy: groupFolder,
            timestamp: new Date().toISOString(),
          };

          const filename = writeIpcFile(TASKS_DIR, data);

          return {
            content: [
              {
                type: 'text',
                text: `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}`,
              },
            ],
          };
        },
      ),

      // Reads from current_tasks.json which host keeps updated
      tool(
        'list_tasks',
        "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
        {},
        async () => {
          const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

          try {
            if (!fs.existsSync(tasksFile)) {
              return {
                content: [
                  {
                    type: 'text',
                    text: 'No scheduled tasks found.',
                  },
                ],
              };
            }

            const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

            const tasks = isMain
              ? allTasks
              : allTasks.filter(
                  (t: { groupFolder: string }) => t.groupFolder === groupFolder,
                );

            if (tasks.length === 0) {
              return {
                content: [
                  {
                    type: 'text',
                    text: 'No scheduled tasks found.',
                  },
                ],
              };
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

            return {
              content: [
                {
                  type: 'text',
                  text: `Scheduled tasks:\n${formatted}`,
                },
              ],
            };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
            };
          }
        },
      ),

      tool(
        'pause_task',
        'Pause a scheduled task. It will not run until resumed.',
        {
          task_id: z.string().describe('The task ID to pause'),
        },
        async (args) => {
          const data = {
            type: 'pause_task',
            taskId: args.task_id,
            groupFolder,
            isMain,
            timestamp: new Date().toISOString(),
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [
              {
                type: 'text',
                text: `Task ${args.task_id} pause requested.`,
              },
            ],
          };
        },
      ),

      tool(
        'resume_task',
        'Resume a paused task.',
        {
          task_id: z.string().describe('The task ID to resume'),
        },
        async (args) => {
          const data = {
            type: 'resume_task',
            taskId: args.task_id,
            groupFolder,
            isMain,
            timestamp: new Date().toISOString(),
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [
              {
                type: 'text',
                text: `Task ${args.task_id} resume requested.`,
              },
            ],
          };
        },
      ),

      tool(
        'cancel_task',
        'Cancel and delete a scheduled task.',
        {
          task_id: z.string().describe('The task ID to cancel'),
        },
        async (args) => {
          const data = {
            type: 'cancel_task',
            taskId: args.task_id,
            groupFolder,
            isMain,
            timestamp: new Date().toISOString(),
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [
              {
                type: 'text',
                text: `Task ${args.task_id} cancellation requested.`,
              },
            ],
          };
        },
      ),

      tool(
        'register_group',
        `Register a new Telegram chat so the agent can respond to messages there. Main group only.

Use available_groups.json to find the chat ID. The folder name should be lowercase with hyphens (e.g., "family-chat").`,
        {
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
        },
        async (args) => {
          if (!isMain) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'Only the main group can register new groups.',
                },
              ],
              isError: true,
            };
          }

          const data = {
            type: 'register_group',
            jid: args.jid,
            name: args.name,
            folder: args.folder,
            trigger: args.trigger,
            timestamp: new Date().toISOString(),
          };

          writeIpcFile(TASKS_DIR, data);

          return {
            content: [
              {
                type: 'text',
                text: `Group "${args.name}" registered. It will start receiving messages immediately.`,
              },
            ],
          };
        },
      ),

      // --- Firecrawl tools (direct API calls, no IPC needed) ---

      tool(
        'firecrawl_scrape',
        'Scrape a single URL and return its content as markdown. Useful for reading web pages, articles, documentation, etc.',
        {
          url: z.string().describe('The URL to scrape'),
          formats: z
            .array(z.string())
            .optional()
            .describe('Output formats (default: ["markdown"])'),
        },
        async (args) => {
          const apiKey = process.env.FIRECRAWL_API_KEY;
          if (!apiKey) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'FIRECRAWL_API_KEY is not set. Ask the admin to configure the Firecrawl API key.',
                },
              ],
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
                url: args.url,
                formats: args.formats ?? ['markdown'],
              }),
            });

            if (res.status === 429) {
              return {
                content: [
                  {
                    type: 'text',
                    text: 'Firecrawl rate limit exceeded. Please wait a moment and try again.',
                  },
                ],
                isError: true,
              };
            }

            if (!res.ok) {
              const body = await res.text();
              return {
                content: [
                  {
                    type: 'text',
                    text: `Firecrawl scrape failed (HTTP ${res.status}): ${body.slice(0, 500)}`,
                  },
                ],
                isError: true,
              };
            }

            const json = (await res.json()) as {
              success: boolean;
              data?: { markdown?: string };
            };
            if (!json.success || !json.data?.markdown) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Firecrawl scrape returned no markdown content. Response: ${JSON.stringify(json).slice(0, 500)}`,
                  },
                ],
                isError: true,
              };
            }

            const MAX_SIZE = 50 * 1024; // 50KB
            let markdown = json.data.markdown;
            if (markdown.length > MAX_SIZE) {
              markdown =
                markdown.slice(0, MAX_SIZE) + '\n\n[Content truncated at 50KB]';
            }

            return {
              content: [{ type: 'text', text: markdown }],
            };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Firecrawl scrape error: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
              isError: true,
            };
          }
        },
      ),

      tool(
        'firecrawl_crawl',
        'Crawl a website starting from a URL, following links up to a depth limit. Returns markdown content for each page found. Useful for indexing documentation sites or exploring a domain.',
        {
          url: z.string().describe('The starting URL to crawl'),
          limit: z
            .number()
            .optional()
            .describe('Max number of pages to crawl (default: 10)'),
          maxDepth: z
            .number()
            .optional()
            .describe('Max link depth to follow (default: 2)'),
        },
        async (args) => {
          const apiKey = process.env.FIRECRAWL_API_KEY;
          if (!apiKey) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'FIRECRAWL_API_KEY is not set. Ask the admin to configure the Firecrawl API key.',
                },
              ],
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
                url: args.url,
                limit: args.limit ?? 10,
                maxDepth: args.maxDepth ?? 2,
              }),
            });

            if (startRes.status === 429) {
              return {
                content: [
                  {
                    type: 'text',
                    text: 'Firecrawl rate limit exceeded. Please wait a moment and try again.',
                  },
                ],
                isError: true,
              };
            }

            if (!startRes.ok) {
              const body = await startRes.text();
              return {
                content: [
                  {
                    type: 'text',
                    text: `Firecrawl crawl failed to start (HTTP ${startRes.status}): ${body.slice(0, 500)}`,
                  },
                ],
                isError: true,
              };
            }

            const startJson = (await startRes.json()) as {
              success: boolean;
              id?: string;
            };
            if (!startJson.success || !startJson.id) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Firecrawl crawl failed to start. Response: ${JSON.stringify(startJson).slice(0, 500)}`,
                  },
                ],
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
                  content: [
                    {
                      type: 'text',
                      text: `Firecrawl crawl poll failed (HTTP ${pollRes.status}): ${body.slice(0, 500)}`,
                    },
                  ],
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
                  content: [
                    {
                      type: 'text',
                      text: `Crawled ${pollJson.data?.length ?? 0} pages:\n\n${output}`,
                    },
                  ],
                };
              }

              if (pollJson.status === 'failed') {
                return {
                  content: [
                    { type: 'text', text: 'Firecrawl crawl job failed.' },
                  ],
                  isError: true,
                };
              }

              // Status is 'scraping' or similar — keep polling
            }

            return {
              content: [
                {
                  type: 'text',
                  text: `Firecrawl crawl timed out after ${TIMEOUT / 1000}s. Job ID: ${jobId}`,
                },
              ],
              isError: true,
            };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Firecrawl crawl error: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
              isError: true,
            };
          }
        },
      ),

      tool(
        'firecrawl_map',
        'Discover all URLs on a website. Returns a list of URLs found on the domain. Useful for understanding site structure before crawling or scraping specific pages.',
        {
          url: z.string().describe('The URL to map'),
        },
        async (args) => {
          const apiKey = process.env.FIRECRAWL_API_KEY;
          if (!apiKey) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'FIRECRAWL_API_KEY is not set. Ask the admin to configure the Firecrawl API key.',
                },
              ],
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
              body: JSON.stringify({ url: args.url }),
            });

            if (res.status === 429) {
              return {
                content: [
                  {
                    type: 'text',
                    text: 'Firecrawl rate limit exceeded. Please wait a moment and try again.',
                  },
                ],
                isError: true,
              };
            }

            if (!res.ok) {
              const body = await res.text();
              return {
                content: [
                  {
                    type: 'text',
                    text: `Firecrawl map failed (HTTP ${res.status}): ${body.slice(0, 500)}`,
                  },
                ],
                isError: true,
              };
            }

            const json = (await res.json()) as {
              success: boolean;
              links?: string[];
            };
            if (!json.success || !json.links) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Firecrawl map returned no links. Response: ${JSON.stringify(json).slice(0, 500)}`,
                  },
                ],
                isError: true,
              };
            }

            return {
              content: [
                {
                  type: 'text',
                  text: `Found ${json.links.length} URLs:\n\n${json.links.join('\n')}`,
                },
              ],
            };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Firecrawl map error: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
              isError: true,
            };
          }
        },
      ),

      // --- Supermemory tools (using official SDK) ---

      tool(
        'memory_save',
        'Save a note, fact, or piece of information to long-term memory (Supermemory). Use this to explicitly remember important context, preferences, or decisions that should persist across conversations.',
        {
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
        },
        async (args) => {
          const resolvedSmKey = resolveSupermemoryApiKey();
          if (!resolvedSmKey) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'No Supermemory API key found. Set SUPERMEMORY_API_KEY (or SUPERMEMORY_OPENCLAW_API_KEY / SUPERMEMORY_CC_API_KEY).',
                },
              ],
              isError: true,
            };
          }

          try {
            const sm = new Supermemory({ apiKey: resolvedSmKey.key });
            await sm.add({
              content: args.content,
              containerTags: [`nanoclaw_${groupFolder}`],
              metadata: {
                type: 'explicit_save',
                ...args.metadata,
              },
            });

            return {
              content: [
                {
                  type: 'text',
                  text: 'Memory saved successfully.',
                },
              ],
            };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Supermemory save error: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
              isError: true,
            };
          }
        },
      ),

      tool(
        'memory_search',
        'Search long-term memory (Supermemory) for relevant past information, conversations, and facts. Use this to recall context from previous conversations or explicitly saved memories.',
        {
          query: z
            .string()
            .describe(
              'Natural language search query describing what you want to recall',
            ),
          limit: z
            .number()
            .optional()
            .describe('Maximum number of results to return (default: 10)'),
        },
        async (args) => {
          const resolvedSmKey = resolveSupermemoryApiKey();
          if (!resolvedSmKey) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'No Supermemory API key found. Set SUPERMEMORY_API_KEY (or SUPERMEMORY_OPENCLAW_API_KEY / SUPERMEMORY_CC_API_KEY).',
                },
              ],
              isError: true,
            };
          }

          try {
            const sm = new Supermemory({ apiKey: resolvedSmKey.key });
            const response = await sm.search.memories({
              q: args.query,
              containerTag: `nanoclaw_${groupFolder}`,
              searchMode: 'hybrid',
              limit: args.limit ?? 10,
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
              return {
                content: [
                  {
                    type: 'text',
                    text: 'No matching memories found.',
                  },
                ],
              };
            }

            const formatted = results
              .map(
                (r: { text: string; similarity: number }, i: number) =>
                  `${i + 1}. [relevance: ${r.similarity.toFixed(2)}] ${r.text}`,
              )
              .join('\n\n');

            return {
              content: [
                {
                  type: 'text',
                  text: `Found ${results.length} memories:\n\n${formatted}`,
                },
              ],
            };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Supermemory search error: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
              isError: true,
            };
          }
        },
      ),

      // --- Browser automation tools (IPC request/response to host) ---

      tool(
        'browse_navigate',
        'Navigate the sandboxed browser/desktop to a URL. Returns a short navigation result.',
        {
          url: z.string().describe('The URL to navigate to'),
        },
        async (args) => {
          const res = await writeBrowseRequest('navigate', { url: args.url });
          if (res.status === 'error') {
            return {
              content: [
                { type: 'text', text: `Navigation failed: ${res.error}` },
              ],
              isError: true,
            };
          }
          return {
            content: [
              { type: 'text', text: `Navigated to page: ${res.result}` },
            ],
          };
        },
      ),

      tool(
        'browse_snapshot',
        'Get an accessibility tree / simplified snapshot of the current page or desktop UI. Useful for understanding visible structure and finding elements to interact with.',
        {},
        async () => {
          const res = await writeBrowseRequest('snapshot', {});
          if (res.status === 'error') {
            return {
              content: [
                { type: 'text', text: `Snapshot failed: ${res.error}` },
              ],
              isError: true,
            };
          }
          return { content: [{ type: 'text', text: String(res.result) }] };
        },
      ),

      tool(
        'browse_click',
        'Click an element by human-readable description text (selector-like hints are best-effort).',
        {
          selector: z
            .string()
            .describe(
              'Description text to click (e.g., "text=Sign In", "Search"); CSS-like selectors are treated as hints',
            ),
        },
        async (args) => {
          const res = await writeBrowseRequest('click', {
            selector: args.selector,
          });
          if (res.status === 'error') {
            return {
              content: [{ type: 'text', text: `Click failed: ${res.error}` }],
              isError: true,
            };
          }
          return {
            content: [{ type: 'text', text: `Click result: ${res.result}` }],
          };
        },
      ),

      tool(
        'browse_fill',
        'Fill a form field with a value. Finds the target element and types the value.',
        {
          selector: z
            .string()
            .describe(
              'Description text of the input field (e.g., "Email", "Search"); CSS-like selectors are treated as hints',
            ),
          value: z.string().describe('The value to type into the field'),
        },
        async (args) => {
          const res = await writeBrowseRequest('fill', {
            selector: args.selector,
            value: args.value,
          });
          if (res.status === 'error') {
            return {
              content: [{ type: 'text', text: `Fill failed: ${res.error}` }],
              isError: true,
            };
          }
          return {
            content: [{ type: 'text', text: `Fill result: ${res.result}` }],
          };
        },
      ),

      tool(
        'browse_scroll',
        'Scroll the current page by delta values. Positive dy scrolls down; negative dy scrolls up.',
        {
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
        },
        async (args) => {
          const res = await writeBrowseRequest('scroll', {
            deltaY: args.dy,
            deltaX: args.dx ?? 0,
          });
          if (res.status === 'error') {
            return {
              content: [{ type: 'text', text: `Scroll failed: ${res.error}` }],
              isError: true,
            };
          }
          return {
            content: [{ type: 'text', text: `Scroll complete: ${res.result}` }],
          };
        },
      ),

      tool(
        'browse_screenshot',
        'Take a screenshot of the current browser page. Returns the saved image path plus labeled UI elements mapped to grid cells. If the text summary is insufficient or elements are missing, use the Read tool on the screenshot file path to visually inspect the image.',
        {},
        async () => {
          const res = await writeBrowseRequest('screenshot', {});
          if (res.status === 'error') {
            return {
              content: [
                { type: 'text', text: `Screenshot failed: ${res.error}` },
              ],
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
            content: [
              {
                type: 'text',
                text: (summary || `Screenshot saved: ${res.result}`) + hint,
              },
            ],
          };
        },
      ),

      tool(
        'browse_wait_for_user',
        'Ask the user to take over the sandbox directly (e.g., to log in), then wait for control to return. Sends a chat message with a takeover web URL (and direct noVNC fallback) plus your instructions.',
        {
          message: z
            .string()
            .describe(
              'Message to send to the user explaining what they need to do in takeover mode (e.g., "Please log in and click Return Control To Agent when done")',
            ),
        },
        async (args) => {
          const res = await writeBrowseRequest(
            'wait_for_user',
            { message: args.message },
            300000,
          );
          if (res.status === 'error') {
            return {
              content: [
                { type: 'text', text: `Wait for user failed: ${res.error}` },
              ],
              isError: true,
            };
          }
          return { content: [{ type: 'text', text: 'User has continued.' }] };
        },
      ),

      tool(
        'browse_go_back',
        'Navigate back in browser history (like clicking the back button).',
        {},
        async () => {
          const res = await writeBrowseRequest('go_back', {});
          if (res.status === 'error') {
            return {
              content: [{ type: 'text', text: `Go back failed: ${res.error}` }],
              isError: true,
            };
          }
          return {
            content: [
              { type: 'text', text: `Navigated back to: ${res.result}` },
            ],
          };
        },
      ),

      tool(
        'browse_evaluate',
        'Execute a JavaScript expression on the current page and return the result. Currently unsupported in CUA sandbox mode and returns an error.',
        {
          expression: z
            .string()
            .describe(
              'JavaScript expression to evaluate (e.g., "document.title", "window.location.href", "document.querySelectorAll(\'a\').length")',
            ),
        },
        async (args) => {
          const res = await writeBrowseRequest('evaluate', {
            expression: args.expression,
          });
          if (res.status === 'error') {
            return {
              content: [
                { type: 'text', text: `Evaluate failed: ${res.error}` },
              ],
              isError: true,
            };
          }
          return { content: [{ type: 'text', text: String(res.result) }] };
        },
      ),

      tool(
        'browse_close',
        'Close the current browser page/tab.',
        {},
        async () => {
          const res = await writeBrowseRequest('close', {});
          if (res.status === 'error') {
            return {
              content: [{ type: 'text', text: `Close failed: ${res.error}` }],
              isError: true,
            };
          }
          return { content: [{ type: 'text', text: 'Browser page closed.' }] };
        },
      ),
    ],
  });
}
