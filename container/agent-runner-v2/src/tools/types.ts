/**
 * NanoTool interface for Effect-based tool handlers.
 * Handlers return Effect instead of Promise. Zod schemas kept for
 * Claude SDK MCP and OpenAI function-calling compatibility.
 */

import { z } from 'zod';
import { Effect } from 'effect';
import type { ToolResult } from '../schemas/ToolResult.js';
import type { IpcMcpContext } from '../schemas/IpcContext.js';
import type { ToolError } from '../errors/index.js';
import type { HostBridge } from '../services/HostBridge.js';

export interface NanoTool {
  readonly name: string;
  readonly description: string;
  /** Zod schema kept for Claude SDK MCP compat and OpenAI function calling */
  readonly schema: z.ZodObject<z.ZodRawShape>;
  /** Handler returns an Effect instead of a raw Promise */
  readonly handler: (
    args: Record<string, unknown>,
    ctx: IpcMcpContext,
  ) => Effect.Effect<ToolResult, ToolError, HostBridge>;
}
