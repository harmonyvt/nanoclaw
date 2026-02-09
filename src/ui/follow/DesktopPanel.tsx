interface Props {
  liveViewUrl: string | null;
  vncPassword: string | null;
  sandboxRunning: boolean;
}

function buildNoVncUrl(liveViewUrl: string, vncPassword: string): string | null {
  try {
    const url = new URL('/novnc/vnc_lite.html', window.location.origin);
    url.searchParams.set('autoconnect', 'true');
    url.searchParams.set('resize', 'scale');
    url.searchParams.set('scale', 'true');
    url.searchParams.set('view_only', 'true');
    url.searchParams.set('password', vncPassword);
    return url.toString();
  } catch {
    return null;
  }
}

export function DesktopPanel({ liveViewUrl, vncPassword, sandboxRunning }: Props) {
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

  const noVncUrl = liveViewUrl && vncPassword
    ? buildNoVncUrl(liveViewUrl, vncPassword)
    : null;

  if (!noVncUrl) {
    return (
      <div class="follow-desktop">
        <div class="follow-desktop-empty">
          <div class="loading">Connecting to desktop viewer</div>
        </div>
      </div>
    );
  }

  return (
    <div class="follow-desktop">
      <iframe
        src={noVncUrl}
        class="follow-vnc-iframe"
        title="CUA Desktop Viewer"
      />
    </div>
  );
}
