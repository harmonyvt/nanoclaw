/**
 * Effect Schema for container input/output — must match host schemas.
 */

import { Schema } from 'effect';

export const ContainerInput = Schema.Struct({
  prompt: Schema.String,
  groupFolder: Schema.String,
  chatJid: Schema.String,
  isMain: Schema.Boolean,
  isScheduledTask: Schema.optional(Schema.Boolean),
  isSkillInvocation: Schema.optional(Schema.Boolean),
  assistantName: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  baseUrl: Schema.optional(Schema.String),
  enableThinking: Schema.optional(Schema.Boolean),
});
export type ContainerInput = typeof ContainerInput.Type;

export const ContainerOutput = Schema.Struct({
  status: Schema.Literal('success', 'error', 'interrupted'),
  result: Schema.NullOr(Schema.String),
  error: Schema.optional(Schema.String),
});
export type ContainerOutput = typeof ContainerOutput.Type;
