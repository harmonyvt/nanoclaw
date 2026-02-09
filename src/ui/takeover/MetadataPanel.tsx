import { useState, useCallback, useEffect } from 'preact/hooks';
import { useInterval } from '../shared/hooks.js';
import { apiFetch } from '../shared/api.js';

interface Props {
  requestId: string;
  groupFolder: string;
  createdAt: string;
  token: string;
  session: string;
}

type StatusColor = 'muted' | 'ok' | 'error';

export function MetadataPanel({
  requestId,
  groupFolder,
  createdAt,
  token,
  session,
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
          'You control the browser now. Click "Return Control To Agent" when done.',
        );
        setStatusColor('muted');
      }
    } catch {
      setStatusText('Takeover session is no longer active.');
      setStatusColor('error');
      setReturned(true);
    }
  }, [token, returned, busy]);

  // Initial poll on mount
  useEffect(() => {
    pollStatus();
  }, []);

  // Recurring poll every 15s
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
      const message =
        err instanceof Error ? err.message : 'unknown error';
      setStatusText(`Could not return control: ${message}`);
      setStatusColor('error');
    }
  }, [token]);

  const colorClass =
    statusColor === 'ok'
      ? 'status-ok'
      : statusColor === 'error'
        ? 'status-error'
        : 'status-muted';

  return (
    <aside class="panel meta">
      <div class="meta-item">
        <div class="meta-label">Request</div>
        <div class="meta-value">
          <code>{requestId}</code>
        </div>
      </div>
      <div class="meta-item">
        <div class="meta-label">Group</div>
        <div class="meta-value">{groupFolder}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">Created</div>
        <div class="meta-value">{createdAt}</div>
      </div>
      <div class="controls">
        <button
          class={`btn ${returned ? 'btn-success' : 'btn-primary'}`}
          disabled={returned || busy}
          onClick={handleContinue}
        >
          {returned ? 'Control Returned' : 'Return Control To Agent'}
        </button>
        <div class={`status ${colorClass}`}>{statusText}</div>
      </div>
    </aside>
  );
}
