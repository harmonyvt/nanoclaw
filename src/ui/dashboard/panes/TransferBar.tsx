import { useState, useCallback } from 'preact/hooks';
import { apiFetch } from '../../shared/api.js';
import { showToast } from './toast.js';

export interface FileClipboard {
  source: 'agent' | 'cua';
  path: string;
  name: string;
  group: string;
}

interface TransferBarProps {
  clipboard: FileClipboard;
  currentSource: 'agent' | 'cua';
  currentPath: string;
  currentGroup: string;
  onDone: () => void;
  onCancel: () => void;
}

export function TransferBar({
  clipboard,
  currentSource,
  currentPath,
  currentGroup,
  onDone,
  onCancel,
}: TransferBarProps) {
  const [transferring, setTransferring] = useState(false);

  const canTransfer = clipboard.source !== currentSource;

  const direction: 'cua-to-agent' | 'agent-to-cua' =
    clipboard.source === 'cua' ? 'cua-to-agent' : 'agent-to-cua';

  const targetLabel = currentSource === 'agent' ? `Agent (${currentGroup})` : 'CUA';

  const handleTransfer = useCallback(async () => {
    if (!canTransfer) {
      showToast('Switch to the other source to transfer', 'error');
      return;
    }

    setTransferring(true);
    try {
      const destPath =
        currentPath === '.' || currentPath === '/'
          ? clipboard.name
          : `${currentPath}/${clipboard.name}`;

      await apiFetch('/api/files/transfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          direction,
          sourcePath: clipboard.path,
          destPath,
          group: direction === 'cua-to-agent' ? currentGroup : clipboard.group,
        }),
      });

      showToast(`Transferred ${clipboard.name}`, 'ok');
      onDone();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Transfer failed';
      showToast(msg, 'error');
    } finally {
      setTransferring(false);
    }
  }, [clipboard, currentSource, currentPath, currentGroup, direction, canTransfer, onDone]);

  return (
    <div class="transfer-bar">
      <span class="t-info">
        {'\u{1F4CB}'} {clipboard.name}
        {canTransfer ? ` \u2192 ${targetLabel}` : ' (switch source to transfer)'}
      </span>
      {canTransfer && (
        <button
          class="t-btn t-btn-go"
          onClick={handleTransfer}
          disabled={transferring}
        >
          {transferring ? 'Transferring...' : 'Transfer Here'}
        </button>
      )}
      <button class="t-btn t-btn-cancel" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
