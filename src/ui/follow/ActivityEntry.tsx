import type { CuaActivityEvent } from '../shared/types.js';
import { formatTime, formatActivityDuration, actionIcon, ActionIcon } from '../shared/activity-icons.js';

interface Props {
  event: CuaActivityEvent;
}

export function ActivityEntry({ event }: Props) {
  const isStart = event.phase === 'start';
  const isError = event.status === 'error';
  const iconType = actionIcon(event.action);

  return (
    <div class={`follow-entry ${isStart ? 'follow-entry-start' : ''} ${isError ? 'follow-entry-error' : ''}`}>
      <span class="follow-entry-time mono">{formatTime(event.timestamp)}</span>
      <span class={`follow-entry-phase ${isStart ? 'follow-phase-start' : isError ? 'follow-phase-error' : 'follow-phase-ok'}`} />
      <span class="follow-entry-icon">
        <ActionIcon type={iconType} />
      </span>
      <span class="follow-entry-action">{event.action}</span>
      <span class="follow-entry-desc">{event.description}</span>
      {!isStart && event.durationMs != null && (
        <span class="follow-entry-duration badge">{formatActivityDuration(event.durationMs)}</span>
      )}
      {isError && event.error && (
        <span class="follow-entry-error-text" title={event.error}>
          {event.error.length > 60 ? event.error.slice(0, 59) + '\u2026' : event.error}
        </span>
      )}
    </div>
  );
}
