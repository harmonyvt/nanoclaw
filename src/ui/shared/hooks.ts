import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { authHeaders } from './api.js';

// ── useInterval ──────────────────────────────────────────────────────────

/**
 * Polling hook. Calls `callback` every `ms` milliseconds.
 * Pass `null` for `ms` to stop polling.
 */
export function useInterval(callback: () => void, ms: number | null): void {
  const savedCallback = useRef(callback);

  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    if (ms === null) return;
    const id = setInterval(() => savedCallback.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

// ── useSSE ───────────────────────────────────────────────────────────────

interface SSEState {
  connected: boolean;
  reconnect: () => void;
}

/**
 * SSE hook. Connects to an EventSource URL, auto-reconnects with backoff.
 */
export function useSSE(
  url: string,
  onMessage: (event: string, data: unknown) => void,
  enabled: boolean = true,
): SSEState {
  const [connected, setConnected] = useState(false);
  const onMessageRef = useRef(onMessage);
  const retriesRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  const connect = useCallback(() => {
    if (!enabled) return;

    // Build URL with auth token as query param
    const auth = authHeaders();
    const separator = url.includes('?') ? '&' : '?';
    const token = auth.Authorization?.replace('Bearer ', '');
    const fullUrl = token ? `${url}${separator}token=${encodeURIComponent(token)}` : url;

    const es = new EventSource(fullUrl);
    esRef.current = es;

    es.onopen = () => {
      setConnected(true);
      retriesRef.current = 0;
    };

    es.onerror = () => {
      setConnected(false);
      es.close();
      esRef.current = null;

      // Exponential backoff: 1s, 2s, 4s, 8s, max 30s
      const delay = Math.min(1000 * Math.pow(2, retriesRef.current), 30_000);
      retriesRef.current++;
      reconnectTimerRef.current = setTimeout(connect, delay);
    };

    // Listen for all named events
    es.addEventListener('log', (e) => {
      try {
        onMessageRef.current('log', JSON.parse((e as MessageEvent).data));
      } catch {
        // Ignore parse errors
      }
    });

    es.addEventListener('container', (e) => {
      try {
        onMessageRef.current('container', JSON.parse((e as MessageEvent).data));
      } catch {
        // Ignore parse errors
      }
    });

    es.addEventListener('task', (e) => {
      try {
        onMessageRef.current('task', JSON.parse((e as MessageEvent).data));
      } catch {
        // Ignore parse errors
      }
    });

    // Generic message event
    es.onmessage = (e) => {
      try {
        onMessageRef.current('message', JSON.parse(e.data));
      } catch {
        // Ignore parse errors
      }
    };
  }, [url, enabled]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      setConnected(false);
    };
  }, [connect]);

  const reconnect = useCallback(() => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    retriesRef.current = 0;
    connect();
  }, [connect]);

  return { connected, reconnect };
}

// ── Formatters ───────────────────────────────────────────────────────────

/**
 * Human-readable relative time: "2m ago", "3h ago", "just now".
 */
export function timeAgo(isoOrTimestamp: string | number): string {
  const ms =
    typeof isoOrTimestamp === 'number'
      ? isoOrTimestamp
      : new Date(isoOrTimestamp).getTime();
  const diff = Date.now() - ms;

  if (diff < 0) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/**
 * Format duration in ms: "1.2s", "45s", "2m 30s".
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.floor(sec % 60);
  return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`;
}

/**
 * Format byte count: "1.2KB", "3.4MB".
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

/**
 * Truncate string with ellipsis.
 */
export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '\u2026';
}
