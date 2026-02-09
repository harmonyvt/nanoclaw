import { useState, useCallback } from 'preact/hooks';
import { apiFetch } from '../../shared/api.js';
import type { StructuredLog } from '../../shared/types.js';

const LEVEL_NAMES: Record<number, string> = {
  10: 'TRACE',
  20: 'DEBUG',
  30: 'INFO',
  40: 'WARN',
  50: 'ERROR',
  60: 'FATAL',
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatFullTime(ts: number): string {
  return new Date(ts).toLocaleString('en-US', {
    hour12: false,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  } as Intl.DateTimeFormatOptions);
}

interface LogEntryExtra {
  [key: string]: unknown;
}

interface LogDetailData {
  extra?: LogEntryExtra;
  raw?: string;
  time?: number;
  module?: string;
  group_folder?: string;
}

interface LogEntryProps {
  log: StructuredLog & { extra?: LogEntryExtra };
}

export function LogEntry({ log }: LogEntryProps) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<LogDetailData | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  const level = log.level || 30;
  const levelName = LEVEL_NAMES[level] || 'LOG';
  const timeStr = formatTime(log.time);

  const handleClick = useCallback(() => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);

    // Already loaded
    if (detail !== null) return;

    // If we have extra data from SSE, use it inline
    if (log.extra && Object.keys(log.extra).length > 0) {
      setDetail({
        extra: log.extra,
        raw: log.raw,
        time: log.time,
        module: log.module,
        group_folder: log.group_folder,
      });
      return;
    }

    // Fetch from API
    if (log.id) {
      setDetailLoading(true);
      apiFetch<LogDetailData & { error?: string }>(`/api/logs/${log.id}`)
        .then((data) => {
          if ((data as any).error) {
            setDetailError((data as any).error);
          } else {
            setDetail({
              extra: data.extra || {},
              raw: data.raw || log.raw,
              time: data.time || log.time,
              module: data.module || log.module,
              group_folder: data.group_folder || log.group_folder,
            });
          }
        })
        .catch(() => {
          setDetailError('Failed to load');
        })
        .finally(() => {
          setDetailLoading(false);
        });
    } else {
      setDetail({ extra: {}, raw: log.raw });
    }
  }, [expanded, detail, log]);

  const extraKeys = detail?.extra ? Object.keys(detail.extra) : [];

  let prettyRaw = detail?.raw || '';
  if (prettyRaw) {
    try {
      prettyRaw = JSON.stringify(JSON.parse(prettyRaw), null, 2);
    } catch {
      // keep original
    }
  }

  return (
    <div class="log-wrapper">
      <div
        class={`log-entry${expanded ? ' expanded' : ''}`}
        onClick={handleClick}
      >
        <span class="log-expand-indicator">{'\u25B6'}</span>
        <span class="log-time mono">{timeStr}</span>
        <span class={`log-level log-level-${level}`}>{levelName}</span>
        {log.module && <span class="log-module mono">{log.module}</span>}
        {log.group_folder && (
          <span class="log-group mono">{log.group_folder}</span>
        )}
        <span class="log-msg mono">{log.msg}</span>
      </div>
      <div class={`log-detail${expanded ? ' show' : ''}`}>
        {detailLoading && (
          <span style={{ color: 'var(--muted)' }}>Loading...</span>
        )}
        {detailError && (
          <span style={{ color: 'var(--danger)' }}>{detailError}</span>
        )}
        {detail && !detailLoading && !detailError && (
          <>
            <div class="log-detail-row">
              <span class="log-detail-key">Time</span>
              <span class="log-detail-val">
                {formatFullTime(detail.time || log.time)}
              </span>
            </div>
            {(detail.group_folder || log.group_folder) && (
              <div class="log-detail-row">
                <span class="log-detail-key">Group</span>
                <span class="log-detail-val">
                  {detail.group_folder || log.group_folder}
                </span>
              </div>
            )}
            {(detail.module || log.module) && (
              <div class="log-detail-row">
                <span class="log-detail-key">Module</span>
                <span class="log-detail-val">
                  {detail.module || log.module}
                </span>
              </div>
            )}
            {extraKeys.map((key) => {
              const val = detail.extra![key];
              let display: preact.JSX.Element;
              if (val === null || val === undefined) {
                display = (
                  <span class="log-detail-val muted">null</span>
                );
              } else if (typeof val === 'object') {
                display = (
                  <span class="log-detail-val mono">
                    {JSON.stringify(val, null, 2)}
                  </span>
                );
              } else {
                display = (
                  <span class="log-detail-val">{String(val)}</span>
                );
              }
              return (
                <div class="log-detail-row" key={key}>
                  <span class="log-detail-key">{key}</span>
                  {display}
                </div>
              );
            })}
            {prettyRaw && (
              <>
                <button
                  class="log-detail-toggle"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowRaw(!showRaw);
                  }}
                >
                  {showRaw ? 'Hide raw JSON' : 'Show raw JSON'}
                </button>
                {showRaw && (
                  <div class="log-detail-raw">{prettyRaw}</div>
                )}
              </>
            )}
            {!prettyRaw && extraKeys.length === 0 && (
              <div style={{ color: 'var(--muted)', fontStyle: 'italic' }}>
                No additional context
              </div>
            )}
          </>
        )}
        {!detail && !detailLoading && !detailError && expanded && (
          <span style={{ color: 'var(--muted)' }}>
            No additional detail available
          </span>
        )}
      </div>
    </div>
  );
}
