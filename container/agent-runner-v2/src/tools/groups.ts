/**
 * Group management tools: register_group.
 */

import { z } from 'zod';
import { Effect } from 'effect';
import type { NanoTool } from './types.js';
import type { HostBridge } from '../services/HostBridge.js';
import type { ToolError } from '../errors/index.js';
import { requestHost, writeIpcFile, TASKS_DIR } from './utils.js';

/** Try RPC first, fall back to file IPC for task-like dispatch. */
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

export const groupTools: NanoTool[] = [
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
      base_url: z
        .string()
        .optional()
        .describe(
          'Custom API base URL for this group (e.g., "https://my-proxy.example.com/v1"). Defaults to the provider\'s standard endpoint.',
        ),
    }),
    handler: (args, ctx) =>
      Effect.gen(function* () {
        if (!ctx.isMain) {
          return {
            content: 'Only the main group can register new groups.',
            isError: true as const,
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

        if (args.provider || args.model || args.base_url) {
          data.providerConfig = {
            ...(args.provider ? { provider: args.provider as string } : {}),
            ...(args.model ? { model: args.model as string } : {}),
            ...(args.base_url ? { baseUrl: args.base_url as string } : {}),
          };
        }

        yield* dispatchTaskAction(data);

        return {
          content: `Group "${args.name}" registered. It will start receiving messages immediately.`,
        };
      }),
  },
];
