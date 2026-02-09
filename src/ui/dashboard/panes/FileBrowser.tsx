import { useCallback } from 'preact/hooks';
import type { FileEntry } from '../../shared/types.js';
import { formatBytes, timeAgo } from '../../shared/hooks.js';
import { getAuthToken } from '../../shared/api.js';
import { showToast } from './toast.js';
import type { FileClipboard } from './TransferBar.js';

// ── File icon mapping ──────────────────────────────────────────────────

const FILE_ICONS: Record<string, string> = {
  directory: '\uD83D\uDCC1',
  image: '\uD83D\uDDBC',
  video: '\uD83C\uDFA5',
  audio: '\uD83C\uDFB5',
  pdf: '\uD83D\uDCC4',
  archive: '\uD83D\uDCE6',
  code: '\uD83D\uDCBB',
  text: '\uD83D\uDCC3',
  markdown: '\uD83D\uDCDD',
  default: '\uD83D\uDCC4',
};

function getFileIcon(name: string, type: string): string {
  if (type === 'directory') return FILE_ICONS.directory;
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext))
    return FILE_ICONS.image;
  if (['mp4', 'mov', 'avi', 'webm', 'mkv'].includes(ext)) return FILE_ICONS.video;
  if (['mp3', 'ogg', 'wav', 'flac', 'm4a'].includes(ext)) return FILE_ICONS.audio;
  if (ext === 'pdf') return FILE_ICONS.pdf;
  if (['zip', 'tar', 'gz', '7z', 'rar', 'bz2', 'tgz'].includes(ext))
    return FILE_ICONS.archive;
  if (
    ['ts', 'js', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'sh', 'rb', 'swift', 'jsx', 'tsx'].includes(ext)
  )
    return FILE_ICONS.code;
  if (['md', 'markdown'].includes(ext)) return FILE_ICONS.markdown;
  if (
    ['txt', 'log', 'csv', 'json', 'yaml', 'yml', 'xml', 'html', 'css', 'ini', 'conf', 'toml', 'env'].includes(ext)
  )
    return FILE_ICONS.text;
  return FILE_ICONS.default;
}

// ── Protected file check ───────────────────────────────────────────────

const PROTECTED_FILES = ['CLAUDE.md', 'SOUL.md'];

function isProtected(name: string): boolean {
  return PROTECTED_FILES.includes(name);
}

// ── Breadcrumb ─────────────────────────────────────────────────────────

interface BreadcrumbProps {
  source: 'agent' | 'cua';
  group: string;
  path: string;
  onNavigate: (path: string) => void;
}

function Breadcrumb({ source, group, path, onNavigate }: BreadcrumbProps) {
  const rootLabel = source === 'agent' ? group : '/';
  const rootPath = source === 'agent' ? '.' : '/';

  const segments: string[] = [];
  if (path !== rootPath && path !== '' && path !== '.') {
    const normalized = path.startsWith('/') ? path.slice(1) : path;
    if (normalized) {
      segments.push(...normalized.split('/').filter(Boolean));
    }
  }

  const handleSegmentClick = (idx: number) => {
    if (source === 'agent') {
      const newPath = segments.slice(0, idx + 1).join('/');
      onNavigate(newPath || '.');
    } else {
      const newPath = '/' + segments.slice(0, idx + 1).join('/');
      onNavigate(newPath);
    }
  };

  return (
    <div class="breadcrumb">
      {segments.length > 0 ? (
        <span class="bc-seg" onClick={() => onNavigate(rootPath)}>
          {rootLabel}
        </span>
      ) : (
        <span class="bc-current">{rootLabel}</span>
      )}
      {segments.map((seg, idx) => {
        const isLast = idx === segments.length - 1;
        return (
          <span key={idx}>
            <span class="bc-sep">/</span>
            {isLast ? (
              <span class="bc-current">{seg}</span>
            ) : (
              <span class="bc-seg" onClick={() => handleSegmentClick(idx)}>
                {seg}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

// ── FileBrowser ─────────────────────────────────────────────────────────

interface FileBrowserProps {
  source: 'agent' | 'cua';
  group: string;
  path: string;
  files: FileEntry[];
  onNavigate: (path: string) => void;
  onPreview: (file: FileEntry) => void;
  onDelete: (file: FileEntry) => void;
  onSetClipboard: (clip: FileClipboard) => void;
}

export function FileBrowser({
  source,
  group,
  path,
  files,
  onNavigate,
  onPreview,
  onDelete,
  onSetClipboard,
}: FileBrowserProps) {
  const handleFileClick = useCallback(
    (file: FileEntry) => {
      if (file.type === 'directory') {
        if (source === 'agent') {
          const newPath = path === '.' ? file.name : `${path}/${file.name}`;
          onNavigate(newPath);
        } else {
          const base = path === '/' ? '' : path;
          onNavigate(`${base}/${file.name}`);
        }
      } else {
        onPreview(file);
      }
    },
    [source, path, onNavigate, onPreview],
  );

  const handleDownload = useCallback(
    (e: Event, file: FileEntry) => {
      e.stopPropagation();
      const token = getAuthToken();
      let url: string;
      if (source === 'agent') {
        const params = new URLSearchParams({ group, path: file.path });
        if (token) params.set('token', token);
        url = `/api/files/agent/download?${params}`;
      } else {
        const params = new URLSearchParams({ path: file.path });
        if (token) params.set('token', token);
        url = `/api/files/cua/download?${params}`;
      }
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    },
    [source, group],
  );

  const handleTransfer = useCallback(
    (e: Event, file: FileEntry) => {
      e.stopPropagation();
      onSetClipboard({
        source,
        path: file.path,
        name: file.name,
        group,
      });
      const targetSource = source === 'agent' ? 'CUA' : 'Agent';
      showToast(`Switch to ${targetSource} and navigate to the target folder`, 'ok');
    },
    [source, group, onSetClipboard],
  );

  const handleDelete = useCallback(
    (e: Event, file: FileEntry) => {
      e.stopPropagation();
      onDelete(file);
    },
    [onDelete],
  );

  return (
    <>
      <Breadcrumb source={source} group={group} path={path} onNavigate={onNavigate} />
      <div class="file-list">
        {files.length === 0 && (
          <div class="empty" style={{ padding: '40px 20px' }}>
            Empty directory
          </div>
        )}
        {files.map((file) => {
          const icon = getFileIcon(file.name, file.type);
          const prot = isProtected(file.name);
          const isDir = file.type === 'directory';

          return (
            <div
              class="file-item"
              key={file.path}
              onClick={() => handleFileClick(file)}
            >
              <span class="file-icon">{icon}</span>
              <div class="file-info">
                <div class="file-name">
                  {file.name}
                  {prot && <span class="protected-badge">{'\uD83D\uDD12'}</span>}
                </div>
                <div class="file-meta">
                  {isDir ? 'Directory' : formatBytes(file.size)}
                  {file.modified ? ` \u00B7 ${timeAgo(file.modified)}` : ''}
                </div>
              </div>
              {!isDir && (
                <div class="file-actions">
                  <button
                    class="fa-btn"
                    title="Download"
                    onClick={(e: Event) => handleDownload(e, file)}
                  >
                    {'\u2B07'}
                  </button>
                  <button
                    class="fa-btn"
                    title="Transfer"
                    onClick={(e: Event) => handleTransfer(e, file)}
                  >
                    {'\u21C4'}
                  </button>
                  {!prot && (
                    <button
                      class="fa-btn danger"
                      title="Delete"
                      onClick={(e: Event) => handleDelete(e, file)}
                    >
                      {'\u2715'}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
