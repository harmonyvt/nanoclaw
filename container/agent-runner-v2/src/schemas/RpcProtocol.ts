/**
 * Effect Schema for the RPC wire protocol (unchanged from v1).
 */

import { Schema } from 'effect';

export const RpcRequestMessage = Schema.Struct({
  type: Schema.Literal('request'),
  id: Schema.String,
  method: Schema.String,
  params: Schema.optional(Schema.Unknown),
});
export type RpcRequestMessage = typeof RpcRequestMessage.Type;

export const RpcResponseMessage = Schema.Struct({
  type: Schema.Literal('response'),
  id: Schema.String,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
});
export type RpcResponseMessage = typeof RpcResponseMessage.Type;

export const RpcEventMessage = Schema.Struct({
  type: Schema.Literal('event'),
  method: Schema.String,
  params: Schema.optional(Schema.Unknown),
});
export type RpcEventMessage = typeof RpcEventMessage.Type;

export const RpcMessage = Schema.Union(
  RpcRequestMessage,
  RpcResponseMessage,
  RpcEventMessage,
);
export type RpcMessage = typeof RpcMessage.Type;
