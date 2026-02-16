/**
 * OpenAI Tool Bridge
 * Converts NanoClaw v2 tools (Zod schemas + Effect handlers) to OpenAI function-calling
 * format and routes tool calls back to the appropriate handler.
 */

import { z } from 'zod';
import { Effect, Layer } from 'effect';
import { ALL_TOOLS } from '../tools/index.js';
import type { IpcMcpContext } from '../schemas/IpcContext.js';
import type { ToolResult } from '../schemas/ToolResult.js';
import { HostBridge } from '../services/HostBridge.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/** OpenAI function-calling tool definition */
export interface OpenAIFunctionTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// ─── Schema Conversion ──────────────────────────────────────────────────────

/**
 * Convert all NanoClaw tools to OpenAI function-calling format.
 *
 * Uses Zod v4's built-in `z.toJSONSchema()` for schema conversion.
 * Strips the `$schema` meta key since OpenAI expects plain JSON Schema
 * in the `parameters` field.
 */
export function buildOpenAITools(): OpenAIFunctionTool[] {
  return ALL_TOOLS.map((t) => {
    const jsonSchema = z.toJSONSchema(t.schema) as Record<string, unknown>;

    // Strip $schema meta key -- OpenAI expects plain JSON Schema in parameters
    const { $schema: _, ...parameters } = jsonSchema;

    return {
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters,
      },
    };
  });
}

// ─── Tool Execution ─────────────────────────────────────────────────────────

/**
 * Execute a NanoClaw tool by name and return only the content string.
 */
export async function executeNanoTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: IpcMcpContext,
  bridgeLayer: Layer.Layer<HostBridge>,
): Promise<string> {
  const result = await executeNanoToolFull(toolName, args, ctx, bridgeLayer);
  return result.content;
}

/**
 * Execute a NanoClaw tool and return the full ToolResult (including optional image data).
 * Used by adapters that support vision (OpenAI with image_url content).
 *
 * Runs the Effect-based handler, providing the HostBridge layer.
 */
export async function executeNanoToolFull(
  toolName: string,
  args: Record<string, unknown>,
  ctx: IpcMcpContext,
  bridgeLayer: Layer.Layer<HostBridge>,
): Promise<ToolResult> {
  const normalizedToolName = toolName.trim();
  const tool = ALL_TOOLS.find((t) => t.name === normalizedToolName);
  if (!tool) {
    return { content: JSON.stringify({ error: `Unknown tool: ${toolName}` }), isError: true };
  }

  return Effect.runPromise(
    tool.handler(args, ctx).pipe(
      Effect.provide(bridgeLayer),
      Effect.catchAll((err) =>
        Effect.succeed({
          content: `Tool execution error: ${err.message}`,
          isError: true as const,
        }),
      ),
    ),
  );
}
