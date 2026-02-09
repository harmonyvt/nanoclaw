import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

// ── Types ────────────────────────────────────────────────────────────────

export interface CuaActivityEvent {
  id: string;
  timestamp: number;
  groupFolder: string;
  action: string;
  phase: 'start' | 'end';
  description: string;
  requestId?: string;
  params?: Record<string, unknown>;
  status?: 'ok' | 'error';
  durationMs?: number;
  error?: string;
  screenshotPath?: string;
  usage?: { total: number; ok: number; failed: number };
}

// ── Event emitter ────────────────────────────────────────────────────────

export const cuaActivityEmitter = new EventEmitter();
cuaActivityEmitter.setMaxListeners(50);

export function emitCuaActivity(
  event: Omit<CuaActivityEvent, 'id' | 'timestamp'>,
): CuaActivityEvent {
  const full: CuaActivityEvent = {
    id: randomUUID(),
    timestamp: Date.now(),
    ...event,
  };

  cuaActivityEmitter.emit('activity', full);
  return full;
}
