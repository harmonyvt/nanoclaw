import { logger } from './logger.js';

// ── Types ────────────────────────────────────────────────────────────────

interface QueuedAction {
  action: string;
  status: string;
  durationMs: number;
  timestamp: number;
}

interface GroupSummaryState {
  queue: QueuedAction[];
  timer: ReturnType<typeof setInterval> | null;
  sendFn: ((summary: string) => void) | null;
}

// ── State ────────────────────────────────────────────────────────────────

const SUMMARY_INTERVAL_MS = 30_000; // 30 seconds
const groupStates = new Map<string, GroupSummaryState>();

function getOrCreateState(groupFolder: string): GroupSummaryState {
  let state = groupStates.get(groupFolder);
  if (!state) {
    state = { queue: [], timer: null, sendFn: null };
    groupStates.set(groupFolder, state);
  }
  return state;
}

// ── Public API ───────────────────────────────────────────────────────────

export function queueActionForSummary(
  groupFolder: string,
  action: string,
  status: string,
  durationMs: number,
): void {
  const state = getOrCreateState(groupFolder);
  state.queue.push({ action, status, durationMs, timestamp: Date.now() });
}

export function flushSummary(groupFolder: string): string | null {
  const state = groupStates.get(groupFolder);
  if (!state || state.queue.length === 0) return null;

  const actions = state.queue.splice(0);
  const okCount = actions.filter((a) => a.status === 'ok').length;
  const errCount = actions.length - okCount;
  const totalDurationMs = actions.reduce((sum, a) => sum + a.durationMs, 0);
  const totalDurationSec = (totalDurationMs / 1000).toFixed(1);

  const chain = actions
    .map((a) => `${a.action}:${a.status}`)
    .join(' → ');

  const errPart = errCount > 0 ? `, ${errCount} err` : '';
  return `CUA Summary (30s): ${actions.length} actions (${okCount} ok${errPart}), ${totalDurationSec}s total\n${chain}`;
}

export function startFollowSummaryTimer(
  groupFolder: string,
  sendFn: (summary: string) => void,
): void {
  const state = getOrCreateState(groupFolder);

  // Already running
  if (state.timer) {
    state.sendFn = sendFn;
    return;
  }

  state.sendFn = sendFn;
  state.timer = setInterval(() => {
    const summary = flushSummary(groupFolder);
    if (summary && state.sendFn) {
      try {
        state.sendFn(summary);
      } catch (err) {
        logger.warn(
          { module: 'cua-follow-summary', err, groupFolder },
          'Failed to send follow summary',
        );
      }
    }
  }, SUMMARY_INTERVAL_MS);

  logger.debug({ module: 'cua-follow-summary', groupFolder }, 'Summary timer started');
}

export function stopFollowSummaryTimer(groupFolder: string): void {
  const state = groupStates.get(groupFolder);
  if (!state) return;

  // Flush remaining actions as a final summary
  const summary = flushSummary(groupFolder);
  if (summary && state.sendFn) {
    try {
      state.sendFn(summary);
    } catch {
      // Best-effort
    }
  }

  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  state.sendFn = null;

  logger.debug({ module: 'cua-follow-summary', groupFolder }, 'Summary timer stopped');
}
