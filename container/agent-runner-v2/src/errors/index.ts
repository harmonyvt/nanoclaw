/**
 * Tagged error types for the container agent runtime.
 */

import { Data } from 'effect';

export class ToolError extends Data.TaggedError('ToolError')<{
  readonly toolName: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class AdapterError extends Data.TaggedError('AdapterError')<{
  readonly provider: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class RpcError extends Data.TaggedError('RpcError')<{
  readonly method: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class CancellationError extends Data.TaggedError('CancellationError')<{
  readonly reason: string;
}> {}

export class ValidationError extends Data.TaggedError('ValidationError')<{
  readonly schemaName: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}
