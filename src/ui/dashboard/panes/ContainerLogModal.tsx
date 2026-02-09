import { useState, useEffect, useCallback } from 'preact/hooks';
import { apiFetchText } from '../../shared/api.js';
import { timeAgo, formatBytes, formatDuration } from '../../shared/hooks.js';

/** Shape returned by GET /api/containers */
export interface ContainerLogEntry {
  id: number;
  group_folder: string;
  filename: string;
  timestamp: string | null;
  duration_ms: number | null;
  exit_code: number | null;
  mode: string | null;
  is_main: number | null;
  status: string | null;
  file_size: number | null;
  indexed_at: string;
}

interface ContainerLogModalProps {
  entry: ContainerLogEntry;
  onClose: () => void;
}

export function ContainerLogModal({ entry, onClose }: ContainerLogModalProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);

    const url = `/api/containers/${encodeURIComponent(entry.group_folder)}/${encodeURIComponent(entry.filename)}`;
    apiFetchText(url)
      .then((text) => {
        setContent(text);
        setLoading(false);
      })
      .catch((err) => {
        setError(err?.message || 'Failed to load log');
        setLoading(false);
      });
  }, [entry.group_folder, entry.filename]);

  const handleBackdropClick = useCallback(
    (e: MouseEvent) => {
      if ((e.target as HTMLElement).classList.contains('container-log-modal')) {
        onClose();
      }
    },
    [onClose],
  );

  const isSuccess = entry.status === 'success' || entry.exit_code === 0;
  const badgeClass = isSuccess ? 'badge-ok' : 'badge-error';
  const statusLabel = entry.status || (isSuccess ? 'success' : 'error');

  return (
    <div class="container-log-modal" onClick={handleBackdropClick}>
      <div class="container-log-header">
        <span class="cl-title">
          {entry.group_folder} / {entry.filename}
        </span>
        <button class="cl-close" onClick={onClose}>
          Close
        </button>
      </div>
      <div class="container-log-meta">
        <div class="cl-meta-item">
          <span class="cl-meta-label">Status</span>
          <span class={`badge ${badgeClass}`}>{statusLabel}</span>
        </div>
        {entry.exit_code !== null && entry.exit_code !== undefined && (
          <div class="cl-meta-item">
            <span class="cl-meta-label">Exit</span>
            <span>{entry.exit_code}</span>
          </div>
        )}
        {entry.mode && (
          <div class="cl-meta-item">
            <span class="cl-meta-label">Mode</span>
            <span>{entry.mode}</span>
          </div>
        )}
        {entry.duration_ms !== null && entry.duration_ms !== undefined && (
          <div class="cl-meta-item">
            <span class="cl-meta-label">Duration</span>
            <span>{formatDuration(entry.duration_ms)}</span>
          </div>
        )}
        {entry.timestamp && (
          <div class="cl-meta-item">
            <span class="cl-meta-label">Time</span>
            <span>{timeAgo(entry.timestamp)}</span>
          </div>
        )}
        {entry.file_size !== null && entry.file_size !== undefined && (
          <div class="cl-meta-item">
            <span class="cl-meta-label">Size</span>
            <span>{formatBytes(entry.file_size)}</span>
          </div>
        )}
      </div>
      <div class="container-log-content">
        {loading && 'Loading...'}
        {error && `Error: ${error}`}
        {!loading && !error && (content || 'Empty log')}
      </div>
    </div>
  );
}
