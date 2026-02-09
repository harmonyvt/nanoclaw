import { useState, useCallback } from 'preact/hooks';
import { useAuth } from '../shared/auth.js';
import { Header } from './Header.js';
import { TabBar } from './TabBar.js';
import { LogsPane } from './panes/LogsPane.js';
import { ContainersPane } from './panes/ContainersPane.js';
import { TasksPane } from './panes/TasksPane.js';
import { FilesPane } from './panes/FilesPane.js';
import { TakeoverPane } from './panes/TakeoverPane.js';
import { TrajectoryPane } from './panes/TrajectoryPane.js';

export function DashboardApp() {
  const { authenticated, loading } = useAuth();
  const [activeTab, setActiveTab] = useState('logs');
  const [connected, setConnected] = useState(false);
  const [reconnectFn, setReconnectFn] = useState<(() => void) | null>(null);

  const handleConnectionChange = useCallback(
    (isConnected: boolean, reconnect: () => void) => {
      setConnected(isConnected);
      // Wrap in function to avoid React calling the reconnect function
      setReconnectFn(() => reconnect);
    },
    [],
  );

  const handleReconnect = useCallback(() => {
    if (reconnectFn) reconnectFn();
  }, [reconnectFn]);

  // Loading state
  if (loading) {
    return <div class="loading">Authenticating...</div>;
  }

  // Auth failed
  if (!authenticated) {
    return (
      <div class="auth-screen">
        <div>
          <h2>NanoClaw Dashboard</h2>
          <p>
            Open this dashboard from Telegram using the{' '}
            <strong>/dashboard</strong> command for authenticated access.
          </p>
          <p style={{ marginTop: '16px', fontSize: '12px', color: 'var(--muted)' }}>
            Direct browser access is available when authentication is disabled.
          </p>
        </div>
      </div>
    );
  }

  // Authenticated: show dashboard
  return (
    <>
      <Header connected={connected} onReconnect={handleReconnect} />
      <TabBar active={activeTab} onChange={setActiveTab} />
      {activeTab === 'logs' && (
        <LogsPane onConnectionChange={handleConnectionChange} />
      )}
      {activeTab === 'containers' && <ContainersPane />}
      {activeTab === 'tasks' && <TasksPane />}
      {activeTab === 'files' && <FilesPane />}
      {activeTab === 'takeover' && <TakeoverPane />}
      {activeTab === 'trajectory' && <TrajectoryPane />}
    </>
  );
}
