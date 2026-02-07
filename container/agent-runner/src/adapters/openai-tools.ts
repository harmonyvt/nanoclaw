/**
 * OpenAI Tool Bridge
 * Converts NanoClaw tools (Zod schemas + handlers) to OpenAI function-calling format
 * and routes tool calls back to the appropriate handler.
 */

import { z } from 'zod';
import { NANOCLAW_TOOLS } from '../tool-registry.js';
import type { IpcMcpContext } from '../types.js';

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
  return NANOCLAW_TOOLS.map((t) => {
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
 * Execute a NanoClaw tool by name, routing the call to the registered handler.
 *
 * @param toolName - The tool name from the OpenAI function call
 * @param args - Parsed arguments from the function call
 * @param ctx - IPC context for authorization and routing
 * @returns The tool result as a string (JSON-stringified error on failure)
 */
export async function executeNanoTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: IpcMcpContext,
): Promise<string> {
  const tool = NANOCLAW_TOOLS.find((t) => t.name === toolName);
  if (!tool) {
    return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  }

  try {
    const result = await tool.handler(args, ctx);
    return result.content;
  } catch (err) {
    return `Tool execution error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
