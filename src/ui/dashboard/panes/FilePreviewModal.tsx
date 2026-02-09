import { useState, useEffect, useCallback } from 'preact/hooks';
import { apiFetch, getAuthToken } from '../../shared/api.js';
import { formatBytes, timeAgo } from '../../shared/hooks.js';

interface FileInfo {
  name: string;
  type: string;
  size: number;
  modified: string;
  mimeType?: string;
  isProtected?: boolean;
  isPreviewable?: boolean;
  preview?: string;
}

interface FilePreviewModalProps {
  source: 'agent' | 'cua';
  group: string;
  filePath: string;
  fileName: string;
  fileSize: number;
  fileModified: string;
  onClose: () => void;
}

export function FilePreviewModal({
  source,
  group,
  filePath,
  fileName,
  fileSize,
  fileModified,
  onClose,
}: FilePreviewModalProps) {
  const [info, setInfo] = useState<FileInfo | null>(null);
  const [loading, setLoading] = useState(source === 'agent');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (source !== 'agent') return;

    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ group, path: filePath });
    apiFetch<FileInfo>(`/api/files/agent/info?${params}`)
      .then((data) => {
        setInfo(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err?.message || 'Failed to load file info');
        setLoading(false);
      });
  }, [source, group, filePath]);

  const handleBackdropClick = useCallback(
    (e: MouseEvent) => {
      if ((e.target as HTMLElement).classList.contains('file-preview-modal')) {
        onClose();
      }
    },
    [onClose],
  );

  const handleDownload = useCallback(() => {
    const token = getAuthToken();
    let url: string;
    if (source === 'agent') {
      const params = new URLSearchParams({ group, path: filePath });
      if (token) params.set('token', token);
      url = `/api/files/agent/download?${params}`;
    } else {
      const params = new URLSearchParams({ path: filePath });
      if (token) params.set('token', token);
      url = `/api/files/cua/download?${params}`;
    }
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [source, group, filePath, fileName]);

  const renderContent = () => {
    if (source === 'cua') {
      return (
        <div class="pv-info">
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>{'\uD83D\uDCC4'}</div>
          <div style={{ fontSize: '16px', fontWeight: 500, marginBottom: '8px' }}>{fileName}</div>
          <div>{formatBytes(fileSize)}</div>
          <div style={{ marginTop: '4px' }}>{timeAgo(fileModified)}</div>
        </div>
      );
    }

    if (loading) {
      return <div class="pv-info">Loading preview...</div>;
    }

    if (error) {
      return <div class="pv-info">Error: {error}</div>;
    }

    if (info && info.isPreviewable && info.preview) {
      if (info.preview.startsWith('data:image')) {
        return <img src={info.preview} alt={info.name} />;
      }
      return <pre>{info.preview}</pre>;
    }

    // Generic file info
    const displayInfo = info || { name: fileName, size: fileSize, modified: fileModified };
    return (
      <div class="pv-info">
        <div style={{ fontSize: '48px', marginBottom: '16px' }}>{'\uD83D\uDCC4'}</div>
        <div style={{ fontSize: '16px', fontWeight: 500, marginBottom: '8px' }}>
          {displayInfo.name}
        </div>
        <div>{formatBytes(displayInfo.size)}</div>
        <div style={{ marginTop: '4px' }}>{timeAgo(displayInfo.modified)}</div>
        {info?.mimeType && (
          <div style={{ marginTop: '4px', color: 'var(--accent)' }}>{info.mimeType}</div>
        )}
      </div>
    );
  };

  return (
    <div class="file-preview-modal" onClick={handleBackdropClick}>
      <div class="preview-header">
        <span class="pv-name">{fileName}</span>
        <div class="pv-actions">
          <button class="pv-btn pv-btn-dl" onClick={handleDownload}>
            Download
          </button>
          <button class="pv-btn pv-btn-close" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <div class="preview-content">{renderContent()}</div>
    </div>
  );
}
