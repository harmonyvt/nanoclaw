import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { apiFetch, getAuthToken } from '../../shared/api.js';
import { useSSE } from '../../shared/hooks.js';
import { formatTime, formatActivityDuration, actionIcon, ActionIcon } from '../../shared/activity-icons.js';
import type { CuaActivityEvent } from '../../shared/types.js';

// ── Types ────────────────────────────────────────────────────────────────

interface SessionMeta {
  id: string;
  groupFolder: string;
  startedAt: number;
  endedAt: number | null;
  actionCount: number;
}

interface TrajectorySession extends SessionMeta {
  events: CuaActivityEvent[];
}

// ── Helpers ──────────────────────────────────────────────────────────────

function formatSessionTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatSessionDuration(startMs: number, endMs: number | null): string {
  const end = endMs ?? Date.now();
  const diff = end - startMs;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function screenshotUrl(screenshotPath: string, group: string): string | null {
  if (!screenshotPath) return null;
  const filename = screenshotPath.split('/').pop();
  if (!filename) return null;
  const params = new URLSearchParams({ group, path: `media/${filename}` });
  const token = getAuthToken();
  if (token) params.set('token', token);
  return `/api/files/agent/download?${params}`;
}

// ── Session List ─────────────────────────────────────────────────────────

function SessionList({ onSelect }: { onSelect: (id: string) => void }) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    try {
      const data = await apiFetch<SessionMeta[]>('/api/cua/trajectory/sessions?group=main&limit=50');
      setSessions(data);
      setError(null);
    } catch (err) {
      if (!sessions.length) {
        setError(err instanceof Error ? err.message : 'Failed to load');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSessions();
    const interval = setInterval(fetchSessions, 10_000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return <div class="pane active"><div class="loading">Loading trajectories...</div></div>;
  }

  if (error) {
    return <div class="pane active"><div class="empty">{error}</div></div>;
  }

  if (sessions.length === 0) {
    return (
      <div class="pane active">
        <div class="empty">No CUA trajectories yet. Browse actions will appear here.</div>
      </div>
    );
  }

  return (
    <div class="pane active">
      <div class="card-list">
        {sessions.map((s) => {
          const isActive = s.endedAt === null;
          const duration = formatSessionDuration(s.startedAt, s.endedAt);
          const badgeClass = isActive ? 'badge-active' : 'badge-ok';
          const badgeLabel = isActive ? 'Active' : 'Done';

          return (
            <div class="card" key={s.id} onClick={() => onSelect(s.id)}>
              <div class="card-header">
                <span class="card-title">{formatSessionTime(s.startedAt)}</span>
                <span class={`badge ${badgeClass}`}>{badgeLabel}</span>
              </div>
              <div class="card-meta">
                {s.actionCount} action{s.actionCount !== 1 ? 's' : ''} · {duration} · {s.groupFolder}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Screenshot Modal ─────────────────────────────────────────────────────

function ScreenshotModal({ url, onClose }: { url: string; onClose: () => void }) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return (
    <div class="trajectory-modal" onClick={onClose}>
      <div class="trajectory-modal-content" onClick={(e: Event) => e.stopPropagation()}>
        <img src={url} alt="Screenshot" />
        <button class="trajectory-modal-close" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

// ── Session Detail ───────────────────────────────────────────────────────

function SessionDetail({
  sessionId,
  onBack,
}: {
  sessionId: string;
  onBack: () => void;
}) {
  const [session, setSession] = useState<TrajectorySession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedScreenshot, setExpandedScreenshot] = useState<string | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  // Fetch session data
  useEffect(() => {
    setLoading(true);
    apiFetch<TrajectorySession>(`/api/cua/trajectory/session?group=main&id=${encodeURIComponent(sessionId)}`)
      .then((data) => {
        setSession(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load session');
        setLoading(false);
      });
  }, [sessionId]);

  // SSE for active sessions
  const isActive = session?.endedAt === null;

  const onSSEMessage = useCallback((event: string, data: unknown) => {
    if (event === 'activity') {
      const evt = data as CuaActivityEvent;
      setSession((prev) => {
        if (!prev) return prev;
        // Replace start event with end event if matching requestId
        if (evt.phase === 'end' && evt.requestId) {
          for (let i = prev.events.length - 1; i >= 0; i--) {
            if (prev.events[i].phase === 'start' && prev.events[i].requestId === evt.requestId) {
              const next = { ...prev, events: [...prev.events] };
              next.events[i] = evt;
              next.actionCount = next.events.length;
              return next;
            }
          }
        }
        // Append new event
        return {
          ...prev,
          events: [...prev.events, evt],
          actionCount: prev.events.length + 1,
        };
      });
    }
  }, []);

  useSSE('/api/cua/trajectory/stream?group=main', onSSEMessage, isActive ?? false);

  // Auto-scroll to bottom when new events arrive for active session
  useEffect(() => {
    if (isActive && timelineRef.current) {
      timelineRef.current.scrollTop = timelineRef.current.scrollHeight;
    }
  }, [session?.events.length]);

  if (loading) {
    return <div class="pane active"><div class="loading">Loading session...</div></div>;
  }

  if (error || !session) {
    return (
      <div class="pane active">
        <div class="empty">{error || 'Session not found'}</div>
      </div>
    );
  }

  return (
    <div class="pane active trajectory-detail">
      <div class="trajectory-header">
        <button class="trajectory-back" onClick={onBack}>
          <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" stroke-width="2">
            <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
          </svg>
          Back
        </button>
        <span class="trajectory-header-title">
          {formatSessionTime(session.startedAt)}
        </span>
        <span class="trajectory-header-meta">
          {session.actionCount} actions · {formatSessionDuration(session.startedAt, session.endedAt)}
          {isActive && <span class="badge badge-active" style={{ marginLeft: '8px' }}>Live</span>}
        </span>
      </div>

      <div class="trajectory-timeline" ref={timelineRef}>
        {session.events.map((event, i) => {
          const isStart = event.phase === 'start';
          const isError = event.status === 'error';
          const iconType = actionIcon(event.action);
          const imgUrl = event.screenshotPath ? screenshotUrl(event.screenshotPath, session.groupFolder) : null;

          return (
            <div
              key={event.id || i}
              class={`trajectory-step ${isStart ? 'trajectory-step-start' : ''} ${isError ? 'trajectory-step-error' : ''}`}
            >
              <div class="trajectory-step-dot">
                <span class={`trajectory-dot ${isStart ? 'dot-start' : isError ? 'dot-error' : 'dot-ok'}`} />
              </div>
              <div class="trajectory-step-content">
                <div class="trajectory-step-header">
                  <span class="trajectory-step-icon">
                    <ActionIcon type={iconType} />
                  </span>
                  <span class="trajectory-step-action">{event.action}</span>
                  <span class="trajectory-step-time mono">{formatTime(event.timestamp)}</span>
                  {!isStart && event.durationMs != null && (
                    <span class="badge">{formatActivityDuration(event.durationMs)}</span>
                  )}
                </div>
                <div class="trajectory-step-desc">{event.description}</div>
                {isError && event.error && (
                  <div class="trajectory-step-error">{event.error}</div>
                )}
                {imgUrl && (
                  <img
                    class="trajectory-screenshot"
                    src={imgUrl}
                    alt={`Screenshot at ${formatTime(event.timestamp)}`}
                    loading="lazy"
                    onClick={() => setExpandedScreenshot(imgUrl)}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>

      {expandedScreenshot && (
        <ScreenshotModal url={expandedScreenshot} onClose={() => setExpandedScreenshot(null)} />
      )}
    </div>
  );
}

// ── Main Pane ────────────────────────────────────────────────────────────

export function TrajectoryPane() {
  const [selectedSession, setSelectedSession] = useState<string | null>(null);

  if (selectedSession) {
    return (
      <SessionDetail
        sessionId={selectedSession}
        onBack={() => setSelectedSession(null)}
      />
    );
  }

  return <SessionList onSelect={setSelectedSession} />;
}
