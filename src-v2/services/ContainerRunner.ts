/**
 * ContainerRunner service — manages agent container lifecycle.
 * Supports persistent (Unix socket RPC) and one-shot (stdin/stdout) modes.
 */

import { Context, Effect, Scope } from 'effect';
import type { ContainerInput, ContainerOutput } from '../schemas/ContainerIO.js';
import type {
  ContainerError,
  ContainerTimeoutError,
  ContainerInterruptedError,
} from '../errors.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface HostRpcRequest {
  readonly method: string;
  readonly params?: unknown;
}

export interface HostRpcEvent {
  readonly method: string;
  readonly params?: unknown;
}

export interface HostRpcHandlers {
  readonly onRequest?: (req: HostRpcRequest) => Promise<unknown>;
  readonly onEvent?: (evt: HostRpcEvent) => Promise<void> | void;
}

export type InterruptResult =
  | { readonly interrupted: true }
  | { readonly interrupted: false; readonly reason: string };

// ─── Service Interface ─────────────────────────────────────────────────────

export interface ContainerRunnerService {
  /** Run an agent query. Container lifecycle is scoped — auto-cleaned on interruption. */
  readonly runAgent: (
    input: ContainerInput,
    handlers: HostRpcHandlers,
  ) => Effect.Effect<
    ContainerOutput,
    ContainerError | ContainerTimeoutError | ContainerInterruptedError,
    Scope.Scope
  >;

  /** Interrupt a running container for a group */
  readonly interrupt: (
    groupFolder: string,
  ) => Effect.Effect<InterruptResult, ContainerError>;

  /** Check if a group has an active container request */
  readonly hasActiveRequest: (
    groupFolder: string,
  ) => Effect.Effect<boolean>;

  /** Kill all agent containers (shutdown) */
  readonly killAll: Effect.Effect<void, ContainerError>;

  /** Ensure agent Docker image exists, rebuilding if needed */
  readonly ensureImage: Effect.Effect<void, ContainerError>;

  /** Clean up orphaned persistent containers */
  readonly cleanupOrphans: Effect.Effect<void, ContainerError>;
}

export class ContainerRunner extends Context.Tag('ContainerRunner')<
  ContainerRunner,
  ContainerRunnerService
>() {}
