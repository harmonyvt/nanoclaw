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
    tools: NANOCLAW_TOOLS.map((t) =>
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
  });
}
