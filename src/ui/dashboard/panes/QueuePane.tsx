import { useState, useEffect, useCallback } from 'preact/hooks';
import { apiFetch } from '../../shared/api.js';
import { timeAgo, truncate } from '../../shared/hooks.js';

interface ApiQueuedSkill {
  id: string;
  group_folder: string;
  chat_jid: string;
  skill_name: string;
  skill_args: string | null;
  position: number;
  status: string;
  result: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

function queueBadgeClass(status: string): string {
  if (status === 'running') return 'badge-active';
  if (status === 'completed') return 'badge-ok';
  if (status === 'failed') return 'badge-error';
  if (status === 'cancelled') return 'badge-paused';
  return '';
}

export function QueuePane() {
  const [items, setItems] = useState<ApiQueuedSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [group, setGroup] = useState('main');

  const loadQueue = useCallback(() => {
    setError(null);
    apiFetch<ApiQueuedSkill[]>(`/api/queue?group=${encodeURIComponent(group)}`)
      .then((data) => {
        setItems(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err?.message || 'Failed to load queue');
        setLoading(false);
      });
  }, [group]);

  useEffect(() => {
    setLoading(true);
    loadQueue();
  }, [loadQueue]);

  const handleRemove = async (id: string) => {
    try {
      await apiFetch('/api/queue/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remove', id }),
      });
      loadQueue();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to remove item';
      setError(msg);
    }
  };

  const handleClear = async () => {
    try {
      await apiFetch('/api/queue/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'clear', group }),
      });
      loadQueue();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to clear queue';
      setError(msg);
    }
  };

  if (loading) {
    return (
      <div class="pane active">
        <div class="loading">Loading queue...</div>
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

  const pending = items.filter((i) => i.status === 'pending');
  const other = items.filter((i) => i.status !== 'pending');

  return (
    <div class="pane active">
      <div style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{ fontSize: '12px', color: 'var(--muted)' }}>Group:</span>
        <input
          type="text"
          value={group}
          onChange={(e) => setGroup((e.target as HTMLInputElement).value)}
          style={{
            background: 'var(--panel)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 'var(--radius)',
            color: 'var(--text)',
            padding: '4px 8px',
            fontSize: '12px',
            width: '120px',
          }}
        />
        <button
          onClick={loadQueue}
          style={{
            background: 'var(--panel-2)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 'var(--radius)',
            color: 'var(--text)',
            padding: '4px 12px',
            fontSize: '12px',
            cursor: 'pointer',
          }}
        >
          Refresh
        </button>
        {pending.length > 0 && (
          <button
            onClick={handleClear}
            style={{
              background: 'var(--panel-2)',
              border: '1px solid var(--danger)',
              borderRadius: 'var(--radius)',
              color: 'var(--danger)',
              padding: '4px 12px',
              fontSize: '12px',
              cursor: 'pointer',
              marginLeft: 'auto',
            }}
          >
            Clear Pending
          </button>
        )}
      </div>
      {items.length === 0 ? (
        <div class="empty">No items in queue. Use /skills in Telegram to queue a skill.</div>
      ) : (
        <div class="card-list">
          {items.map((item) => {
            const metaParts: string[] = [];
            metaParts.push(item.group_folder);
            if (item.skill_args) metaParts.push(`args: ${truncate(item.skill_args, 30)}`);
            metaParts.push(timeAgo(item.created_at));

            return (
              <div class="card" key={item.id} style={{ cursor: 'default' }}>
                <div class="card-header">
                  <span class="card-title">/{item.skill_name}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span class={`badge ${queueBadgeClass(item.status)}`}>
                      {item.status}
                    </span>
                    {item.status === 'pending' && (
                      <button
                        onClick={() => handleRemove(item.id)}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: 'var(--danger)',
                          cursor: 'pointer',
                          fontSize: '11px',
                          padding: '2px 4px',
                        }}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
                <div class="card-meta">{metaParts.join(' \u00B7 ')}</div>
                {item.error && (
                  <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--danger)' }}>
                    {truncate(item.error, 80)}
                  </div>
                )}
                {item.result && (
                  <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--muted)' }}>
                    {truncate(item.result, 80)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
