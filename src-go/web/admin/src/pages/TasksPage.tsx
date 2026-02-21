import { useEffect, useState } from 'react';
import { api } from '@/api';
import type { TaskRunResult } from '@/types';
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
import { Eye, RefreshCw, ClipboardList } from 'lucide-react';

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

function TaskDetailDialog({ task }: { task: TaskRunResult }) {
  return (
    <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Task Details</DialogTitle>
      </DialogHeader>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-sm font-medium text-muted-foreground">Task ID</p>
            <p className="text-sm font-mono">{task.task_id}</p>
          </div>
          <div>
            <p className="text-sm font-medium text-muted-foreground">Status</p>
            <StatusBadge status={task.status} />
          </div>
          <div>
            <p className="text-sm font-medium text-muted-foreground">
              Sandbox ID
            </p>
            <p className="text-sm font-mono">{task.sandbox_id}</p>
          </div>
          <div>
            <p className="text-sm font-medium text-muted-foreground">Started</p>
            <p className="text-sm">{formatDate(task.started_at)}</p>
          </div>
        </div>

        {task.output && (
          <div>
            <p className="text-sm font-medium text-muted-foreground mb-2">
              Output
            </p>
            <pre className="text-xs bg-muted p-3 rounded-lg overflow-x-auto">
              {task.output}
            </pre>
          </div>
        )}

        {task.error && (
          <div>
            <p className="text-sm font-medium text-muted-foreground mb-2">
              Error
            </p>
            <div className="text-sm text-destructive bg-destructive/10 p-3 rounded-lg">
              {task.error}
            </div>
          </div>
        )}

        <div>
          <p className="text-sm font-medium text-muted-foreground mb-2">
            Policy Decision
          </p>
          <pre className="text-xs bg-muted p-3 rounded-lg overflow-x-auto">
            {JSON.stringify(task.policy, null, 2)}
          </pre>
        </div>
      </div>
    </DialogContent>
  );
}

export function TasksPage() {
  const [tasks, setTasks] = useState<TaskRunResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadTasks = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.listTasks();
      setTasks(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tasks');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTasks();
    const interval = setInterval(loadTasks, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Tasks</h1>
        <Button
          variant="outline"
          size="sm"
          onClick={loadTasks}
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
          <CardTitle>All Tasks</CardTitle>
          <Badge variant="secondary">{tasks.length} total</Badge>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : tasks.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <ClipboardList className="mx-auto h-8 w-8 mb-2 opacity-50" />
              <p>No tasks found</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Task ID</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Sandbox ID</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Completed</TableHead>
                  <TableHead className="w-[100px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tasks.map((task) => (
                  <TableRow key={task.task_id}>
                    <TableCell className="font-mono text-xs">
                      {task.task_id}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={task.status} />
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {task.sandbox_id}
                    </TableCell>
                    <TableCell className="text-sm">
                      {formatDate(task.started_at)}
                    </TableCell>
                    <TableCell className="text-sm">
                      {formatDate(task.completed_at)}
                    </TableCell>
                    <TableCell>
                      <Dialog>
                        <DialogTrigger asChild>
                          <Button variant="ghost" size="sm">
                            <Eye className="h-4 w-4" />
                          </Button>
                        </DialogTrigger>
                        <TaskDetailDialog task={task} />
                      </Dialog>
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
