/**
 * Effect Schema for agent events emitted by adapters.
 */

import { Schema } from 'effect';

export const SessionInitEvent = Schema.Struct({
  type: Schema.Literal('session_init'),
  sessionId: Schema.String,
});

export const ResultEvent = Schema.Struct({
  type: Schema.Literal('result'),
  result: Schema.String,
});

export const ResponseDeltaEvent = Schema.Struct({
  type: Schema.Literal('response_delta'),
  content: Schema.String,
});

export const ToolStartEvent = Schema.Struct({
  type: Schema.Literal('tool_start'),
  toolName: Schema.String,
  preview: Schema.String,
});

export const ToolProgressEvent = Schema.Struct({
  type: Schema.Literal('tool_progress'),
  toolName: Schema.String,
  elapsedSeconds: Schema.optional(Schema.Number),
});

export const ThinkingEvent = Schema.Struct({
  type: Schema.Literal('thinking'),
  content: Schema.String,
});

export const AdapterStderrEvent = Schema.Struct({
  type: Schema.Literal('adapter_stderr'),
  message: Schema.String,
});

export const AgentEvent = Schema.Union(
  SessionInitEvent,
  ResultEvent,
  ResponseDeltaEvent,
  ToolStartEvent,
  ToolProgressEvent,
  ThinkingEvent,
  AdapterStderrEvent,
);
export type AgentEvent = typeof AgentEvent.Type;
