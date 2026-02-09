import { useState, useEffect, useCallback } from 'preact/hooks';
import { useSSE } from '../shared/hooks.js';
import { apiFetch } from '../shared/api.js';
import type { CuaActivityEvent } from '../shared/types.js';
import { DesktopPanel } from './DesktopPanel.js';
import { ActivityPanel } from './ActivityPanel.js';

interface VncInfo {
  liveViewUrl: string | null;
  vncPassword: string | null;
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
      setActivities((prev) => {
        const next = [...prev, data as CuaActivityEvent];
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
        liveViewUrl={vncInfo?.liveViewUrl ?? null}
        vncPassword={vncInfo?.vncPassword ?? null}
        sandboxRunning={vncInfo?.sandboxRunning ?? false}
      />
      <ActivityPanel
        activities={activities}
        connected={connected}
        groupFolder={vncInfo?.liveViewUrl ? 'main' : 'main'}
      />
    </div>
  );
}
