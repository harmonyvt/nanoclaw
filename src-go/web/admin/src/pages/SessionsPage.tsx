import { useEffect, useState } from 'react';
import { api } from '@/api';
import type { SessionInfo } from '@/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { RefreshCw, Users } from 'lucide-react';

function StatusBadge({ status }: { status: string }) {
  const variant =
    status === 'active'
      ? 'default'
      : status === 'closed'
        ? 'secondary'
        : 'outline';

  return (
    <Badge
      variant={variant}
      className={status === 'active' ? 'bg-green-600' : undefined}
    >
      {status}
    </Badge>
  );
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleString();
}

export function SessionsPage() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadSessions = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.listSessions();
      setSessions(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sessions');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSessions();
    const interval = setInterval(loadSessions, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Sessions</h1>
        <Button
          variant="outline"
          size="sm"
          onClick={loadSessions}
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
          <CardTitle>All Sessions</CardTitle>
          <Badge variant="secondary">{sessions.length} total</Badge>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : sessions.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Users className="mx-auto h-8 w-8 mb-2 opacity-50" />
              <p>No sessions found</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Session ID</TableHead>
                  <TableHead>Sandbox ID</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Command</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Last Input</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((session) => (
                  <TableRow key={session.session_id}>
                    <TableCell className="font-mono text-xs">
                      {session.session_id}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {session.sandbox_id}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={session.status} />
                    </TableCell>
                    <TableCell className="text-sm font-mono">
                      {session.command || 'N/A'}
                    </TableCell>
                    <TableCell className="text-sm">
                      {formatDate(session.created_at)}
                    </TableCell>
                    <TableCell className="text-sm">
                      {formatDate(session.last_input_at)}
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
