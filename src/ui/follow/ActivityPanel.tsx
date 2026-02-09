import { useState, useRef, useEffect, useCallback } from 'preact/hooks';
import { apiFetch } from '../shared/api.js';
import type { CuaActivityEvent } from '../shared/types.js';
import { ActivityEntry } from './ActivityEntry.js';

interface Props {
  activities: CuaActivityEvent[];
  connected: boolean;
  groupFolder: string;
}

export function ActivityPanel({ activities, connected, groupFolder }: Props) {
  const feedRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [messageText, setMessageText] = useState('');
  const [sending, setSending] = useState(false);

  // Auto-scroll to bottom when new activities arrive
  useEffect(() => {
    if (autoScroll && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [activities.length, autoScroll]);

  // Detect if user scrolled away from bottom
  const handleScroll = useCallback(() => {
    if (!feedRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = feedRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 40;
    setAutoScroll(atBottom);
  }, []);

  const handleSend = useCallback(async () => {
    const text = messageText.trim();
    if (!text || sending) return;

    setSending(true);
    try {
      await apiFetch('/api/cua/follow/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, groupFolder }),
      });
      setMessageText('');
    } catch {
      // Show error state briefly
    } finally {
      setSending(false);
    }
  }, [messageText, sending, groupFolder]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div class="follow-activity">
      {/* Header */}
      <div class="follow-activity-header">
        <div class="follow-activity-header-left">
          <span class={`follow-status-dot ${connected ? 'follow-status-dot-ok' : ''}`} />
          <span class="follow-activity-title">CUA Activity</span>
        </div>
        <span class="follow-activity-count">{activities.length} events</span>
      </div>

      {/* Feed */}
      <div class="follow-feed" ref={feedRef} onScroll={handleScroll}>
        {activities.length === 0 ? (
          <div class="empty">
            Waiting for CUA activity...
          </div>
        ) : (
          activities.map((activity) => (
            <ActivityEntry key={activity.id} event={activity} />
          ))
        )}
        {!autoScroll && activities.length > 0 && (
          <button
            class="follow-scroll-btn"
            onClick={() => {
              setAutoScroll(true);
              if (feedRef.current) {
                feedRef.current.scrollTop = feedRef.current.scrollHeight;
              }
            }}
          >
            Scroll to bottom
          </button>
        )}
      </div>

      {/* Message Input */}
      <div class="follow-message-bar">
        <input
          type="text"
          class="follow-message-input"
          placeholder="Send a message to the agent..."
          value={messageText}
          onInput={(e) => setMessageText((e.target as HTMLInputElement).value)}
          onKeyDown={handleKeyDown}
          disabled={sending}
        />
        <button
          class="btn btn-primary follow-send-btn"
          onClick={handleSend}
          disabled={sending || !messageText.trim()}
        >
          {sending ? (
            <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" fill="none" stroke-width="2" class="follow-spin">
              <circle cx="12" cy="12" r="10" stroke-dasharray="50" stroke-dashoffset="10" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}
