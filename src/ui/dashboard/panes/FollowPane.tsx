import { useState, useEffect, useCallback } from 'preact/hooks';
import { useSSE } from '../../shared/hooks.js';
import { apiFetch } from '../../shared/api.js';
import type { CuaActivityEvent } from '../../shared/types.js';
import { DesktopPanel } from '../../follow/DesktopPanel.js';
import { ActivityPanel } from '../../follow/ActivityPanel.js';

interface VncInfo {
  liveViewUrl: string | null;
  vncPassword: string | null;
  sandboxRunning: boolean;
}

export function FollowPane() {
  const [activities, setActivities] = useState<CuaActivityEvent[]>([]);
  const [vncInfo, setVncInfo] = useState<VncInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const onSSEMessage = useCallback((event: string, data: unknown) => {
    if (event === 'activity') {
      const evt = data as CuaActivityEvent;
      setActivities((prev) => {
        if (evt.phase === 'end' && evt.requestId) {
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].phase === 'start' && prev[i].requestId === evt.requestId) {
              const next = [...prev];
              next[i] = evt;
              return next;
            }
          }
          return prev;
        }
        const next = [...prev, evt];
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
    <div class="follow-layout follow-layout-pane">
      <DesktopPanel
        liveViewUrl={vncInfo?.liveViewUrl ?? null}
        vncPassword={vncInfo?.vncPassword ?? null}
        sandboxRunning={vncInfo?.sandboxRunning ?? false}
      />
      <ActivityPanel
        activities={activities}
        connected={connected}
      />
    </div>
  );
}
