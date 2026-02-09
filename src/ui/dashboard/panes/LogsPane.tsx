import { useState, useRef, useCallback, useEffect } from 'preact/hooks';
import { useSSE } from '../../shared/hooks.js';
import { apiFetch } from '../../shared/api.js';
import type { StructuredLog } from '../../shared/types.js';
import { LogEntry } from './LogEntry.js';
import { LogFilters, type LogFilterValues } from './LogFilters.js';

const MAX_LOG_ENTRIES = 2000;

interface LogsPaneProps {
  onConnectionChange: (connected: boolean, reconnect: () => void) => void;
}

export function LogsPane({ onConnectionChange }: LogsPaneProps) {
  const [logs, setLogs] = useState<Array<StructuredLog & { extra?: Record<string, unknown> }>>([]);
  const [isSearchMode, setIsSearchMode] = useState(false);
  const [searchResults, setSearchResults] = useState<Array<StructuredLog & { extra?: Record<string, unknown> }> | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  const autoScrollRef = useRef(true);
  const lastLogIdRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // SSE message handler
  const handleSSEMessage = useCallback(
    (event: string, data: unknown) => {
      if (event !== 'log') return;
      const log = data as StructuredLog & { extra?: Record<string, unknown> };
      if (log.id > lastLogIdRef.current) {
        lastLogIdRef.current = log.id;
      }
      if (!isSearchMode) {
        setLogs((prev) => {
          const next = [...prev, log];
          if (next.length > MAX_LOG_ENTRIES) {
            return next.slice(next.length - MAX_LOG_ENTRIES);
          }
          return next;
        });
      }
    },
    [isSearchMode],
  );

  const { connected, reconnect } = useSSE(
    `/api/logs/stream?afterId=${lastLogIdRef.current}`,
    handleSSEMessage,
    true,
  );

  // Notify parent of connection state changes
  useEffect(() => {
    onConnectionChange(connected, reconnect);
  }, [connected, reconnect, onConnectionChange]);

  // Auto-scroll when new logs arrive
  useEffect(() => {
    if (autoScrollRef.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs]);

  // Scroll event handler for auto-scroll detection
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    autoScrollRef.current = atBottom;
    setShowScrollBtn(!atBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    autoScrollRef.current = true;
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
    setShowScrollBtn(false);
  }, []);

  // Filter change handler
  const handleFiltersChange = useCallback((filters: LogFilterValues) => {
    const { level, search, group } = filters;
    const hasFilters = !!(level || search || group);

    if (!hasFilters) {
      setIsSearchMode(false);
      setSearchResults(null);
      setSearchError(null);
      return;
    }

    setIsSearchMode(true);
    setSearchLoading(true);
    setSearchError(null);

    const params = new URLSearchParams();
    if (level) params.set('level', level);
    if (search) params.set('search', search);
    if (group) params.set('group', group);
    params.set('limit', '200');

    apiFetch<Array<StructuredLog & { extra?: Record<string, unknown> }>>(
      `/api/logs?${params.toString()}`,
    )
      .then((results) => {
        // API returns newest first, reverse for display
        setSearchResults(results.reverse());
        setSearchLoading(false);
      })
      .catch(() => {
        setSearchError('Search failed');
        setSearchLoading(false);
      });
  }, []);

  const displayLogs = isSearchMode ? searchResults : logs;

  return (
    <>
      <LogFilters
        onFiltersChange={handleFiltersChange}
        isSearchMode={isSearchMode}
      />
      <div class="pane active">
        <div
          class="log-container"
          ref={containerRef}
          onScroll={handleScroll}
        >
          {searchLoading && (
            <div class="loading">Searching...</div>
          )}
          {searchError && (
            <div class="empty">{searchError}</div>
          )}
          {!searchLoading && !searchError && displayLogs && displayLogs.length === 0 && (
            <div class="empty">
              {isSearchMode ? 'No matching logs found' : 'Waiting for logs...'}
            </div>
          )}
          {!searchLoading &&
            !searchError &&
            displayLogs &&
            displayLogs.map((log) => (
              <LogEntry key={log.id} log={log} />
            ))}
        </div>
      </div>
      <button
        class={`scroll-btn${showScrollBtn ? ' show' : ''}`}
        onClick={scrollToBottom}
      >
        {'\u2193'}
      </button>
    </>
  );
}
