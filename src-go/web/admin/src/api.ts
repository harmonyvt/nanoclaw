import type {
  RuntimeConfig,
  HealthStatus,
  TaskRunResult,
  TaskRunSpec,
  SandboxRecord,
  SandboxSpec,
  SandboxStatus,
  SessionInfo,
  SessionCreateRequest,
  Event,
  ListResponse,
  ApiError,
} from './types';

const ADMIN_TOKEN_KEY = 'nanoclaw_admin_token';

class ApiClient {
  private token: string | null = null;

  constructor() {
    this.token = localStorage.getItem(ADMIN_TOKEN_KEY);
  }

  setToken(token: string | null) {
    this.token = token;
    if (token) {
      localStorage.setItem(ADMIN_TOKEN_KEY, token);
    } else {
      localStorage.removeItem(ADMIN_TOKEN_KEY);
    }
  }

  getToken(): string | null {
    return this.token;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    return headers;
  }

  private async fetch<T>(url: string, options?: RequestInit): Promise<T> {
    const response = await fetch(url, {
      ...options,
      headers: {
        ...this.getHeaders(),
        ...options?.headers,
      },
    });

    if (!response.ok) {
      const errorData: ApiError = await response
        .json()
        .catch(() => ({ error: 'Unknown error' }));
      throw new Error(errorData.error || `HTTP ${response.status}`);
    }

    return response.json() as Promise<T>;
  }

  // Health
  async getHealth(): Promise<HealthStatus> {
    return this.fetch<HealthStatus>('/healthz');
  }

  // Config
  async getConfig(): Promise<RuntimeConfig> {
    return this.fetch<RuntimeConfig>('/admin/config.json');
  }

  // Tasks
  async listTasks(): Promise<TaskRunResult[]> {
    const response = await this.fetch<ListResponse<TaskRunResult>>('/v1/tasks');
    return response.items;
  }

  async getTask(id: string): Promise<TaskRunResult> {
    return this.fetch<TaskRunResult>(`/v1/tasks/${id}`);
  }

  async createTaskRun(spec: TaskRunSpec): Promise<unknown> {
    return this.fetch('/v1/tasks/runs', {
      method: 'POST',
      body: JSON.stringify(spec),
    });
  }

  // Sandboxes
  async listSandboxes(): Promise<SandboxRecord[]> {
    const response =
      await this.fetch<ListResponse<SandboxRecord>>('/v1/sandboxes');
    return response.items;
  }

  async getSandbox(id: string): Promise<SandboxRecord> {
    return this.fetch<SandboxRecord>(`/v1/sandboxes/${id}`);
  }

  async createSandbox(
    spec: SandboxSpec,
  ): Promise<{ spec: SandboxSpec; status: SandboxStatus }> {
    return this.fetch('/v1/sandboxes', {
      method: 'POST',
      body: JSON.stringify(spec),
    });
  }

  async startSandbox(id: string): Promise<SandboxStatus> {
    return this.fetch(`/v1/sandboxes/${id}:start`, {
      method: 'POST',
    });
  }

  async stopSandbox(id: string): Promise<SandboxStatus> {
    return this.fetch(`/v1/sandboxes/${id}:stop`, {
      method: 'POST',
    });
  }

  async destroySandbox(id: string): Promise<SandboxStatus> {
    return this.fetch(`/v1/sandboxes/${id}:destroy`, {
      method: 'POST',
    });
  }

  async snapshotSandbox(
    id: string,
  ): Promise<SandboxStatus & { snapshot?: Record<string, unknown> }> {
    return this.fetch(`/v1/sandboxes/${id}:snapshot`, {
      method: 'POST',
    });
  }

  // Sessions
  async listSessions(): Promise<SessionInfo[]> {
    const response =
      await this.fetch<ListResponse<SessionInfo>>('/v1/sessions');
    return response.items;
  }

  async createSession(req: SessionCreateRequest): Promise<SessionInfo> {
    return this.fetch('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify(req),
    });
  }

  // Events
  async listEvents(limit = 200): Promise<Event[]> {
    const response = await this.fetch<ListResponse<Event>>(
      `/v1/events?limit=${limit}`,
    );
    return response.items;
  }

  subscribeToEvents(
    onEvent: (event: Event) => void,
    onError?: (error: Error) => void,
  ): () => void {
    const abortController = new AbortController();

    const connect = async () => {
      try {
        const headers: Record<string, string> = {};
        if (this.token) {
          headers['Authorization'] = `Bearer ${this.token}`;
        }

        const response = await fetch('/v1/events/stream', {
          headers,
          signal: abortController.signal,
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error('No response body');
        }

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(':')) continue;

            try {
              const event = JSON.parse(trimmed) as {
                event?: string;
                data?: Event;
              };
              if (event.data) {
                onEvent(event.data);
              }
            } catch {
              // Ignore parse errors for non-JSON lines
            }
          }
        }
      } catch (error) {
        if (!abortController.signal.aborted && onError) {
          onError(error instanceof Error ? error : new Error(String(error)));
        }
      }
    };

    connect();

    return () => {
      abortController.abort();
    };
  }
}

export const api = new ApiClient();
