/**
 * HostBridge service — RPC communication with the host process.
 * Replaces the global activeBridge variable with proper Effect DI.
 *
 * Two Layer variants:
 * - HostBridgePersistent: connects to Unix socket for RPC (Phase 3 full impl)
 * - HostBridgeOneShot: returns null from request() so callers fall back to file IPC
 */

import { Context, Effect, Layer } from 'effect';
import { RpcError } from '../errors/index.js';

// ─── Service Interface ─────────────────────────────────────────────────────

export interface HostBridgeService {
  /** Send a request to the host and await a response */
  readonly request: (
    method: string,
    params?: unknown,
  ) => Effect.Effect<unknown, RpcError>;

  /** Fire-and-forget notification to host (best effort) */
  readonly notify: (
    method: string,
    params?: unknown,
  ) => Effect.Effect<void>;
}

export class HostBridge extends Context.Tag('HostBridge')<
  HostBridge,
  HostBridgeService
>() {}

// ─── Layer Implementations ──────────────────────────────────────────────────

/**
 * Persistent mode fallback: returns null from request(), signaling callers
 * to fall back to file-based IPC.
 *
 * In persistent mode, the actual HostBridge is created by the RPC server
 * (rpc/server.ts) and passed to runQuery as a Layer. This stub is only
 * used if the RPC server hasn't connected yet.
 */
export const HostBridgePersistent: Layer.Layer<HostBridge> = Layer.succeed(
  HostBridge,
  {
    request: (_method: string, _params?: unknown) =>
      Effect.succeed(null as unknown),
    notify: (_method: string, _params?: unknown) =>
      Effect.void,
  },
);

/**
 * One-shot mode: always returns null from request(), signaling callers
 * to fall back to file-based IPC writes.
 */
export const HostBridgeOneShot: Layer.Layer<HostBridge> = Layer.succeed(
  HostBridge,
  {
    request: (_method: string, _params?: unknown) =>
      Effect.succeed(null as unknown),
    notify: (_method: string, _params?: unknown) =>
      Effect.void,
  },
);

/** Null bridge for testing */
export const HostBridgeTest: Layer.Layer<HostBridge> = Layer.succeed(
  HostBridge,
  {
    request: (_method: string, _params?: unknown) =>
      Effect.succeed(null as unknown),
    notify: (_method: string, _params?: unknown) =>
      Effect.void,
  },
);
