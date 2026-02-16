/**
 * CUA Sandbox service — manages the desktop sandbox container lifecycle.
 */

import { Context, Effect } from 'effect';
import type { SandboxError, SandboxStartError } from '../errors.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface SandboxConnection {
  readonly containerName: string;
  readonly commandUrl: string;
  readonly vncPort: number;
  readonly novncPort: number;
}

// ─── Service Interface ─────────────────────────────────────────────────────

export interface SandboxService {
  /** Acquire the sandbox (starts if not running, resets idle timer). */
  readonly acquire: Effect.Effect<SandboxConnection, SandboxStartError>;

  /** Ensure sandbox is running (idempotent, resets idle timer) */
  readonly ensure: Effect.Effect<SandboxConnection, SandboxStartError>;

  /** Reset idle timer (called on each browse action) */
  readonly resetIdle: Effect.Effect<void>;

  /** Get current VNC password */
  readonly getVncPassword: Effect.Effect<string | null>;

  /** Rotate VNC password (new takeover session) */
  readonly rotateVncPassword: Effect.Effect<string | null, SandboxError>;

  /** Force-reset sandbox (recreate container, keep volume) */
  readonly reset: Effect.Effect<void, SandboxError>;

  /** Full reset (destroy container + volume) */
  readonly resetFull: Effect.Effect<void, SandboxError>;

  /** Start the idle watcher fiber (called once at boot) */
  readonly startIdleWatcher: Effect.Effect<void>;
}

export class Sandbox extends Context.Tag('Sandbox')<
  Sandbox,
  SandboxService
>() {}
