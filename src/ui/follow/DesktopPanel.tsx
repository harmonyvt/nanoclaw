interface Props {
  sandboxRunning: boolean;
}

/** noVNC follow page — password is injected server-side, never sent to client */
const NOVNC_FOLLOW_URL = '/novnc/follow';

export function DesktopPanel({ sandboxRunning }: Props) {
  if (!sandboxRunning) {
    return (
      <div class="follow-desktop">
        <div class="follow-desktop-empty">
          <svg viewBox="0 0 24 24" width="48" height="48" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
          </svg>
          <h3>Sandbox Not Running</h3>
          <p>The CUA browser sandbox will appear here when an agent starts a browse session.</p>
        </div>
      </div>
    );
  }

  return (
    <div class="follow-desktop">
      <iframe
        src={NOVNC_FOLLOW_URL}
        class="follow-vnc-iframe"
        title="CUA Desktop Viewer"
      />
    </div>
  );
}
