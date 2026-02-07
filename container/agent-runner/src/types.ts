/**
 * Shared types for the multi-SDK adapter system.
 * Both ClaudeAdapter and OpenAIAdapter implement these contracts.
 */

import { z } from 'zod';

// ─── IPC Context ────────────────────────────────────────────────────────────

/** Context passed to tool handlers for IPC authorization and routing */
export interface IpcMcpContext {
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
}

// ─── Tool Registry ──────────────────────────────────────────────────────────

/** Provider-agnostic tool result */
export interface ToolResult {
  content: string;
  isError?: boolean;
}

/** Provider-agnostic tool definition */
export interface NanoTool {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  handler: (args: Record<string, unknown>, ctx: IpcMcpContext) => Promise<ToolResult>;
}

// ─── Adapter Types ──────────────────────────────────────────────────────────

/** Normalized events emitted by all provider adapters */
export type AgentEvent =
  | { type: 'session_init'; sessionId: string }
  | { type: 'result'; result: string }
  | { type: 'tool_start'; toolName: string; preview: string }
  | { type: 'tool_progress'; toolName: string; elapsedSeconds?: number };

/** Input passed to a provider adapter's run() method */
export interface AdapterInput {
  prompt: string;
  sessionId?: string;
  model?: string;
  groupFolder: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  ipcContext: IpcMcpContext;
}

/** Contract that all provider adapters must implement */
export interface ProviderAdapter {
  run(input: AdapterInput): AsyncGenerator<AgentEvent>;
}

// ─── Container I/O ──────────────────────────────────────────────────────────

/** JSON input sent to the agent container (from host) */
export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  provider?: string;
  model?: string;
}

/** JSON output returned from the agent container (to host) */
export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}
