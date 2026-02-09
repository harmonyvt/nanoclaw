import { useState, useEffect, useCallback } from 'preact/hooks';
import { apiFetch } from '../../shared/api.js';
import { useInterval } from '../../shared/hooks.js';
import { MetadataPanel } from '../../takeover/MetadataPanel.js';

interface TakeoverRequest {
  requestId: string;
  groupFolder: string;
  token: string;
  createdAt: string;
  message: string | null;
  liveViewUrl: string | null;
  vncPassword: string | null;
}

export function TakeoverPane() {
  const [requests, setRequests] = useState<TakeoverRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const pollRequests = useCallback(async () => {
    try {
      const data = await apiFetch<TakeoverRequest[]>('/api/cua/takeover/list');
      setRequests(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load takeover sessions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    pollRequests();
  }, []);

  useInterval(pollRequests, 10_000);

  if (loading) {
    return (
      <div class="pane active">
        <div class="loading">Checking for takeover sessions...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div class="pane active">
        <div class="empty">{error}</div>
      </div>
    );
  }

  if (requests.length === 0) {
    return (
      <div class="pane active">
        <div class="takeover-empty">
          <h3>No Active Takeover Sessions</h3>
          <p>
            When an agent requests <code>browse_wait_for_user</code>, the session
            will appear here with control options.
          </p>
        </div>
      </div>
    );
  }

  const active = requests[0];

  return (
    <div class="pane active">
      <div class="takeover-pane">
        <div class="takeover-card">
          <MetadataPanel
            requestId={active.requestId}
            groupFolder={active.groupFolder}
            createdAt={active.createdAt}
            token={active.token}
            session=""
            message={active.message ?? undefined}
            liveViewUrl={active.liveViewUrl}
            vncPassword={active.vncPassword}
          />
        </div>
      </div>
    </div>
  );
}
