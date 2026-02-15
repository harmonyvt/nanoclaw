import fs from 'fs';
import path from 'path';
import { Writable } from 'node:stream';

/**
 * Maps service names to the module tags that belong to them.
 * Used to route Pino JSON log lines to per-service log files.
 */
export const SERVICE_MODULES: Record<string, string[]> = {
  container: ['container', 'mount-security'],
  telegram: ['telegram'],
  tts: ['tts', 'tts-dispatch', 'tts-qwen', 'tts-replicate'],
  browse: ['browse', 'cua-takeover', 'omniparser'],
  sandbox: ['sandbox', 'tailscale'],
  media: ['media'],
  scheduler: ['scheduler', 'task-scheduler'],
  supermemory: ['supermemory'],
  agent: ['agent', 'claude-cli'],
  replicate: ['replicate'],
  dashboard: ['dashboard', 'log-sync'],
};

export const SERVICE_NAMES = Object.keys(SERVICE_MODULES);

// Reverse lookup: module tag -> service name
const moduleToService = new Map<string, string>();
for (const [service, modules] of Object.entries(SERVICE_MODULES)) {
  for (const mod of modules) {
    moduleToService.set(mod, service);
  }
}

const openHandles = new Map<string, fs.WriteStream>();
let logsDir = '';

function getOrCreateHandle(service: string): fs.WriteStream {
  let handle = openHandles.get(service);
  if (handle && !handle.destroyed) return handle;

  const filePath = path.join(logsDir, `${service}.log`);
  handle = fs.createWriteStream(filePath, { flags: 'a' });
  openHandles.set(service, handle);
  return handle;
}

/**
 * Create a Pino-compatible Writable stream that routes JSON log lines
 * to per-service log files based on the `module` field.
 */
export function createServiceLogStream(dir: string): Writable {
  logsDir = dir;
  fs.mkdirSync(dir, { recursive: true });

  return new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      const line = chunk.toString();
      try {
        const parsed = JSON.parse(line) as { module?: string };
        const mod = parsed.module;
        if (!mod) {
          cb();
          return;
        }
        const service = moduleToService.get(mod);
        if (!service) {
          cb();
          return;
        }
        const handle = getOrCreateHandle(service);
        handle.write(line.endsWith('\n') ? line : line + '\n', cb);
      } catch {
        // Not valid JSON — skip
        cb();
      }
    },
  });
}

/**
 * Close all open file handles for graceful shutdown.
 */
export function closeServiceLogHandles(): void {
  for (const handle of openHandles.values()) {
    try {
      handle.end();
    } catch {
      // best-effort
    }
  }
  openHandles.clear();
}

/**
 * Truncate service log files exceeding maxSizeMB.
 * Keeps the newer half of the file.
 */
export function rotateServiceLogs(maxSizeMB: number): void {
  if (!logsDir || !fs.existsSync(logsDir)) return;

  const maxBytes = maxSizeMB * 1024 * 1024;

  for (const file of fs.readdirSync(logsDir)) {
    if (!file.endsWith('.log')) continue;
    const filePath = path.join(logsDir, file);
    try {
      const stat = fs.statSync(filePath);
      if (stat.size <= maxBytes) continue;

      // Read the file, keep the second half
      const content = fs.readFileSync(filePath, 'utf8');
      const halfPoint = Math.floor(content.length / 2);
      // Find the next newline after the half point to avoid splitting a line
      const nextNewline = content.indexOf('\n', halfPoint);
      const keepFrom = nextNewline >= 0 ? nextNewline + 1 : halfPoint;

      // Close existing handle before truncating
      const service = file.replace(/\.log$/, '');
      const handle = openHandles.get(service);
      if (handle && !handle.destroyed) {
        handle.end();
        openHandles.delete(service);
      }

      fs.writeFileSync(filePath, content.slice(keepFrom));
    } catch {
      // best-effort rotation
    }
  }
}
