export interface TakeoverData {
  status: 'active' | 'expired';
  token?: string;
  session?: string;
  requestId?: string;
  groupFolder?: string;
  message?: string;
  createdAt?: string;
  liveViewUrl?: string | null;
  vncPassword?: string | null;
  takeoverUrl?: string | null;
}

export interface StructuredLog {
  id: number;
  level: number;
  time: number;
  msg: string;
  module?: string;
  group_folder?: string;
  raw?: string;
}

export interface ContainerRun {
  id: number;
  group_folder: string;
  container_id: string;
  trigger: string;
  started_at: string;
  ended_at?: string;
  exit_code?: number;
  stdout_len?: number;
  stderr_len?: number;
  log_file?: string;
}

export interface ScheduledTask {
  id: number;
  group_folder: string;
  label: string;
  schedule_type: string;
  schedule_value: string;
  prompt: string;
  status: string;
  created_at: string;
  next_run?: string;
  last_run?: string;
  recent_runs?: TaskRunLog[];
}

export interface TaskRunLog {
  id: number;
  task_id: number;
  started_at: string;
  ended_at?: string;
  exit_code?: number;
  trigger: string;
}

export interface FileEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  modified: string;
  path: string;
  permissions?: string;
}
