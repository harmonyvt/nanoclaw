/**
 * ToolRegistry service — modular tool loading and dispatch.
 */

import { Context, Effect } from 'effect';
import type { NanoTool } from '../tools/types.js';
import type { ToolResult } from '../schemas/ToolResult.js';
import type { IpcMcpContext } from '../schemas/IpcContext.js';
import type { ToolError } from '../errors/index.js';
import type { HostBridge } from './HostBridge.js';

// ─── Service Interface ─────────────────────────────────────────────────────

export interface ToolRegistryService {
  /** All registered tools */
  readonly tools: ReadonlyArray<NanoTool>;

  /** Look up and execute a tool by name */
  readonly execute: (
    name: string,
    args: Record<string, unknown>,
    ctx: IpcMcpContext,
  ) => Effect.Effect<ToolResult, ToolError, HostBridge>;
}

export class ToolRegistry extends Context.Tag('ToolRegistry')<
  ToolRegistry,
  ToolRegistryService
>() {}
