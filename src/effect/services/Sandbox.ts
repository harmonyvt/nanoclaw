/**
 * Effect service: CUA Sandbox
 *
 * Manages the CUA desktop sandbox lifecycle (Docker container
 * with XFCE, VNC, Chromium) as a scoped Effect resource.
 */
import { Context, Effect, Layer } from 'effect';

import {
  cleanupSandbox,
  ensureSandbox,
  startIdleWatcher,
} from '../../sandbox-manager.js';

export interface SandboxService {
  readonly ensure: () => Effect.Effect<void>;
  readonly cleanup: () => Effect.Effect<void>;
  readonly startIdleWatcher: () => Effect.Effect<void>;
}

export class Sandbox extends Context.Tag('nanoclaw/Sandbox')<
  Sandbox,
  SandboxService
>() {}

export const SandboxLive = Layer.scoped(
  Sandbox,
  Effect.acquireRelease(
    Effect.succeed({
      ensure: () => Effect.promise(() => ensureSandbox()),
      cleanup: () => Effect.sync(() => cleanupSandbox()),
      startIdleWatcher: () => Effect.sync(() => startIdleWatcher()),
    } satisfies SandboxService),
    () =>
      Effect.sync(() => {
        cleanupSandbox();
      }),
  ),
);
