/**
 * HostBridge service — RPC communication with the host process.
 * Replaces the global activeBridge variable with proper Effect DI.
 */

import { Context, Effect, Layer } from 'effect';
import type { RpcError } from '../errors/index.js';

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

// ─── Stub Layers ───────────────────────────────────────────────────────────

/** Persistent mode: backed by Unix socket (implementation in Phase 3) */
export const HostBridgePersistent: Layer.Layer<HostBridge> = Layer.succeed(
  HostBridge,
  {
    request: () => Effect.succeed(null),
    notify: () => Effect.void,
  },
);

/** One-shot mode: falls back to IPC file writes */
export const HostBridgeOneShot: Layer.Layer<HostBridge> = Layer.succeed(
  HostBridge,
  {
    request: () => Effect.succeed(null),
    notify: () => Effect.void,
  },
);

/** Null bridge for testing */
export const HostBridgeTest: Layer.Layer<HostBridge> = Layer.succeed(
  HostBridge,
  {
    request: () => Effect.succeed(null),
    notify: () => Effect.void,
  },
);
