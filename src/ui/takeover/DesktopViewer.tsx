interface Props {
  liveViewUrl?: string | null;
  vncPassword?: string | null;
}

function buildDirectNoVncUrl(
  liveViewUrl: string,
  vncPassword: string,
): string | null {
  try {
    const noVncUrl = new URL('/vnc_lite.html', liveViewUrl);
    noVncUrl.searchParams.set('autoconnect', 'true');
    noVncUrl.searchParams.set('resize', 'scale');
    noVncUrl.searchParams.set('scale', 'true');
    noVncUrl.searchParams.set('password', vncPassword);
    return noVncUrl.toString();
  } catch {
    return null;
  }
}

export function DesktopViewer({ liveViewUrl, vncPassword }: Props) {
  if (!liveViewUrl) {
    return (
      <div class="fallback">
        Sandbox live view is currently unavailable. Keep this page open and try
        again, or request a new handoff link from chat.
      </div>
    );
  }

  if (!vncPassword) {
    return (
      <div class="fallback">
        Preparing secure desktop link. Please wait a few seconds for password
        rotation to complete.
      </div>
    );
  }

  const noVncUrl = buildDirectNoVncUrl(liveViewUrl, vncPassword);
  if (!noVncUrl) {
    return (
      <div class="fallback">
        Could not build the direct noVNC URL. Request a new handoff link from
        chat.
      </div>
    );
  }

  return (
    <div class="fallback">
      Embedded noVNC is disabled in this view.
      <a
        class="btn btn-link open-desktop-btn"
        href={noVncUrl}
        target="_blank"
        rel="noopener noreferrer"
      >
        Open Live Desktop (noVNC)
      </a>
    </div>
  );
}
