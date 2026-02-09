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

// ── Event emitter + ring buffer ──────────────────────────────────────────

const RING_BUFFER_SIZE = 100;
const ringBuffer: CuaActivityEvent[] = [];

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

  ringBuffer.push(full);
  if (ringBuffer.length > RING_BUFFER_SIZE) {
    ringBuffer.shift();
  }

  cuaActivityEmitter.emit('activity', full);
  return full;
}

export function getActivityRingBuffer(groupFolder?: string): CuaActivityEvent[] {
  if (!groupFolder) return [...ringBuffer];
  return ringBuffer.filter((e) => e.groupFolder === groupFolder);
}

// ── Follow session tracking ──────────────────────────────────────────────

interface FollowSession {
  groupFolder: string;
  connectedAt: number;
}

const followSessions = new Map<string, FollowSession>();

export function registerFollowSession(
  groupFolder: string,
  sessionId: string,
): void {
  followSessions.set(sessionId, { groupFolder, connectedAt: Date.now() });
}

export function unregisterFollowSession(sessionId: string): string | null {
  const session = followSessions.get(sessionId);
  if (!session) return null;
  followSessions.delete(sessionId);
  return session.groupFolder;
}

export function hasActiveFollowSession(groupFolder: string): boolean {
  for (const session of followSessions.values()) {
    if (session.groupFolder === groupFolder) return true;
  }
  return false;
}

export function getFollowSessionCount(groupFolder?: string): number {
  if (!groupFolder) return followSessions.size;
  let count = 0;
  for (const session of followSessions.values()) {
    if (session.groupFolder === groupFolder) count++;
  }
  return count;
}
