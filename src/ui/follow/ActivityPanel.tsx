import { useState, useRef, useEffect, useCallback } from 'preact/hooks';
import type { CuaActivityEvent } from '../shared/types.js';
import { ActivityEntry } from './ActivityEntry.js';

interface Props {
  activities: CuaActivityEvent[];
  connected: boolean;
}

export function ActivityPanel({ activities, connected }: Props) {
  const feedRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

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
    </div>
  );
}
