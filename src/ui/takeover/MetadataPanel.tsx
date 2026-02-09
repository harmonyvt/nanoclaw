import { useState, useCallback, useEffect } from 'preact/hooks';
import { useInterval } from '../shared/hooks.js';
import { apiFetch } from '../shared/api.js';

interface Props {
  requestId: string;
  groupFolder: string;
  createdAt: string;
  token: string;
  session: string;
  message?: string;
  liveViewUrl?: string | null;
  vncPassword?: string | null;
}

type StatusColor = 'muted' | 'ok' | 'error';

function buildNoVncUrl(liveViewUrl: string, vncPassword: string): string | null {
  try {
    const url = new URL('/vnc_lite.html', liveViewUrl);
    url.searchParams.set('autoconnect', 'true');
    url.searchParams.set('resize', 'scale');
    url.searchParams.set('scale', 'true');
    url.searchParams.set('password', vncPassword);
    return url.toString();
  } catch {
    return null;
  }
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: 'UTC',
    }) + ' UTC';
  } catch {
    return iso;
  }
}

function shortId(requestId: string): string {
  const parts = requestId.split('-');
  return parts.length > 1 ? parts[1] : requestId.slice(0, 13);
}

export function MetadataPanel({
  requestId,
  groupFolder,
  createdAt,
  token,
  session,
  message,
  liveViewUrl,
  vncPassword,
}: Props) {
  const [statusText, setStatusText] = useState('Checking status...');
  const [statusColor, setStatusColor] = useState<StatusColor>('muted');
  const [returned, setReturned] = useState(false);
  const [busy, setBusy] = useState(false);

  const pollStatus = useCallback(async () => {
    if (returned) return;

    try {
      const payload = await apiFetch<{ status: string }>(
        `/api/cua/takeover/${encodeURIComponent(token)}`,
        { cache: 'no-store' },
      );

      if (payload.status !== 'pending') {
        setReturned(true);
        setStatusText('Agent has resumed control.');
        setStatusColor('ok');
        return;
      }

      if (!busy) {
        setStatusText(
          'You are currently in direct control of the instance. The automated agent is on standby and will resume operations once you release control.',
        );
        setStatusColor('muted');
      }
    } catch {
      setStatusText('Takeover session is no longer active.');
      setStatusColor('error');
      setReturned(true);
    }
  }, [token, returned, busy]);

  useEffect(() => {
    pollStatus();
  }, []);

  useInterval(pollStatus, returned ? null : 15_000);

  const handleContinue = useCallback(async () => {
    setBusy(true);
    setStatusText('Returning control...');
    setStatusColor('muted');

    try {
      await apiFetch(`/api/cua/takeover/${encodeURIComponent(token)}/continue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });

      setReturned(true);
      setStatusText('Agent has resumed control.');
      setStatusColor('ok');
    } catch (err) {
      setBusy(false);
      const msg = err instanceof Error ? err.message : 'unknown error';
      setStatusText(`Could not return control: ${msg}`);
      setStatusColor('error');
    }
  }, [token]);

  const dotClass = statusColor === 'ok' ? 'status-dot-ok' : statusColor === 'error' ? 'status-dot-error' : '';
  const labelClass = statusColor === 'ok' ? 'status-bar-label-ok' : statusColor === 'error' ? 'status-bar-label-error' : '';
  const statusLabel = returned
    ? 'Control Returned'
    : statusColor === 'error'
      ? 'Session Expired'
      : 'Manual Override Active';

  const noVncUrl = liveViewUrl && vncPassword ? buildNoVncUrl(liveViewUrl, vncPassword) : null;

  return (
    <>
      {/* Status Bar */}
      <div class="status-bar">
        <div class="status-bar-left">
          <span class={`status-dot ${dotClass}`} />
          <span class={`status-bar-label ${labelClass}`}>{statusLabel}</span>
        </div>
        <span class="status-bar-id">ID: {shortId(requestId)}</span>
      </div>

      <div class="card-body">
        {/* Header */}
        <header class="card-header">
          <div class="header-icon">
            <svg viewBox="0 0 24 24">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
              <circle cx="12" cy="10" r="1" fill="currentColor" stroke="none" />
            </svg>
          </div>
          <h1 class="card-title">Browser Takeover</h1>
          <p class="card-subtitle">
            {message || 'Manual control session established via Telegram remote command.'}
          </p>
        </header>

        {/* Info Grid */}
        <div class="info-grid">
          <div class="info-cell info-cell-wide">
            <div class="info-cell-head">
              <svg viewBox="0 0 24 24" class="icon-sky"><path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4" /></svg>
              <span class="info-cell-label">Request Token</span>
            </div>
            <div class="info-cell-value">{requestId}</div>
          </div>

          <div class="info-cell info-cell-inline">
            <div class="info-cell-head">
              <svg viewBox="0 0 24 24" class="icon-indigo"><path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" /><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" /><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" /></svg>
              <span class="info-cell-label">Group</span>
            </div>
            <span class="info-cell-value">{groupFolder}</span>
          </div>

          <div class="info-cell info-cell-inline">
            <div class="info-cell-head">
              <svg viewBox="0 0 24 24" class="icon-slate"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
              <span class="info-cell-label">Initialized</span>
            </div>
            <span class="info-cell-value info-cell-value-mono">{formatTime(createdAt)}</span>
          </div>
        </div>

        {/* Actions */}
        <div class="action-area">
          <div class="action-buttons">
            <button
              class={`btn-return ${returned ? 'btn-return-done' : ''}`}
              disabled={returned || busy}
              onClick={handleContinue}
            >
              <span>{returned ? 'Control Returned' : 'Return Control To Agent'}</span>
              <svg viewBox="0 0 24 24">
                {returned
                  ? <><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></>
                  : <><circle cx="12" cy="12" r="10" /><path d="m8 12 4 0" /><path d="m12 12 4 0" /><path d="m14 8 4 4-4 4" /></>
                }
              </svg>
            </button>

            {noVncUrl && (
              <a
                class="btn-desktop"
                href={noVncUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <svg viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
                <span>Live Desktop</span>
              </a>
            )}
          </div>

          <div class="info-banner">
            <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg>
            <p>{statusText}</p>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div class="card-footer">
        <span>CUA Central Uplink Architecture</span>
      </div>
    </>
  );
}
