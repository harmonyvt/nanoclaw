import { useState, useEffect, useCallback } from 'preact/hooks';
import { apiFetch } from '../../shared/api.js';
import { timeAgo, formatBytes, formatDuration } from '../../shared/hooks.js';
import { ContainerLogModal, type ContainerLogEntry } from './ContainerLogModal.js';

export function ContainersPane() {
  const [containers, setContainers] = useState<ContainerLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<ContainerLogEntry | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);

    apiFetch<ContainerLogEntry[]>('/api/containers?limit=50')
      .then((data) => {
        setContainers(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err?.message || 'Failed to load containers');
        setLoading(false);
      });
  }, []);

  const handleCardClick = useCallback((entry: ContainerLogEntry) => {
    setSelectedEntry(entry);
  }, []);

  const handleModalClose = useCallback(() => {
    setSelectedEntry(null);
  }, []);

  if (loading) {
    return (
      <div class="pane active">
        <div class="loading">Loading containers...</div>
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

  if (containers.length === 0) {
    return (
      <div class="pane active">
        <div class="empty">No container runs yet</div>
      </div>
    );
  }

  return (
    <div class="pane active">
      <div class="card-list">
        {containers.map((entry) => {
          const isSuccess = entry.status === 'success' || entry.exit_code === 0;
          const badgeClass = isSuccess ? 'badge-ok' : 'badge-error';
          const statusLabel = entry.status || (isSuccess ? 'success' : 'error');

          const metaParts: string[] = [];
          if (entry.mode) metaParts.push(entry.mode);
          if (entry.exit_code !== null && entry.exit_code !== undefined) {
            metaParts.push(`exit ${entry.exit_code}`);
          }
          if (entry.duration_ms !== null && entry.duration_ms !== undefined) {
            metaParts.push(formatDuration(entry.duration_ms));
          }
          if (entry.timestamp) metaParts.push(timeAgo(entry.timestamp));
          if (entry.file_size !== null && entry.file_size !== undefined) {
            metaParts.push(formatBytes(entry.file_size));
          }

          return (
            <div
              class="card"
              key={entry.id}
              onClick={() => handleCardClick(entry)}
            >
              <div class="card-header">
                <span class="card-title">{entry.group_folder}</span>
                <span class={`badge ${badgeClass}`}>{statusLabel}</span>
              </div>
              <div class="card-meta">{metaParts.join(' \u00B7 ')}</div>
            </div>
          );
        })}
      </div>
      {selectedEntry && (
        <ContainerLogModal entry={selectedEntry} onClose={handleModalClose} />
      )}
    </div>
  );
}
