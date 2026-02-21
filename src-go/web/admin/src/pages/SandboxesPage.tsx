import { useEffect, useState } from 'react';
import { api } from '@/api';
import type { SandboxRecord } from '@/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Eye,
  RefreshCw,
  Box,
  Play,
  Square,
  Trash2,
  Camera,
} from 'lucide-react';
import { cn } from '@/lib/utils';

function StateBadge({ state }: { state: string }) {
  const variant =
    state === 'running'
      ? 'default'
      : state === 'stopped'
        ? 'secondary'
        : state === 'error'
          ? 'destructive'
          : 'outline';

  return (
    <Badge
      variant={variant}
      className={cn(state === 'running' && 'bg-green-600')}
    >
      {state}
    </Badge>
  );
}

function HealthBadge({ health }: { health: string }) {
  const variant =
    health === 'healthy'
      ? 'default'
      : health === 'unhealthy'
        ? 'destructive'
        : 'secondary';

  return <Badge variant={variant}>{health}</Badge>;
}

function SandboxDetailDialog({ sandbox }: { sandbox: SandboxRecord }) {
  return (
    <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Sandbox Details</DialogTitle>
      </DialogHeader>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-sm font-medium text-muted-foreground">
              Sandbox ID
            </p>
            <p className="text-sm font-mono">{sandbox.spec.sandbox_id}</p>
          </div>
          <div>
            <p className="text-sm font-medium text-muted-foreground">State</p>
            <StateBadge state={sandbox.status.observed_state} />
          </div>
          <div>
            <p className="text-sm font-medium text-muted-foreground">Health</p>
            <HealthBadge health={sandbox.status.health} />
          </div>
          <div>
            <p className="text-sm font-medium text-muted-foreground">Backend</p>
            <p className="text-sm">{sandbox.status.backend || 'N/A'}</p>
          </div>
          <div>
            <p className="text-sm font-medium text-muted-foreground">VM ID</p>
            <p className="text-sm font-mono">{sandbox.status.vm_id || 'N/A'}</p>
          </div>
          <div>
            <p className="text-sm font-medium text-muted-foreground">PID</p>
            <p className="text-sm">{sandbox.status.pid || 'N/A'}</p>
          </div>
          <div>
            <p className="text-sm font-medium text-muted-foreground">
              Snapshots
            </p>
            <p className="text-sm">{sandbox.status.snapshot_count}</p>
          </div>
          <div>
            <p className="text-sm font-medium text-muted-foreground">
              Desired State
            </p>
            <p className="text-sm">{sandbox.spec.desired_state}</p>
          </div>
        </div>

        {sandbox.status.failure_reason && (
          <div>
            <p className="text-sm font-medium text-muted-foreground mb-2">
              Failure Reason
            </p>
            <div className="text-sm text-destructive bg-destructive/10 p-3 rounded-lg">
              {sandbox.status.failure_reason}
            </div>
          </div>
        )}

        <div>
          <p className="text-sm font-medium text-muted-foreground mb-2">
            VM Profile
          </p>
          <pre className="text-xs bg-muted p-3 rounded-lg overflow-x-auto">
            {JSON.stringify(sandbox.spec.vm_profile, null, 2)}
          </pre>
        </div>

        <div>
          <p className="text-sm font-medium text-muted-foreground mb-2">
            Network Policy
          </p>
          <pre className="text-xs bg-muted p-3 rounded-lg overflow-x-auto">
            {JSON.stringify(sandbox.spec.network_policy, null, 2)}
          </pre>
        </div>
      </div>
    </DialogContent>
  );
}

export function SandboxesPage() {
  const [sandboxes, setSandboxes] = useState<SandboxRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const loadSandboxes = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.listSandboxes();
      setSandboxes(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sandboxes');
    } finally {
      setLoading(false);
    }
  };

  const handleAction = async (
    id: string,
    action: 'start' | 'stop' | 'destroy' | 'snapshot',
  ) => {
    try {
      setActionLoading(`${action}-${id}`);
      if (action === 'start') {
        await api.startSandbox(id);
      } else if (action === 'stop') {
        await api.stopSandbox(id);
      } else if (action === 'destroy') {
        await api.destroySandbox(id);
      } else if (action === 'snapshot') {
        await api.snapshotSandbox(id);
      }
      await loadSandboxes();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : `Failed to ${action} sandbox`,
      );
    } finally {
      setActionLoading(null);
    }
  };

  useEffect(() => {
    loadSandboxes();
    const interval = setInterval(loadSandboxes, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Sandboxes</h1>
        <Button
          variant="outline"
          size="sm"
          onClick={loadSandboxes}
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

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>All Sandboxes</CardTitle>
          <Badge variant="secondary">{sandboxes.length} total</Badge>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : sandboxes.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Box className="mx-auto h-8 w-8 mb-2 opacity-50" />
              <p>No sandboxes found</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Sandbox ID</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Health</TableHead>
                  <TableHead>Backend</TableHead>
                  <TableHead>Snapshots</TableHead>
                  <TableHead className="w-[200px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sandboxes.map((sandbox) => (
                  <TableRow key={sandbox.spec.sandbox_id}>
                    <TableCell className="font-mono text-xs">
                      {sandbox.spec.sandbox_id}
                    </TableCell>
                    <TableCell>
                      <StateBadge state={sandbox.status.observed_state} />
                    </TableCell>
                    <TableCell>
                      <HealthBadge health={sandbox.status.health} />
                    </TableCell>
                    <TableCell className="text-sm">
                      {sandbox.status.backend || 'N/A'}
                    </TableCell>
                    <TableCell>{sandbox.status.snapshot_count}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Dialog>
                          <DialogTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                            >
                              <Eye className="h-4 w-4" />
                            </Button>
                          </DialogTrigger>
                          <SandboxDetailDialog sandbox={sandbox} />
                        </Dialog>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          disabled={
                            actionLoading === `start-${sandbox.spec.sandbox_id}`
                          }
                          onClick={() =>
                            handleAction(sandbox.spec.sandbox_id, 'start')
                          }
                        >
                          <Play className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          disabled={
                            actionLoading === `stop-${sandbox.spec.sandbox_id}`
                          }
                          onClick={() =>
                            handleAction(sandbox.spec.sandbox_id, 'stop')
                          }
                        >
                          <Square className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          disabled={
                            actionLoading ===
                            `snapshot-${sandbox.spec.sandbox_id}`
                          }
                          onClick={() =>
                            handleAction(sandbox.spec.sandbox_id, 'snapshot')
                          }
                        >
                          <Camera className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive"
                          disabled={
                            actionLoading ===
                            `destroy-${sandbox.spec.sandbox_id}`
                          }
                          onClick={() =>
                            handleAction(sandbox.spec.sandbox_id, 'destroy')
                          }
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
