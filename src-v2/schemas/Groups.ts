/**
 * Effect Schema definitions for group registration and configuration.
 * Wire-compatible with v1 RegisteredGroup from src/types.ts.
 */

import { Schema } from 'effect';

export const ProviderConfig = Schema.Struct({
  provider: Schema.Literal('anthropic', 'openai', 'minimax'),
  model: Schema.optional(Schema.String),
  baseUrl: Schema.optional(Schema.String),
});
export type ProviderConfig = typeof ProviderConfig.Type;

export const AdditionalMount = Schema.Struct({
  hostPath: Schema.String,
  containerPath: Schema.String,
  readonly: Schema.optional(Schema.Boolean),
});
export type AdditionalMount = typeof AdditionalMount.Type;

export const ContainerConfig = Schema.Struct({
  additionalMounts: Schema.optional(Schema.Array(AdditionalMount)),
  timeout: Schema.optional(Schema.Number),
  env: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String }),
  ),
});
export type ContainerConfig = typeof ContainerConfig.Type;

export const RegisteredGroup = Schema.Struct({
  name: Schema.String,
  folder: Schema.String,
  trigger: Schema.String,
  added_at: Schema.String,
  containerConfig: Schema.optional(ContainerConfig),
  providerConfig: Schema.optional(ProviderConfig),
});
export type RegisteredGroup = typeof RegisteredGroup.Type;
