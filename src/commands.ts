import { execSync } from 'child_process';

import { getAllTasks } from './db.js';
import { RegisteredGroup, Session } from './types.js';

export interface CommandContext {
  chatId: string;
  args: string;
  registeredGroups: Record<string, RegisteredGroup>;
  sessions: Session;
}

export interface Command {
  name: string;
  description: string;
  type: 'host' | 'agent';
  handler: (ctx: CommandContext) => Promise<string | null>;
}

const commands = new Map<string, Command>();

export function register(cmd: Command): void {
  commands.set(cmd.name, cmd);
}

export function getAll(): Command[] {
  return Array.from(commands.values());
}

export function get(name: string): Command | undefined {
  return commands.get(name);
}

export function registerBuiltins(): void {
  register({
    name: 'help',
    description: 'Show available commands',
    type: 'host',
    handler: async () => {
      const lines = ['Available commands:\n'];
      for (const cmd of getAll()) {
        lines.push(`/${cmd.name} - ${cmd.description}`);
      }
      return lines.join('\n');
    },
  });

  register({
    name: 'status',
    description: 'Service health, groups, and tasks',
    type: 'host',
    handler: async (ctx) => {
      let dockerOk = false;
      try {
        execSync('docker info', { stdio: 'pipe' });
        dockerOk = true;
      } catch {}

      const uptimeS = Math.floor(process.uptime());
      const hours = Math.floor(uptimeS / 3600);
      const mins = Math.floor((uptimeS % 3600) / 60);

      const groupCount = Object.keys(ctx.registeredGroups).length;
      const sessionCount = Object.keys(ctx.sessions).length;
      const tasks = getAllTasks();
      const activeTasks = tasks.filter((t) => t.status === 'active').length;

      return [
        'NanoClaw Status',
        `  Uptime: ${hours}h ${mins}m`,
        `  Docker: ${dockerOk ? 'running' : 'NOT RUNNING'}`,
        `  Groups: ${groupCount} registered`,
        `  Sessions: ${sessionCount} active`,
        `  Tasks: ${activeTasks} active / ${tasks.length} total`,
      ].join('\n');
    },
  });

  register({
    name: 'tasks',
    description: 'List scheduled tasks',
    type: 'host',
    handler: async () => {
      const tasks = getAllTasks();
      if (tasks.length === 0) return 'No scheduled tasks.';

      const lines = tasks.map((t) => {
        const nextRun = t.next_run
          ? new Date(t.next_run).toLocaleString()
          : 'N/A';
        const prompt =
          t.prompt.length > 60 ? t.prompt.slice(0, 60) + '...' : t.prompt;
        return `[${t.status}] ${t.id}\n  ${prompt}\n  ${t.schedule_type}: ${t.schedule_value} | next: ${nextRun}`;
      });

      return `Scheduled tasks (${tasks.length}):\n\n${lines.join('\n\n')}`;
    },
  });
}
