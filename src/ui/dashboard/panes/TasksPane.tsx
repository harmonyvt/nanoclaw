import { useState, useEffect } from 'preact/hooks';
import { apiFetch } from '../../shared/api.js';
import { timeAgo, formatDuration, truncate } from '../../shared/hooks.js';

/** Shape of a task run log as returned by the API */
interface ApiTaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: string;
  result: string | null;
  error: string | null;
}

/** Shape of a scheduled task as returned by GET /api/tasks */
interface ApiScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  context_mode: string;
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: string;
  created_at: string;
  recent_runs?: ApiTaskRunLog[];
}

function taskBadgeClass(status: string): string {
  if (status === 'active') return 'badge-active';
  if (status === 'paused') return 'badge-paused';
  return 'badge-ok';
}

function runBadgeClass(status: string): string {
  if (status === 'error') return 'badge-error';
  return 'badge-ok';
}

export function TasksPane() {
  const [tasks, setTasks] = useState<ApiScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);

    apiFetch<ApiScheduledTask[]>('/api/tasks')
      .then((data) => {
        setTasks(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err?.message || 'Failed to load tasks');
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <div class="pane active">
        <div class="loading">Loading tasks...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div class="pane active">
        <div class="empty">{error}</div>
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div class="pane active">
        <div class="empty">No scheduled tasks</div>
      </div>
    );
  }

  return (
    <div class="pane active">
      <div class="card-list">
        {tasks.map((task) => {
          const metaParts: string[] = [];
          metaParts.push(`${task.schedule_type}: ${task.schedule_value}`);
          metaParts.push(task.group_folder);
          if (task.next_run) {
            metaParts.push(`next ${timeAgo(task.next_run)}`);
          }

          return (
            <div class="card" key={task.id} style={{ cursor: 'default' }}>
              <div class="card-header">
                <span class="card-title">{truncate(task.prompt, 60)}</span>
                <span class={`badge ${taskBadgeClass(task.status)}`}>
                  {task.status}
                </span>
              </div>
              <div class="card-meta">{metaParts.join(' \u00B7 ')}</div>
              {task.recent_runs && task.recent_runs.length > 0 && (
                <div class="run-list">
                  {task.recent_runs.map((run, i) => (
                    <div class="run-item" key={i}>
                      <span class={`badge ${runBadgeClass(run.status)}`}>
                        {run.status}
                      </span>
                      <span>{formatDuration(run.duration_ms)}</span>
                      <span>{timeAgo(run.run_at)}</span>
                      {run.error && (
                        <span style={{ color: 'var(--danger)' }}>
                          {truncate(run.error, 60)}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
