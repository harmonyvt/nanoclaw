/**
 * StatusEmitter service — emits status events (tool_start, thinking, etc.)
 * back to the host process via RPC or IPC files.
 */

import { Context, Effect, Layer } from 'effect';
import fs from 'fs';
import path from 'path';
import { HostBridge } from './HostBridge.js';

// ─── Service Interface ─────────────────────────────────────────────────────

export interface StatusEmitterService {
  /** Emit a status event to the host */
  readonly emit: (event: Record<string, unknown>) => Effect.Effect<void>;
}

export class StatusEmitter extends Context.Tag('StatusEmitter')<
  StatusEmitter,
  StatusEmitterService
>() {}

// ─── Stub Layers ───────────────────────────────────────────────────────────

/** Persistent mode: emit via HostBridge.notify */
export const StatusEmitterRpc: Layer.Layer<StatusEmitter, never, HostBridge> =
  Layer.effect(
    StatusEmitter,
    Effect.gen(function* () {
      const bridge = yield* HostBridge;
      return {
        emit: (event) => bridge.notify('status.event', event),
      };
    }),
  );

/** One-shot mode: write to /workspace/ipc/status/ directory */
export const StatusEmitterFile: Layer.Layer<StatusEmitter> = Layer.succeed(
  StatusEmitter,
  {
    emit: (event) =>
      Effect.sync(() => {
        const statusDir = '/workspace/ipc/status';
        try {
          fs.mkdirSync(statusDir, { recursive: true });
        } catch {}
        const filename = `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
        const filepath = path.join(statusDir, filename);
        const tempPath = `${filepath}.tmp`;
        fs.writeFileSync(tempPath, JSON.stringify(event));
        fs.renameSync(tempPath, filepath);
      }),
  },
);
