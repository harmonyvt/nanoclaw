/**
 * Effect Schema definitions for IPC message types.
 * These are the JSON payloads written to IPC directories
 * for fire-and-forget communication between container and host.
 */

import { Schema } from 'effect';

export const IpcTextMessage = Schema.Struct({
  type: Schema.Literal('message'),
  chatJid: Schema.String,
  text: Schema.String,
  groupFolder: Schema.String,
  timestamp: Schema.String,
});
export type IpcTextMessage = typeof IpcTextMessage.Type;

export const IpcVoiceMessage = Schema.Struct({
  type: Schema.Literal('voice'),
  chatJid: Schema.String,
  text: Schema.String,
  emotion: Schema.optional(Schema.String),
  groupFolder: Schema.String,
  timestamp: Schema.String,
});
export type IpcVoiceMessage = typeof IpcVoiceMessage.Type;

export const IpcFileMessage = Schema.Struct({
  type: Schema.Literal('file'),
  chatJid: Schema.String,
  filePath: Schema.String,
  caption: Schema.optional(Schema.String),
  groupFolder: Schema.String,
  timestamp: Schema.String,
});
export type IpcFileMessage = typeof IpcFileMessage.Type;

export const IpcTaskMessage = Schema.Struct({
  type: Schema.Literal('schedule_task', 'pause_task', 'resume_task', 'cancel_task'),
  taskId: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  schedule_type: Schema.optional(Schema.String),
  schedule_value: Schema.optional(Schema.String),
  context_mode: Schema.optional(Schema.String),
  groupFolder: Schema.optional(Schema.String),
  chatJid: Schema.optional(Schema.String),
});
export type IpcTaskMessage = typeof IpcTaskMessage.Type;

export const IpcMessage = Schema.Union(
  IpcTextMessage,
  IpcVoiceMessage,
  IpcFileMessage,
  IpcTaskMessage,
);
export type IpcMessage = typeof IpcMessage.Type;

/** Pipeline status events emitted by containers */
export const PipelineEvent = Schema.Struct({
  type: Schema.Literal(
    'thinking',
    'response_delta',
    'tool_start',
    'tool_progress',
    'adapter_stderr',
  ),
  content: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  tool_name: Schema.optional(Schema.String),
  preview: Schema.optional(Schema.String),
  elapsed_seconds: Schema.optional(Schema.Number),
});
export type PipelineEvent = typeof PipelineEvent.Type;
