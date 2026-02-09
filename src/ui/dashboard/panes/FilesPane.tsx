import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { apiFetch } from '../../shared/api.js';
import type { FileEntry } from '../../shared/types.js';
import { FileBrowser } from './FileBrowser.js';
import { FilePreviewModal } from './FilePreviewModal.js';
import { TransferBar, type FileClipboard } from './TransferBar.js';
import { showToast } from './toast.js';

// ── Types ──────────────────────────────────────────────────────────────

interface GroupInfo {
  name: string;
  size: number;
}

type FilesSource = 'agent' | 'cua';

// ── FilesPane ──────────────────────────────────────────────────────────

export function FilesPane() {
  // Source toggle
  const [filesSource, setFilesSource] = useState<FilesSource>('agent');

  // Agent state
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const [filesGroup, setFilesGroup] = useState('');
  const [filesPath, setFilesPath] = useState('.');

  // CUA state
  const [cuaPath, setCuaPath] = useState('/root');
  const [cuaRunning, setCuaRunning] = useState(false);
  const [cuaStarting, setCuaStarting] = useState(false);

  // Shared state
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Search
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clipboard for transfer
  const [clipboard, setClipboard] = useState<FileClipboard | null>(null);

  // Preview modal
  const [previewFile, setPreviewFile] = useState<FileEntry | null>(null);

  // Upload ref
  const uploadRef = useRef<HTMLInputElement>(null);

  // ── Load groups on mount ───────────────────────────────────────────

  useEffect(() => {
    apiFetch<GroupInfo[]>('/api/files/groups')
      .then((data) => {
        setGroups(data);
        if (data.length > 0 && !filesGroup) {
          setFilesGroup(data[0].name);
        }
      })
      .catch(() => {
        // Groups load silently fails
      });
  }, []);

  // ── Check CUA status when switching to CUA ─────────────────────────

  useEffect(() => {
    if (filesSource !== 'cua') return;
    apiFetch<{ running: boolean }>('/api/files/cua/status')
      .then((data) => setCuaRunning(data.running))
      .catch(() => setCuaRunning(false));
  }, [filesSource]);

  // ── Load files when source/group/path changes ──────────────────────

  useEffect(() => {
    if (filesSource === 'agent' && !filesGroup) return;
    if (filesSource === 'cua' && !cuaRunning) return;

    loadFiles();
  }, [filesSource, filesGroup, filesPath, cuaPath, cuaRunning]);

  // ── Search debounce ────────────────────────────────────────────────

  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);

    if (!searchQuery.trim()) {
      // Reload normal listing when search cleared
      if (filesSource === 'agent' && filesGroup) loadFiles();
      else if (filesSource === 'cua' && cuaRunning) loadFiles();
      return;
    }

    searchTimerRef.current = setTimeout(() => {
      performSearch(searchQuery.trim());
    }, 300);

    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [searchQuery]);

  // ── File loading ───────────────────────────────────────────────────

  const loadFiles = useCallback(() => {
    setLoading(true);
    setError(null);

    let url: string;
    if (filesSource === 'agent') {
      const params = new URLSearchParams({ group: filesGroup, path: filesPath });
      url = `/api/files/agent/list?${params}`;
    } else {
      const params = new URLSearchParams({ path: cuaPath });
      url = `/api/files/cua/list?${params}`;
    }

    apiFetch<FileEntry[]>(url)
      .then((data) => {
        setFiles(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err?.message || 'Failed to load files');
        setFiles([]);
        setLoading(false);
      });
  }, [filesSource, filesGroup, filesPath, cuaPath]);

  // ── Search ─────────────────────────────────────────────────────────

  const performSearch = useCallback(
    (query: string) => {
      setLoading(true);
      setError(null);

      let url: string;
      if (filesSource === 'agent') {
        const params = new URLSearchParams({ group: filesGroup, q: query });
        url = `/api/files/agent/search?${params}`;
      } else {
        const params = new URLSearchParams({ path: cuaPath, q: query });
        url = `/api/files/cua/search?${params}`;
      }

      apiFetch<FileEntry[]>(url)
        .then((data) => {
          setFiles(data);
          setLoading(false);
        })
        .catch((err) => {
          setError(err?.message || 'Search failed');
          setFiles([]);
          setLoading(false);
        });
    },
    [filesSource, filesGroup, cuaPath],
  );

  // ── Navigation ─────────────────────────────────────────────────────

  const handleNavigate = useCallback(
    (newPath: string) => {
      setSearchQuery('');
      if (filesSource === 'agent') {
        setFilesPath(newPath);
      } else {
        setCuaPath(newPath);
      }
    },
    [filesSource],
  );

  // ── Source toggle ──────────────────────────────────────────────────

  const handleSourceSwitch = useCallback((source: FilesSource) => {
    setFilesSource(source);
    setSearchQuery('');
  }, []);

  // ── CUA start ──────────────────────────────────────────────────────

  const handleCuaStart = useCallback(async () => {
    setCuaStarting(true);
    try {
      await apiFetch('/api/files/cua/start', { method: 'POST' });
      setCuaRunning(true);
      showToast('CUA Sandbox started', 'ok');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to start sandbox';
      showToast(msg, 'error');
    } finally {
      setCuaStarting(false);
    }
  }, []);

  // ── Delete ─────────────────────────────────────────────────────────

  const handleDelete = useCallback(
    async (file: FileEntry) => {
      if (!window.confirm(`Delete "${file.name}"?`)) return;

      try {
        if (filesSource === 'agent') {
          await apiFetch('/api/files/agent/delete', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ group: filesGroup, path: file.path }),
          });
        } else {
          await apiFetch('/api/files/cua/delete', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: file.path }),
          });
        }
        showToast(`Deleted ${file.name}`, 'ok');
        loadFiles();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Delete failed';
        showToast(msg, 'error');
      }
    },
    [filesSource, filesGroup, loadFiles],
  );

  // ── Mkdir ──────────────────────────────────────────────────────────

  const handleMkdir = useCallback(async () => {
    const name = window.prompt('New folder name:');
    if (!name || !name.trim()) return;

    try {
      if (filesSource === 'agent') {
        const fullPath = filesPath === '.' ? name.trim() : `${filesPath}/${name.trim()}`;
        await apiFetch('/api/files/agent/mkdir', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ group: filesGroup, path: fullPath }),
        });
      } else {
        const base = cuaPath === '/' ? '' : cuaPath;
        await apiFetch('/api/files/cua/mkdir', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: `${base}/${name.trim()}` }),
        });
      }
      showToast(`Created folder ${name.trim()}`, 'ok');
      loadFiles();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to create folder';
      showToast(msg, 'error');
    }
  }, [filesSource, filesGroup, filesPath, cuaPath, loadFiles]);

  // ── Upload ─────────────────────────────────────────────────────────

  const handleUploadClick = useCallback(() => {
    uploadRef.current?.click();
  }, []);

  const handleUploadChange = useCallback(
    async (e: Event) => {
      const input = e.target as HTMLInputElement;
      const fileList = input.files;
      if (!fileList || fileList.length === 0) return;

      for (let i = 0; i < fileList.length; i++) {
        const file = fileList[i];
        const formData = new FormData();

        if (filesSource === 'agent') {
          formData.append('group', filesGroup);
          formData.append('path', filesPath === '.' ? '' : filesPath);
          formData.append('file', file);

          try {
            await apiFetch('/api/files/agent/upload', {
              method: 'POST',
              body: formData,
            });
            showToast(`Uploaded ${file.name}`, 'ok');
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'Upload failed';
            showToast(`${file.name}: ${msg}`, 'error');
          }
        } else {
          formData.append('path', cuaPath);
          formData.append('file', file);

          try {
            await apiFetch('/api/files/cua/upload', {
              method: 'POST',
              body: formData,
            });
            showToast(`Uploaded ${file.name}`, 'ok');
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'Upload failed';
            showToast(`${file.name}: ${msg}`, 'error');
          }
        }
      }

      // Reset input so same file can be uploaded again
      input.value = '';
      loadFiles();
    },
    [filesSource, filesGroup, filesPath, cuaPath, loadFiles],
  );

  // ── Transfer done/cancel ───────────────────────────────────────────

  const handleTransferDone = useCallback(() => {
    setClipboard(null);
    loadFiles();
  }, [loadFiles]);

  const handleTransferCancel = useCallback(() => {
    setClipboard(null);
  }, []);

  // ── Preview ────────────────────────────────────────────────────────

  const handlePreview = useCallback((file: FileEntry) => {
    setPreviewFile(file);
  }, []);

  const handlePreviewClose = useCallback(() => {
    setPreviewFile(null);
  }, []);

  // ── Render ─────────────────────────────────────────────────────────

  const currentPath = filesSource === 'agent' ? filesPath : cuaPath;

  return (
    <div class="pane active">
      {/* Header: source toggle + actions */}
      <div class="files-header">
        <div class="source-toggle">
          <button
            class={`source-btn ${filesSource === 'agent' ? 'active' : ''}`}
            onClick={() => handleSourceSwitch('agent')}
          >
            Agent
          </button>
          <button
            class={`source-btn ${filesSource === 'cua' ? 'active' : ''}`}
            onClick={() => handleSourceSwitch('cua')}
          >
            CUA <span class={`sdot ${cuaRunning ? 'on' : 'off'}`} />
          </button>
        </div>
        <div class="files-actions">
          <button
            class="files-action-btn"
            onClick={() => setShowSearch((v) => !v)}
            title="Search"
          >
            {'\uD83D\uDD0D'}
          </button>
          <button class="files-action-btn" onClick={handleMkdir} title="New folder">
            {'\uD83D\uDCC1+'}
          </button>
          <button class="files-action-btn" onClick={handleUploadClick} title="Upload">
            {'\u2B06'}
          </button>
        </div>
      </div>

      {/* Group selector (agent mode only) */}
      {filesSource === 'agent' && (
        <div class="files-group-bar">
          <label>Group</label>
          <select
            value={filesGroup}
            onChange={(e) => {
              setFilesGroup((e.target as HTMLSelectElement).value);
              setFilesPath('.');
              setSearchQuery('');
            }}
          >
            {groups.map((g) => (
              <option key={g.name} value={g.name}>
                {g.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Search bar (toggled) */}
      {showSearch && (
        <div class="files-search-bar">
          <input
            type="text"
            placeholder="Search files..."
            value={searchQuery}
            onInput={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
          />
        </div>
      )}

      {/* CUA offline state */}
      {filesSource === 'cua' && !cuaRunning ? (
        <div class="cua-offline">
          <p>CUA Sandbox is not running</p>
          <button
            class="cua-start-btn"
            onClick={handleCuaStart}
            disabled={cuaStarting}
          >
            {cuaStarting ? 'Starting...' : 'Start Sandbox'}
          </button>
        </div>
      ) : (
        <>
          {/* Loading / error / file list */}
          {loading ? (
            <div class="empty" style={{ padding: '40px 20px' }}>
              Loading files...
            </div>
          ) : error ? (
            <div class="empty" style={{ padding: '40px 20px' }}>
              {error}
            </div>
          ) : (
            <FileBrowser
              source={filesSource}
              group={filesGroup}
              path={currentPath}
              files={files}
              onNavigate={handleNavigate}
              onPreview={handlePreview}
              onDelete={handleDelete}
              onSetClipboard={setClipboard}
            />
          )}
        </>
      )}

      {/* Transfer bar */}
      {clipboard && (
        <TransferBar
          clipboard={clipboard}
          currentSource={filesSource}
          currentPath={currentPath}
          currentGroup={filesGroup}
          onDone={handleTransferDone}
          onCancel={handleTransferCancel}
        />
      )}

      {/* Hidden upload input */}
      <input
        ref={uploadRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={handleUploadChange}
      />

      {/* Preview modal */}
      {previewFile && (
        <FilePreviewModal
          source={filesSource}
          group={filesGroup}
          filePath={previewFile.path}
          fileName={previewFile.name}
          fileSize={previewFile.size}
          fileModified={previewFile.modified}
          onClose={handlePreviewClose}
        />
      )}
    </div>
  );
}
