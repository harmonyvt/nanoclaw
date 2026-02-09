interface HeaderProps {
  connected: boolean;
  onReconnect: () => void;
}

export function Header({ connected, onReconnect }: HeaderProps) {
  const dotClass = connected ? 'status-dot live' : 'status-dot error';
  const label = connected ? 'Live' : 'Reconnecting...';

  return (
    <div class="header">
      <div class="header-left">
        <h1>NanoClaw</h1>
      </div>
      <div class="header-right">
        <div class={dotClass} />
        <span class="status-label">{label}</span>
        {!connected && (
          <button class="reconnect-btn" onClick={onReconnect}>
            Retry
          </button>
        )}
      </div>
    </div>
  );
}
