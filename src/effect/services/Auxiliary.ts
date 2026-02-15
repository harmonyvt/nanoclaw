/**
 * Effect service: Auxiliary Services
 *
 * Groups optional/auxiliary services (CUA takeover, dashboard, TTS,
 * tailscale, log sync) that have start/stop lifecycle.
 */
import { Context, Effect, Layer } from 'effect';

import {
  startCuaTakeoverServer,
  stopCuaTakeoverServer,
} from '../../cua-takeover-server.js';
import {
  startDashboardServer,
  stopDashboardServer,
} from '../../dashboard-server.js';
import {
  initTailscaleServe,
  stopTailscaleServe,
} from '../../tailscale-serve.js';
import {
  initLogSync,
  stopLogSync,
  pruneOldLogEntries,
} from '../../log-sync.js';
import { initTrajectoryPersistence } from '../../cua-trajectory.js';
import { logDebugEvent, pruneDebugEventEntries } from '../../debug-log.js';
import { closeServiceLogHandles, rotateServiceLogs } from '../../service-log-writer.js';
import { cleanupOldMedia } from '../../media.js';

export interface AuxiliaryService {
  readonly startCuaTakeover: () => Effect.Effect<void>;
  readonly stopCuaTakeover: () => Effect.Effect<void>;
  readonly startDashboard: () => Effect.Effect<void>;
  readonly stopDashboard: () => Effect.Effect<void>;
  readonly initTailscale: () => Effect.Effect<void>;
  readonly stopTailscale: () => Effect.Effect<void>;
  readonly initLogSync: () => Effect.Effect<void>;
  readonly stopLogSync: () => Effect.Effect<void>;
  readonly pruneOldLogEntries: () => Effect.Effect<void>;
  readonly pruneDebugEventEntries: () => Effect.Effect<void>;
  readonly rotateServiceLogs: (maxSizeMb: number) => Effect.Effect<void>;
  readonly initTrajectoryPersistence: () => Effect.Effect<void>;
  readonly cleanupOldMedia: (mediaDir: string, retentionDays: number) => Effect.Effect<void>;
  readonly closeServiceLogHandles: () => Effect.Effect<void>;
}

export class Auxiliary extends Context.Tag('nanoclaw/Auxiliary')<
  Auxiliary,
  AuxiliaryService
>() {}

export const AuxiliaryLive = Layer.scoped(
  Auxiliary,
  Effect.acquireRelease(
    Effect.succeed({
      startCuaTakeover: () => Effect.sync(() => startCuaTakeoverServer()),
      stopCuaTakeover: () => Effect.sync(() => stopCuaTakeoverServer()),
      startDashboard: () => Effect.sync(() => startDashboardServer()),
      stopDashboard: () => Effect.sync(() => stopDashboardServer()),
      initTailscale: () => Effect.sync(() => initTailscaleServe()),
      stopTailscale: () => Effect.sync(() => stopTailscaleServe()),
      initLogSync: () => Effect.sync(() => initLogSync()),
      stopLogSync: () => Effect.sync(() => stopLogSync()),
      pruneOldLogEntries: () => Effect.sync(() => pruneOldLogEntries()),
      pruneDebugEventEntries: () => Effect.sync(() => pruneDebugEventEntries()),
      rotateServiceLogs: (maxSizeMb) => Effect.sync(() => rotateServiceLogs(maxSizeMb)),
      initTrajectoryPersistence: () => Effect.sync(() => initTrajectoryPersistence()),
      cleanupOldMedia: (mediaDir, retentionDays) =>
        Effect.sync(() => cleanupOldMedia(mediaDir, retentionDays)),
      closeServiceLogHandles: () => Effect.sync(() => closeServiceLogHandles()),
    } satisfies AuxiliaryService),
    (svc) =>
      Effect.all([
        svc.stopCuaTakeover(),
        svc.stopDashboard(),
        svc.stopTailscale(),
        svc.stopLogSync(),
        svc.closeServiceLogHandles(),
      ]),
  ),
);
