import { useState, useEffect, useCallback } from 'preact/hooks';
import { useSSE } from '../shared/hooks.js';
import { apiFetch } from '../shared/api.js';
import type { CuaActivityEvent } from '../shared/types.js';
import { DesktopPanel } from './DesktopPanel.js';
import { ActivityPanel } from './ActivityPanel.js';

interface VncInfo {
  liveViewUrl: string | null;
  sandboxRunning: boolean;
}

export function FollowApp() {
  const [activities, setActivities] = useState<CuaActivityEvent[]>([]);
  const [vncInfo, setVncInfo] = useState<VncInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetch VNC info on mount and periodically
  const fetchVncInfo = useCallback(async () => {
    try {
      const info = await apiFetch<VncInfo>('/api/cua/follow/vnc-info');
      setVncInfo(info);
    } catch (err) {
      if (!vncInfo) {
        setError(err instanceof Error ? err.message : 'Failed to connect');
      }
    }
  }, [vncInfo]);

  useEffect(() => {
    fetchVncInfo();
    const interval = setInterval(fetchVncInfo, 15_000);
    return () => clearInterval(interval);
  }, []);

  // SSE for activity events
  const onSSEMessage = useCallback((event: string, data: unknown) => {
    if (event === 'activity') {
      const evt = data as CuaActivityEvent;
      setActivities((prev) => {
        // When an end event arrives, replace the matching start event in-place
        if (evt.phase === 'end' && evt.requestId) {
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].phase === 'start' && prev[i].requestId === evt.requestId) {
              const next = [...prev];
              next[i] = evt;
              return next;
            }
          }
          // No matching start event found, skip orphaned end event
          return prev;
        }
        const next = [...prev, evt];
        // Cap at 500 events to avoid memory issues
        return next.length > 500 ? next.slice(-500) : next;
      });
    }
  }, []);

  const { connected } = useSSE('/api/cua/follow/stream', onSSEMessage);

  if (error && !vncInfo) {
    return (
      <div class="follow-error">
        <div class="follow-error-card card">
          <h2>Connection Failed</h2>
          <p>{error}</p>
          <button class="btn btn-primary" onClick={() => { setError(null); fetchVncInfo(); }}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div class="follow-layout">
      <DesktopPanel
        sandboxRunning={vncInfo?.sandboxRunning ?? false}
      />
      <ActivityPanel
        activities={activities}
        connected={connected}
      />
    </div>
  );
}
