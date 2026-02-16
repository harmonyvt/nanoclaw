/**
 * ToolRegistry service — modular tool loading and dispatch.
 */

import { Context, Effect, Layer } from 'effect';
import type { NanoTool } from '../tools/types.js';
import type { ToolResult } from '../schemas/ToolResult.js';
import type { IpcMcpContext } from '../schemas/IpcContext.js';
import { ToolError } from '../errors/index.js';
import type { HostBridge } from './HostBridge.js';
import { ALL_TOOLS } from '../tools/index.js';

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

// ─── Live Layer ─────────────────────────────────────────────────────────────

export const ToolRegistryLive: Layer.Layer<ToolRegistry> = Layer.succeed(
  ToolRegistry,
  (() => {
    const toolMap = new Map<string, NanoTool>(
      ALL_TOOLS.map((t) => [t.name, t]),
    );

    return {
      tools: ALL_TOOLS,
      execute: (name, args, ctx) => {
        const tool = toolMap.get(name);
        if (!tool) {
          return Effect.fail(
            new ToolError({ toolName: name, message: `Unknown tool: ${name}` }),
          );
        }
        return tool.handler(args, ctx);
      },
    };
  })(),
);
