interface Props {
  available: boolean;
}

export function DesktopViewer({ available }: Props) {
  if (!available) {
    return (
      <div class="fallback">
        Sandbox live view is currently unavailable. Keep this page open and try
        again, or request a new handoff link from chat.
      </div>
    );
  }

  return (
    <iframe
      class="workspace-frame"
      src="/novnc/vnc_lite.html?path=novnc/websockify&autoconnect=true&resize=scale"
      title="CUA Live Desktop"
    />
  );
}
