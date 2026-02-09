import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';

import { GROUPS_DIR } from './config.js';
import { cuaActivityEmitter, type CuaActivityEvent } from './cua-activity.js';
import { logger } from './logger.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface TrajectorySession {
  id: string;
  groupFolder: string;
  startedAt: number;
  endedAt: number | null;
  actionCount: number;
  events: CuaActivityEvent[];
}

export interface TrajectorySessionMeta {
  id: string;
  groupFolder: string;
  startedAt: number;
  endedAt: number | null;
  actionCount: number;
}

// ── Constants ────────────────────────────────────────────────────────────

const SESSION_GAP_MS = 5 * 60 * 1000; // 5 minutes of inactivity = new session
const FLUSH_INTERVAL_MS = 30_000; // Flush active session every 30s
const TRAJECTORY_DIR_NAME = 'trajectory';

// ── State ────────────────────────────────────────────────────────────────

const activeSessions = new Map<string, TrajectorySession>();
let flushTimer: ReturnType<typeof setInterval> | null = null;

// ── Helpers ──────────────────────────────────────────────────────────────

function trajectoryDir(groupFolder: string): string {
  return path.join(GROUPS_DIR, groupFolder, TRAJECTORY_DIR_NAME);
}

function sessionFilename(session: TrajectorySession): string {
  return `session-${session.startedAt}.json`;
}

function ensureTrajectoryDir(groupFolder: string): void {
  const dir = trajectoryDir(groupFolder);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function writeSession(session: TrajectorySession): void {
  ensureTrajectoryDir(session.groupFolder);
  const filePath = path.join(
    trajectoryDir(session.groupFolder),
    sessionFilename(session),
  );
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(session, null, 2));
  fs.renameSync(tmpPath, filePath);
}

// ── Event handler ────────────────────────────────────────────────────────

function handleActivity(event: CuaActivityEvent): void {
  const { groupFolder } = event;
  const active = activeSessions.get(groupFolder);

  // Check if we need a new session (no active, or gap exceeded)
  if (
    !active ||
    event.timestamp - (active.events[active.events.length - 1]?.timestamp ?? 0) > SESSION_GAP_MS
  ) {
    // Flush previous session if it exists
    if (active && active.events.length > 0) {
      active.endedAt = active.events[active.events.length - 1].timestamp;
      active.actionCount = active.events.length;
      try {
        writeSession(active);
      } catch (err) {
        logger.warn({ module: 'trajectory', err }, 'Failed to flush session');
      }
    }

    // Start new session
    const newSession: TrajectorySession = {
      id: randomUUID(),
      groupFolder,
      startedAt: event.timestamp,
      endedAt: null,
      actionCount: 0,
      events: [],
    };
    activeSessions.set(groupFolder, newSession);
  }

  const session = activeSessions.get(groupFolder)!;
  session.events.push(event);
  session.actionCount = session.events.length;
}

function flushActiveSessions(): void {
  for (const session of activeSessions.values()) {
    if (session.events.length > 0) {
      try {
        writeSession(session);
      } catch (err) {
        logger.warn({ module: 'trajectory', err, group: session.groupFolder }, 'Periodic flush failed');
      }
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────────

export function initTrajectoryPersistence(): void {
  cuaActivityEmitter.on('activity', handleActivity);
  flushTimer = setInterval(flushActiveSessions, FLUSH_INTERVAL_MS);
  logger.info({ module: 'trajectory' }, 'Trajectory persistence initialized');
}

export function stopTrajectoryPersistence(): void {
  cuaActivityEmitter.off('activity', handleActivity);
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  // Final flush
  flushActiveSessions();
}

export function getActiveSession(groupFolder: string): TrajectorySession | null {
  return activeSessions.get(groupFolder) ?? null;
}

export function getTrajectorySessions(
  groupFolder: string,
  limit = 20,
): TrajectorySessionMeta[] {
  const dir = trajectoryDir(groupFolder);
  const results: TrajectorySessionMeta[] = [];

  // Add active session first if it exists
  const active = activeSessions.get(groupFolder);
  if (active && active.events.length > 0) {
    results.push({
      id: active.id,
      groupFolder: active.groupFolder,
      startedAt: active.startedAt,
      endedAt: null,
      actionCount: active.actionCount,
    });
  }

  // Read persisted sessions from disk
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir)
      .filter((f) => f.startsWith('session-') && f.endsWith('.json') && !f.endsWith('.tmp'))
      .sort()
      .reverse(); // newest first

    for (const file of files) {
      if (results.length >= limit) break;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as TrajectorySession;
        // Skip if this is the same as the active session
        if (active && data.id === active.id) continue;
        results.push({
          id: data.id,
          groupFolder: data.groupFolder,
          startedAt: data.startedAt,
          endedAt: data.endedAt,
          actionCount: data.actionCount,
        });
      } catch {
        // Skip corrupt files
      }
    }
  }

  return results.slice(0, limit);
}

export function getTrajectorySession(
  groupFolder: string,
  sessionId: string,
): TrajectorySession | null {
  // Check active session first
  const active = activeSessions.get(groupFolder);
  if (active && active.id === sessionId) {
    return active;
  }

  // Search persisted files
  const dir = trajectoryDir(groupFolder);
  if (!fs.existsSync(dir)) return null;

  const files = fs.readdirSync(dir)
    .filter((f) => f.startsWith('session-') && f.endsWith('.json') && !f.endsWith('.tmp'));

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as TrajectorySession;
      if (data.id === sessionId) return data;
    } catch {
      // Skip corrupt files
    }
  }

  return null;
}
