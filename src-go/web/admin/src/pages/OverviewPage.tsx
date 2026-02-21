import { useEffect, useState } from 'react';
import { api } from '@/api';
import type {
  TaskRunResult,
  SandboxRecord,
  SessionInfo,
  HealthStatus,
} from '@/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Server,
  ClipboardList,
  Users,
  Activity,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

function StatusBadge({ status }: { status: string }) {
  const variant =
    status === 'accepted' || status === 'running'
      ? 'default'
      : status === 'denied' || status === 'error'
        ? 'destructive'
        : status === 'pending'
          ? 'secondary'
          : 'outline';

  return <Badge variant={variant}>{status}</Badge>;
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleString();
}

export function OverviewPage() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [tasks, setTasks] = useState<TaskRunResult[]>([]);
  const [sandboxes, setSandboxes] = useState<SandboxRecord[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);
      const [healthData, tasksData, sandboxesData, sessionsData] =
        await Promise.all([
          api.getHealth(),
          api.listTasks(),
          api.listSandboxes(),
          api.listSessions(),
        ]);
      setHealth(healthData);
      setTasks(tasksData);
      setSandboxes(sandboxesData);
      setSessions(sessionsData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, []);

  const runningSandboxes = sandboxes.filter(
    (s) => s.status.observed_state === 'running',
  ).length;
  const activeSessions = sessions.filter((s) => s.status === 'active').length;
  const recentTasks = tasks.slice(0, 5);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
        <Button
          variant="outline"
          size="sm"
          onClick={loadData}
          disabled={loading}
        >
          <RefreshCw
            className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`}
          />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive bg-destructive/10 p-4 text-destructive">
          {error}
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Total Sandboxes
            </CardTitle>
            <Server className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {loading ? <Skeleton className="h-8 w-16" /> : sandboxes.length}
            </div>
            <p className="text-xs text-muted-foreground">
              {runningSandboxes} running
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Tasks</CardTitle>
            <ClipboardList className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {loading ? <Skeleton className="h-8 w-16" /> : tasks.length}
            </div>
            <p className="text-xs text-muted-foreground">
              {tasks.filter((t) => t.status === 'accepted').length} accepted
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Active Sessions
            </CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {loading ? <Skeleton className="h-8 w-16" /> : sessions.length}
            </div>
            <p className="text-xs text-muted-foreground">
              {activeSessions} active
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Backend</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {loading ? (
                <Skeleton className="h-8 w-16" />
              ) : (
                health?.supervisor.backend || 'Unknown'
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {health?.supervisor.healthy ? 'Healthy' : 'Unhealthy'}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Recent Tasks */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Tasks</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              {[...Array(3)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : recentTasks.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <ClipboardList className="mx-auto h-8 w-8 mb-2 opacity-50" />
              <p>No tasks yet</p>
            </div>
          ) : (
            <div className="space-y-4">
              {recentTasks.map((task) => (
                <div
                  key={task.task_id}
                  className="flex items-center justify-between rounded-lg border p-4"
                >
                  <div className="space-y-1">
                    <p className="text-sm font-medium">{task.task_id}</p>
                    <p className="text-xs text-muted-foreground">
                      Sandbox: {task.sandbox_id}
                    </p>
                  </div>
                  <div className="flex items-center gap-4">
                    <StatusBadge status={task.status} />
                    <span className="text-xs text-muted-foreground">
                      {formatDate(task.started_at)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
