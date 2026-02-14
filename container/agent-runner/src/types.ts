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
  /** Optional base64 image data for vision-capable adapters (e.g. screenshots) */
  imageBase64?: string;
  /** MIME type for the image (default: 'image/png') */
  imageMimeType?: string;
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
  | { type: 'response_delta'; content: string }
  | { type: 'tool_start'; toolName: string; preview: string }
  | { type: 'tool_progress'; toolName: string; elapsedSeconds?: number }
  | { type: 'thinking'; content: string }
  | { type: 'adapter_stderr'; message: string };

/** Input passed to a provider adapter's run() method */
export interface AdapterInput {
  prompt: string;
  model?: string;
  baseUrl?: string;
  groupFolder: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  enableThinking?: boolean;
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
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  isSkillInvocation?: boolean;
  assistantName?: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
  enableThinking?: boolean;
}

/** JSON output returned from the agent container (to host) */
export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  error?: string;
}
