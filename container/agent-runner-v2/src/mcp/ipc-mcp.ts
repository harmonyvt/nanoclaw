/**
 * Claude Agent SDK MCP bridge for NanoClaw tools.
 * Thin adapter: maps Effect-based NanoTool[] into the Claude SDK MCP format.
 *
 * The bridge resolves the HostBridge from the provided Layer so that each
 * tool handler runs with proper RPC access.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { Effect, Layer } from 'effect';
import { ALL_TOOLS } from '../tools/index.js';
import { HostBridge } from '../services/HostBridge.js';
import type { IpcMcpContext } from '../schemas/IpcContext.js';

/**
 * Create a Claude SDK MCP server from the v2 tool registry.
 *
 * Each tool handler:
 * 1. Calls the Effect-based NanoTool handler
 * 2. Provides the HostBridge layer so tools can access RPC
 * 3. Runs the resulting Effect to get a Promise<ToolResult>
 * 4. Maps the result into Claude SDK MCP format
 */
export function createIpcMcp(
  ctx: IpcMcpContext,
  bridgeLayer: Layer.Layer<HostBridge>,
) {
  return createSdkMcpServer({
    name: 'nanoclaw',
    version: '2.0.0',
    tools: [
      ...ALL_TOOLS.map((t) =>
        tool(
          t.name,
          t.description,
          t.schema.shape,
          async (args: Record<string, unknown>) => {
            const result = await Effect.runPromise(
              t.handler(args, ctx).pipe(
                Effect.provide(bridgeLayer),
                Effect.catchAll((err) =>
                  Effect.succeed({
                    content: `Tool error: ${err.message}`,
                    isError: true as const,
                  }),
                ),
              ),
            );
            return {
              content: [{ type: 'text' as const, text: result.content }],
              isError: result.isError,
            };
          },
        ),
      ),
    ],
  });
}
