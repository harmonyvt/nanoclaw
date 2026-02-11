import { useState, useEffect, useCallback } from 'preact/hooks';
import { apiFetch } from '../../shared/api.js';
import { useInterval, timeAgo } from '../../shared/hooks.js';

interface ProcessInfo {
  type: 'agent' | 'sandbox';
  groupFolder: string;
  containerId: string;
  lastUsed: string;
  idleSeconds: number;
  running: boolean;
}

export function ProcessesPane() {
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);

  const poll = useCallback(async () => {
    try {
      const data = await apiFetch<ProcessInfo[]>('/api/processes');
      setProcesses(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load processes');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    poll();
  }, []);
  useInterval(poll, 5_000);

  const handleAction = useCallback(
    async (
      action: 'kill' | 'restart' | 'interrupt',
      groupFolder: string,
      type: string,
    ) => {
      const label =
        action === 'kill' ? 'Force kill' : action === 'restart' ? 'Restart' : 'Interrupt';
      if (action !== 'interrupt' && !confirm(`${label} ${groupFolder}?`)) return;

      const key = `${action}-${groupFolder}`;
      setActionInProgress(key);
      try {
        await apiFetch(`/api/processes/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ groupFolder, type }),
        });
        await poll();
      } catch {
        // Refresh anyway to show current state
        await poll();
      } finally {
        setActionInProgress(null);
      }
    },
    [poll],
  );

  if (loading) {
    return (
      <div class="pane active">
        <div class="loading">Loading processes...</div>
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

  const agents = processes.filter((p) => p.type === 'agent');
  const sandbox = processes.find((p) => p.type === 'sandbox');

  const noRunning = agents.length === 0 && (!sandbox || !sandbox.running);

  return (
    <div class="pane active">
      <div class="card-list">
        {/* CUA Sandbox */}
        {sandbox && (
          <div class="card" style={{ cursor: 'default' }}>
            <div class="card-header">
              <span class="card-title">CUA Desktop Sandbox</span>
              <span class={`badge ${sandbox.running ? 'badge-ok' : 'badge-error'}`}>
                {sandbox.running ? 'running' : 'stopped'}
              </span>
            </div>
            <div class="card-meta">{sandbox.containerId}</div>
            <div style={{ marginTop: '8px', display: 'flex', gap: '6px' }}>
              {sandbox.running ? (
                <>
                  <button
                    class="btn btn-danger"
                    style={{ padding: '6px 12px', fontSize: '12px' }}
                    disabled={actionInProgress !== null}
                    onClick={() => handleAction('kill', 'cua-sandbox', 'sandbox')}
                  >
                    {actionInProgress === 'kill-cua-sandbox' ? 'Stopping...' : 'Stop'}
                  </button>
                  <button
                    class="btn btn-primary"
                    style={{ padding: '6px 12px', fontSize: '12px' }}
                    disabled={actionInProgress !== null}
                    onClick={() => handleAction('restart', 'cua-sandbox', 'sandbox')}
                  >
                    {actionInProgress === 'restart-cua-sandbox' ? 'Restarting...' : 'Restart'}
                  </button>
                </>
              ) : (
                <button
                  class="btn btn-success"
                  style={{ padding: '6px 12px', fontSize: '12px' }}
                  disabled={actionInProgress !== null}
                  onClick={() => handleAction('restart', 'cua-sandbox', 'sandbox')}
                >
                  {actionInProgress === 'restart-cua-sandbox' ? 'Starting...' : 'Start'}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Agent containers section header */}
        {agents.length > 0 && (
          <div
            style={{
              padding: '12px 0 4px',
              fontSize: '11px',
              color: 'var(--muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
            }}
          >
            Agent Containers ({agents.length})
          </div>
        )}

        {/* Agent container cards */}
        {agents.map((proc) => {
          const metaParts: string[] = [proc.containerId];
          if (proc.idleSeconds > 0) metaParts.push(`idle ${proc.idleSeconds}s`);
          if (proc.lastUsed) metaParts.push(`last used ${timeAgo(proc.lastUsed)}`);

          return (
            <div class="card" key={proc.groupFolder} style={{ cursor: 'default' }}>
              <div class="card-header">
                <span class="card-title">{proc.groupFolder}</span>
                <span class={`badge ${proc.running ? 'badge-active' : 'badge-error'}`}>
                  {proc.running ? 'running' : 'dead'}
                </span>
              </div>
              <div class="card-meta">{metaParts.join(' \u00B7 ')}</div>
              <div style={{ marginTop: '8px', display: 'flex', gap: '6px' }}>
                <button
                  class="btn btn-danger"
                  style={{ padding: '6px 12px', fontSize: '12px' }}
                  disabled={actionInProgress !== null}
                  onClick={() => handleAction('kill', proc.groupFolder, 'agent')}
                >
                  {actionInProgress === `kill-${proc.groupFolder}` ? 'Killing...' : 'Kill'}
                </button>
                <button
                  class="btn btn-primary"
                  style={{ padding: '6px 12px', fontSize: '12px' }}
                  disabled={actionInProgress !== null}
                  onClick={() => handleAction('interrupt', proc.groupFolder, 'agent')}
                >
                  {actionInProgress === `interrupt-${proc.groupFolder}`
                    ? 'Interrupting...'
                    : 'Interrupt'}
                </button>
              </div>
            </div>
          );
        })}

        {noRunning && <div class="empty">No running processes</div>}
      </div>
    </div>
  );
}
