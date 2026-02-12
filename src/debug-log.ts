import {
  exportDebugEvents,
  getDebugEventStats,
  insertDebugEvent,
  pruneDebugEvents,
} from './db.js';
import { logger } from './logger.js';

const DEBUG_EVENT_RETENTION_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

export type DebugEventCategory =
  | 'sdk'
  | 'telegram'
  | 'tts'
  | 'browse'
  | 'ipc';

export interface DebugReport {
  version: number;
  exportedAt: string;
  filter: { since: string | null; group: string | null; limit: number };
  stats: {
    total: number;
    byCategory: Record<string, number>;
    oldestTimestamp: number | null;
    newestTimestamp: number | null;
  };
  events: Array<{
    id: number;
    timestamp: number;
    timestampISO: string;
    category: string;
    event_type: string;
    group_folder: string | null;
    metadata: Record<string, unknown>;
  }>;
}

/**
 * Log a structured debug event. Fire-and-forget — errors are swallowed.
 */
export function logDebugEvent(
  category: DebugEventCategory,
  eventType: string,
  groupFolder: string | null,
  metadata: Record<string, unknown> = {},
): void {
  try {
    insertDebugEvent(category, eventType, groupFolder, metadata);
  } catch (err) {
    logger.debug(
      { module: 'debug-log', err, category, eventType },
      'Failed to log debug event',
    );
  }
}

/**
 * Export debug events as a JSON structure for analysis by another agent.
 */
export function exportDebugReport(opts?: {
  since?: number;
  group?: string;
  limit?: number;
}): DebugReport {
  const events = exportDebugEvents(opts || {});
  const stats = getDebugEventStats();

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    filter: {
      since: opts?.since ? new Date(opts.since).toISOString() : null,
      group: opts?.group || null,
      limit: opts?.limit || 10000,
    },
    stats,
    events: events.map((e) => ({
      ...e,
      metadata: JSON.parse(e.metadata),
      timestampISO: new Date(e.timestamp).toISOString(),
    })),
  };
}

/**
 * Prune old debug events. Call from startup or periodically.
 */
export function pruneDebugEventEntries(): void {
  const deleted = pruneDebugEvents(DEBUG_EVENT_RETENTION_MS);
  if (deleted > 0) {
    logger.info({ module: 'debug-log', deleted }, 'Pruned old debug events');
  }
}
