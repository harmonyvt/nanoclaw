import fs from 'fs';
import path from 'path';

import {
  DASHBOARD_ENABLED,
  DASHBOARD_PORT,
  DASHBOARD_TLS_CERT,
  DASHBOARD_TLS_KEY,
  DASHBOARD_URL,
  GROUPS_DIR,
  DATA_DIR,
  CUA_SANDBOX_CONTAINER_NAME,
} from './config.js';
import { getSandboxHostIp, isSandboxRunning, ensureSandbox, getSandboxUrl, resetIdleTimer, resetSandbox } from './sandbox-manager.js';
import { getContainerStatus, killContainer, interruptContainer } from './container-runner.js';
import { getTailscaleHttpsUrl } from './tailscale-serve.js';
import { logger } from './logger.js';
import {
  validateTelegramInitData,
  createSession,
  validateSession,
  cleanExpiredSessions,
} from './dashboard-auth.js';
import {
  logEmitter,
  getRingBuffer,
  getRingBufferSince,
  type StructuredLog,
} from './log-sync.js';
import {
  queryLogs,
  getLogById,
  getLogStats,
  queryContainerLogs,
  getAllTasks,
  getTaskRunLogs,
  getAllTaskRunLogs,
} from './db.js';
import {
  runCuaCommand,
  shellSingleQuote,
  getAllWaitingRequests,
  getWaitForUserRequestByToken,
  resolveWaitForUserByToken,
} from './browse-host.js';
import { serveStaticAsset } from './ui-assets.js';
import { proxyNoVncHttp, createNoVncWebSocketHandler, makeNoVncWsData, type NoVncWsData } from './novnc-proxy.js';
import {
  cuaActivityEmitter,
  type CuaActivityEvent,
} from './cua-activity.js';
import {
  getTrajectorySessions,
  getTrajectorySession,
  getActiveSession,
} from './cua-trajectory.js';

let dashboardServer: ReturnType<typeof Bun.serve> | null = null;
let sessionCleanupInterval: ReturnType<typeof setInterval> | null = null;

const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_DOWNLOAD_SIZE = 100 * 1024 * 1024; // 100MB
const MAX_PREVIEW_TEXT = 10 * 1024; // 10KB
const MAX_PREVIEW_IMAGE = 2 * 1024 * 1024; // 2MB
const PROTECTED_FILES = ['CLAUDE.md', 'SOUL.md'];
const CUA_SAFE_ROOTS = ['/home', '/tmp', '/root', '/var', '/opt'];


function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function extractToken(req: Request, url: URL): string | null {
  const authHeader = req.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);
  return url.searchParams.get('token');
}

function authenticateRequest(
  req: Request,
  url: URL,
): { userId: number; groupFolder?: string } | null {
  const token = extractToken(req, url);
  if (token) return validateSession(token);
  return null;
}

// ── Route handlers ──────────────────────────────────────────────────────

function handleAuth(url: URL): Response {
  const initData = url.searchParams.get('initData');
  if (!initData) return jsonResponse({ error: 'missing initData' }, 400);

  const result = validateTelegramInitData(initData);
  if (!result.valid || !result.userId) {
    return jsonResponse({ error: result.error || 'unauthorized' }, 401);
  }

  const session = createSession(result.userId);
  return jsonResponse({
    token: session.token,
    expiresAt: session.expiresAt,
    userName: result.userName,
  });
}

function handleSSEStream(req: Request, url: URL): Response {
  const afterId = parseInt(url.searchParams.get('afterId') || '0', 10);

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      function send(eventType: string, data: unknown) {
        try {
          controller.enqueue(
            encoder.encode(
              `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`,
            ),
          );
        } catch {
          // Stream closed
        }
      }

      const catchUp = afterId > 0 ? getRingBufferSince(afterId) : getRingBuffer();
      for (const entry of catchUp) {
        send('log', entry);
      }

      const onLog = (entry: StructuredLog) => send('log', entry);
      logEmitter.on('log', onLog);

      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          clearInterval(heartbeat);
        }
      }, 15_000);

      req.signal.addEventListener('abort', () => {
        logEmitter.off('log', onLog);
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // Already closed
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}

function handleLogsQuery(url: URL): Response {
  const level = url.searchParams.get('level');
  const search = url.searchParams.get('search');
  const group = url.searchParams.get('group');
  const since = url.searchParams.get('since');
  const until = url.searchParams.get('until');
  const limit = url.searchParams.get('limit');
  const offset = url.searchParams.get('offset');

  const logs = queryLogs({
    level: level ? parseInt(level, 10) : undefined,
    search: search || undefined,
    group: group || undefined,
    since: since ? parseInt(since, 10) : undefined,
    until: until ? parseInt(until, 10) : undefined,
    limit: limit ? parseInt(limit, 10) : undefined,
    offset: offset ? parseInt(offset, 10) : undefined,
  });

  return jsonResponse(logs);
}

function handleLogStats(): Response {
  return jsonResponse(getLogStats());
}

function handleLogDetail(pathname: string): Response {
  const idStr = pathname.replace('/api/logs/', '');
  const id = parseInt(idStr, 10);
  if (isNaN(id)) return jsonResponse({ error: 'invalid id' }, 400);

  const log = getLogById(id);
  if (!log) return jsonResponse({ error: 'not found' }, 404);

  // Parse raw JSON to extract extra context fields
  let extra: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(log.raw);
    const STANDARD_KEYS = new Set([
      'level', 'time', 'msg', 'module', 'name', 'pid', 'hostname', 'v',
      'group_folder', 'group', 'sourceGroup', 'groupFolder', 'container',
    ]);
    for (const [key, value] of Object.entries(parsed)) {
      if (!STANDARD_KEYS.has(key)) {
        extra[key] = value;
      }
    }
  } catch {
    // raw wasn't valid JSON
  }

  return jsonResponse({
    ...log,
    extra,
  });
}

function handleContainersList(url: URL): Response {
  const group = url.searchParams.get('group');
  const since = url.searchParams.get('since');
  const limit = url.searchParams.get('limit');

  return jsonResponse(
    queryContainerLogs({
      group: group || undefined,
      since: since || undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    }),
  );
}

function handleContainerLog(pathname: string): Response {
  const parts = pathname.replace('/api/containers/', '').split('/');
  if (parts.length !== 2) return jsonResponse({ error: 'invalid path' }, 400);

  const [group, filename] = parts;

  if (group.includes('..') || group.includes('/') || group.includes('\\')) {
    return jsonResponse({ error: 'invalid group' }, 400);
  }
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return jsonResponse({ error: 'invalid filename' }, 400);
  }
  if (!filename.endsWith('.log')) {
    return jsonResponse({ error: 'invalid file type' }, 400);
  }

  const filePath = path.join(GROUPS_DIR, group, 'logs', filename);

  try {
    if (!fs.existsSync(filePath)) {
      return jsonResponse({ error: 'not found' }, 404);
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return new Response(content, {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  } catch {
    return jsonResponse({ error: 'read error' }, 500);
  }
}

function handleTasksList(url: URL): Response {
  const group = url.searchParams.get('group');
  const tasks = getAllTasks();
  const filtered = group
    ? tasks.filter((t) => t.group_folder === group)
    : tasks;

  const enriched = filtered.map((task) => ({
    ...task,
    recent_runs: getTaskRunLogs(task.id, 5),
  }));

  return jsonResponse(enriched);
}

function handleTaskRunLogsList(url: URL): Response {
  const limit = url.searchParams.get('limit');
  const offset = url.searchParams.get('offset');
  return jsonResponse(
    getAllTaskRunLogs(
      limit ? parseInt(limit, 10) : 50,
      offset ? parseInt(offset, 10) : 0,
    ),
  );
}

// ── Files API helpers ────────────────────────────────────────────────────

function validateAgentPath(group: string, relativePath: string): string | null {
  if (!group || group.includes('..') || group.includes('/') || group.includes('\\') || group.includes('\0')) {
    return null;
  }
  if (relativePath.includes('\0')) return null;

  const groupRoot = path.join(GROUPS_DIR, group);
  if (!fs.existsSync(groupRoot) || !fs.statSync(groupRoot).isDirectory()) {
    return null;
  }

  const resolved = path.resolve(groupRoot, relativePath || '.');
  if (!resolved.startsWith(groupRoot)) {
    return null;
  }
  return resolved;
}

function validateCuaPath(p: string): boolean {
  if (!p || p.includes('..') || p.includes('\0')) return false;
  return CUA_SAFE_ROOTS.some(root => p === root || p.startsWith(root + '/')) || p === '/' || p === '~' || p.startsWith('~/');
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain',
  '.md': 'text/markdown', '.csv': 'text/csv', '.yaml': 'text/yaml', '.yml': 'text/yaml',
  '.ts': 'text/typescript', '.tsx': 'text/typescript', '.jsx': 'text/javascript',
  '.py': 'text/x-python', '.sh': 'text/x-shellscript', '.log': 'text/plain',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip',
  '.tar': 'application/x-tar', '.7z': 'application/x-7z-compressed',
  '.toml': 'text/plain', '.ini': 'text/plain', '.conf': 'text/plain',
};

function getMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function isTextFile(filename: string): boolean {
  const mime = getMimeType(filename);
  return mime.startsWith('text/') || mime === 'application/json' || mime === 'application/javascript' || mime === 'application/xml';
}

function isImageFile(filename: string): boolean {
  return getMimeType(filename).startsWith('image/');
}

interface FileEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  modified: string;
  path: string;
  permissions?: string;
}

function parseLsOutput(output: string, basePath: string): FileEntry[] {
  const lines = String(output).trim().split('\n');
  const entries: FileEntry[] = [];
  for (const line of lines) {
    if (!line.trim() || line.startsWith('total ')) continue;
    // ls -la --time-style=iso format: perms links owner group size date time name
    const parts = line.trim().split(/\s+/);
    if (parts.length < 8) continue;
    const perms = parts[0];
    const size = parseInt(parts[4], 10) || 0;
    const dateStr = parts[5]; // YYYY-MM-DD
    const timeStr = parts[6]; // HH:MM
    const name = parts.slice(7).join(' ');
    if (name === '.' || name === '..') continue;

    let type: 'file' | 'directory' | 'symlink' = 'file';
    if (perms.startsWith('d')) type = 'directory';
    else if (perms.startsWith('l')) type = 'symlink';

    const filePath = basePath.endsWith('/') ? basePath + name : basePath + '/' + name;
    entries.push({
      name,
      type,
      size,
      modified: `${dateStr}T${timeStr}:00`,
      path: filePath,
      permissions: perms.slice(1),
    });
  }
  // Sort: directories first, then alphabetical
  entries.sort((a, b) => {
    if (a.type === 'directory' && b.type !== 'directory') return -1;
    if (a.type !== 'directory' && b.type === 'directory') return 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

// ── Files API: Agent handlers ────────────────────────────────────────────

function handleFilesGroupsList(): Response {
  try {
    const entries = fs.readdirSync(GROUPS_DIR, { withFileTypes: true });
    const groups = entries
      .filter(e => e.isDirectory())
      .map(e => {
        const groupPath = path.join(GROUPS_DIR, e.name);
        let totalSize = 0;
        try {
          const files = fs.readdirSync(groupPath);
          for (const f of files) {
            try {
              const s = fs.statSync(path.join(groupPath, f));
              if (s.isFile()) totalSize += s.size;
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
        return { name: e.name, size: totalSize };
      });
    return jsonResponse(groups);
  } catch {
    return jsonResponse({ error: 'failed to list groups' }, 500);
  }
}

function handleAgentFilesList(url: URL): Response {
  const group = url.searchParams.get('group') || 'main';
  const relPath = url.searchParams.get('path') || '.';

  const resolved = validateAgentPath(group, relPath);
  if (!resolved) return jsonResponse({ error: 'invalid path' }, 400);

  try {
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return jsonResponse({ error: 'not a directory' }, 400);
    }

    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const files: FileEntry[] = [];
    const groupRoot = path.join(GROUPS_DIR, group);

    for (const entry of entries) {
      const fullPath = path.join(resolved, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        const relativePath = path.relative(groupRoot, fullPath);
        files.push({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file',
          size: stat.isFile() ? stat.size : 0,
          modified: stat.mtime.toISOString(),
          path: relativePath,
        });
      } catch { /* skip inaccessible */ }
    }

    files.sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1;
      if (a.type !== 'directory' && b.type === 'directory') return 1;
      return a.name.localeCompare(b.name);
    });

    return jsonResponse(files);
  } catch {
    return jsonResponse({ error: 'failed to list directory' }, 500);
  }
}

function handleAgentFileDownload(url: URL): Response {
  const group = url.searchParams.get('group') || 'main';
  const relPath = url.searchParams.get('path') || '';

  const resolved = validateAgentPath(group, relPath);
  if (!resolved) return jsonResponse({ error: 'invalid path' }, 400);

  try {
    if (!fs.existsSync(resolved)) {
      return jsonResponse({ error: 'file not found' }, 404);
    }
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return jsonResponse({ error: 'not a file' }, 400);
    if (stat.size > MAX_DOWNLOAD_SIZE) {
      return jsonResponse({ error: `file too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB exceeds 100MB limit` }, 400);
    }

    const filename = path.basename(resolved);
    const mime = getMimeType(filename);
    const content = fs.readFileSync(resolved);

    return new Response(content, {
      headers: {
        'content-type': mime,
        'content-disposition': `attachment; filename="${filename}"`,
        'content-length': String(content.length),
      },
    });
  } catch {
    return jsonResponse({ error: 'download failed' }, 500);
  }
}

async function handleAgentFileUpload(req: Request): Promise<Response> {
  try {
    const formData = await req.formData();
    const group = String(formData.get('group') || 'main');
    const relPath = String(formData.get('path') || '.');
    const file = formData.get('file');

    if (!file || !(file instanceof File)) {
      return jsonResponse({ error: 'no file provided' }, 400);
    }
    if (file.size > MAX_UPLOAD_SIZE) {
      return jsonResponse({ error: `file too large: ${(file.size / 1024 / 1024).toFixed(1)}MB exceeds 50MB limit` }, 400);
    }

    const resolved = validateAgentPath(group, relPath);
    if (!resolved) return jsonResponse({ error: 'invalid path' }, 400);

    if (!fs.existsSync(resolved)) {
      fs.mkdirSync(resolved, { recursive: true });
    }

    const destPath = path.join(resolved, file.name);
    const groupRoot = path.join(GROUPS_DIR, group);
    if (!destPath.startsWith(groupRoot)) {
      return jsonResponse({ error: 'path traversal rejected' }, 400);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(destPath, buffer);

    return jsonResponse({ ok: true, name: file.name, size: file.size, path: path.relative(groupRoot, destPath) });
  } catch (err) {
    return jsonResponse({ error: `upload failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
  }
}

async function handleAgentFileDelete(req: Request): Promise<Response> {
  try {
    const body = await req.json() as { group?: string; path?: string };
    const group = body.group || 'main';
    const relPath = body.path || '';

    if (!relPath) return jsonResponse({ error: 'path required' }, 400);

    const filename = path.basename(relPath);
    if (PROTECTED_FILES.includes(filename)) {
      return jsonResponse({ error: `${filename} is protected and cannot be deleted` }, 403);
    }

    const resolved = validateAgentPath(group, relPath);
    if (!resolved) return jsonResponse({ error: 'invalid path' }, 400);
    if (!fs.existsSync(resolved)) return jsonResponse({ error: 'not found' }, 404);

    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      fs.rmSync(resolved, { recursive: true });
    } else {
      fs.unlinkSync(resolved);
    }
    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ error: `delete failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
  }
}

async function handleAgentFileMkdir(req: Request): Promise<Response> {
  try {
    const body = await req.json() as { group?: string; path?: string };
    const group = body.group || 'main';
    const relPath = body.path || '';

    if (!relPath) return jsonResponse({ error: 'path required' }, 400);

    const resolved = validateAgentPath(group, relPath);
    if (!resolved) return jsonResponse({ error: 'invalid path' }, 400);

    fs.mkdirSync(resolved, { recursive: true });
    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ error: `mkdir failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
  }
}

async function handleAgentFileRename(req: Request): Promise<Response> {
  try {
    const body = await req.json() as { group?: string; oldPath?: string; newPath?: string };
    const group = body.group || 'main';

    if (!body.oldPath || !body.newPath) return jsonResponse({ error: 'oldPath and newPath required' }, 400);

    const oldResolved = validateAgentPath(group, body.oldPath);
    const newResolved = validateAgentPath(group, body.newPath);
    if (!oldResolved || !newResolved) return jsonResponse({ error: 'invalid path' }, 400);
    if (!fs.existsSync(oldResolved)) return jsonResponse({ error: 'source not found' }, 404);

    fs.renameSync(oldResolved, newResolved);
    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ error: `rename failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
  }
}

function handleAgentFileInfo(url: URL): Response {
  const group = url.searchParams.get('group') || 'main';
  const relPath = url.searchParams.get('path') || '';

  const resolved = validateAgentPath(group, relPath);
  if (!resolved) return jsonResponse({ error: 'invalid path' }, 400);

  try {
    if (!fs.existsSync(resolved)) return jsonResponse({ error: 'not found' }, 404);

    const stat = fs.statSync(resolved);
    const filename = path.basename(resolved);
    const mime = getMimeType(filename);
    const isProtected = PROTECTED_FILES.includes(filename);

    const info: Record<string, unknown> = {
      name: filename,
      type: stat.isDirectory() ? 'directory' : 'file',
      size: stat.size,
      modified: stat.mtime.toISOString(),
      mimeType: mime,
      isProtected,
      isPreviewable: false,
    };

    if (stat.isFile()) {
      if (isTextFile(filename) && stat.size <= MAX_PREVIEW_TEXT) {
        info.preview = fs.readFileSync(resolved, 'utf8').slice(0, MAX_PREVIEW_TEXT);
        info.isPreviewable = true;
      } else if (isImageFile(filename) && stat.size <= MAX_PREVIEW_IMAGE) {
        const buf = fs.readFileSync(resolved);
        info.preview = `data:${mime};base64,${buf.toString('base64')}`;
        info.isPreviewable = true;
      }
    }

    return jsonResponse(info);
  } catch {
    return jsonResponse({ error: 'info failed' }, 500);
  }
}

function handleAgentFileSearch(url: URL): Response {
  const group = url.searchParams.get('group') || 'main';
  const query = (url.searchParams.get('q') || '').toLowerCase();

  if (!query) return jsonResponse([]);

  const groupRootOrNull = validateAgentPath(group, '.');
  if (!groupRootOrNull) return jsonResponse({ error: 'invalid group' }, 400);
  const groupRoot: string = groupRootOrNull;

  const results: FileEntry[] = [];
  const MAX_RESULTS = 50;

  function walk(dir: string, depth: number) {
    if (depth > 5 || results.length >= MAX_RESULTS) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= MAX_RESULTS) break;
        const fullPath = path.join(dir, entry.name);
        if (entry.name.toLowerCase().includes(query)) {
          try {
            const stat = fs.statSync(fullPath);
            results.push({
              name: entry.name,
              type: entry.isDirectory() ? 'directory' : 'file',
              size: stat.isFile() ? stat.size : 0,
              modified: stat.mtime.toISOString(),
              path: path.relative(groupRoot, fullPath),
            });
          } catch { /* skip */ }
        }
        if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
          walk(fullPath, depth + 1);
        }
      }
    } catch { /* skip */ }
  }

  walk(groupRoot, 0);
  return jsonResponse(results);
}

// ── Files API: CUA handlers ─────────────────────────────────────────────

function handleCuaStatus(): Response {
  return jsonResponse({ running: isSandboxRunning() });
}

async function handleCuaFilesList(url: URL): Promise<Response> {
  const cuaPath = url.searchParams.get('path') || '/home/cua';

  if (!validateCuaPath(cuaPath)) return jsonResponse({ error: 'invalid path' }, 400);
  if (!isSandboxRunning()) return jsonResponse({ error: 'sandbox not running', entries: [] });

  try {
    const output = await runCuaCommand('run_command', {
      command: `ls -la --time-style=iso ${shellSingleQuote(cuaPath)} 2>/dev/null || ls -la ${shellSingleQuote(cuaPath)}`,
    });
    const entries = parseLsOutput(String(output), cuaPath);
    return jsonResponse(entries);
  } catch (err) {
    return jsonResponse({ error: `list failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
  }
}

async function handleCuaFileDownload(url: URL): Promise<Response> {
  const cuaPath = url.searchParams.get('path') || '';

  if (!cuaPath || !validateCuaPath(cuaPath)) return jsonResponse({ error: 'invalid path' }, 400);
  if (!isSandboxRunning()) return jsonResponse({ error: 'sandbox not running' }, 400);

  try {
    // Check file size first
    const statResult = await runCuaCommand('run_command', {
      command: `stat -c '%s' ${shellSingleQuote(cuaPath)} 2>/dev/null || stat -f '%z' ${shellSingleQuote(cuaPath)} 2>/dev/null`,
    });
    const fileSize = parseInt(String(statResult).trim().replace(/'/g, ''), 10);
    if (isNaN(fileSize)) return jsonResponse({ error: 'file not found' }, 404);
    if (fileSize > MAX_DOWNLOAD_SIZE) {
      return jsonResponse({ error: `file too large: ${(fileSize / 1024 / 1024).toFixed(1)}MB` }, 400);
    }

    const base64Content = await runCuaCommand('run_command', {
      command: `base64 -w0 ${shellSingleQuote(cuaPath)} 2>/dev/null || base64 ${shellSingleQuote(cuaPath)} 2>/dev/null | tr -d '\\n'`,
    });
    const content = String(base64Content).trim();
    if (!content) return jsonResponse({ error: 'empty file or read error' }, 500);

    const buffer = Buffer.from(content, 'base64');
    const filename = path.basename(cuaPath);
    const mime = getMimeType(filename);

    return new Response(buffer, {
      headers: {
        'content-type': mime,
        'content-disposition': `attachment; filename="${filename}"`,
        'content-length': String(buffer.length),
      },
    });
  } catch (err) {
    return jsonResponse({ error: `download failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
  }
}

async function handleCuaFileUpload(req: Request): Promise<Response> {
  if (!isSandboxRunning()) return jsonResponse({ error: 'sandbox not running' }, 400);

  try {
    const formData = await req.formData();
    const cuaPath = String(formData.get('path') || '/home/cua/Downloads');
    const file = formData.get('file');

    if (!file || !(file instanceof File)) return jsonResponse({ error: 'no file provided' }, 400);
    if (file.size > MAX_UPLOAD_SIZE) {
      return jsonResponse({ error: `file too large: ${(file.size / 1024 / 1024).toFixed(1)}MB exceeds 50MB limit` }, 400);
    }
    if (!validateCuaPath(cuaPath)) return jsonResponse({ error: 'invalid path' }, 400);

    const destPath = cuaPath.endsWith('/') ? cuaPath + file.name : cuaPath + '/' + file.name;
    const destDir = destPath.substring(0, destPath.lastIndexOf('/'));

    await runCuaCommand('run_command', { command: `mkdir -p ${shellSingleQuote(destDir)}` });

    const buffer = Buffer.from(await file.arrayBuffer());
    const base64Content = buffer.toString('base64');
    const CHUNK_SIZE = 64 * 1024;

    if (base64Content.length <= CHUNK_SIZE) {
      await runCuaCommand('run_command', {
        command: `printf '%s' ${shellSingleQuote(base64Content)} | base64 -d > ${shellSingleQuote(destPath)}`,
      });
    } else {
      const totalChunks = Math.ceil(base64Content.length / CHUNK_SIZE);
      for (let i = 0; i < totalChunks; i++) {
        const chunk = base64Content.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        const redirect = i === 0 ? '>' : '>>';
        await runCuaCommand('run_command', {
          command: `printf '%s' ${shellSingleQuote(chunk)} | base64 -d ${redirect} ${shellSingleQuote(destPath)}`,
        });
      }
    }

    return jsonResponse({ ok: true, name: file.name, size: file.size, path: destPath });
  } catch (err) {
    return jsonResponse({ error: `upload failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
  }
}

async function handleCuaFileDelete(req: Request): Promise<Response> {
  if (!isSandboxRunning()) return jsonResponse({ error: 'sandbox not running' }, 400);

  try {
    const body = await req.json() as { path?: string };
    const cuaPath = body.path || '';
    if (!cuaPath || !validateCuaPath(cuaPath)) return jsonResponse({ error: 'invalid path' }, 400);

    await runCuaCommand('run_command', {
      command: `rm -rf ${shellSingleQuote(cuaPath)}`,
    });
    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ error: `delete failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
  }
}

async function handleCuaFileMkdir(req: Request): Promise<Response> {
  if (!isSandboxRunning()) return jsonResponse({ error: 'sandbox not running' }, 400);

  try {
    const body = await req.json() as { path?: string };
    const cuaPath = body.path || '';
    if (!cuaPath || !validateCuaPath(cuaPath)) return jsonResponse({ error: 'invalid path' }, 400);

    await runCuaCommand('run_command', {
      command: `mkdir -p ${shellSingleQuote(cuaPath)}`,
    });
    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ error: `mkdir failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
  }
}

async function handleCuaFileRename(req: Request): Promise<Response> {
  if (!isSandboxRunning()) return jsonResponse({ error: 'sandbox not running' }, 400);

  try {
    const body = await req.json() as { oldPath?: string; newPath?: string };
    if (!body.oldPath || !body.newPath) return jsonResponse({ error: 'oldPath and newPath required' }, 400);
    if (!validateCuaPath(body.oldPath) || !validateCuaPath(body.newPath)) {
      return jsonResponse({ error: 'invalid path' }, 400);
    }

    await runCuaCommand('run_command', {
      command: `mv ${shellSingleQuote(body.oldPath)} ${shellSingleQuote(body.newPath)}`,
    });
    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ error: `rename failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
  }
}

async function handleCuaFileSearch(url: URL): Promise<Response> {
  const query = url.searchParams.get('q') || '';
  const cuaPath = url.searchParams.get('path') || '/home/cua';

  if (!query) return jsonResponse([]);
  if (!isSandboxRunning()) return jsonResponse({ error: 'sandbox not running' }, 400);
  if (!validateCuaPath(cuaPath)) return jsonResponse({ error: 'invalid path' }, 400);

  try {
    const output = await runCuaCommand('run_command', {
      command: `find ${shellSingleQuote(cuaPath)} -maxdepth 5 -iname ${shellSingleQuote('*' + query + '*')} 2>/dev/null | head -50`,
    });
    const lines = String(output).trim().split('\n').filter(l => l.trim());
    const entries: FileEntry[] = [];
    for (const line of lines) {
      const name = path.basename(line);
      entries.push({ name, type: 'file', size: 0, modified: '', path: line });
    }
    return jsonResponse(entries);
  } catch (err) {
    return jsonResponse({ error: `search failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
  }
}

async function handleCuaStart(): Promise<Response> {
  try {
    if (isSandboxRunning()) return jsonResponse({ ok: true, status: 'already running' });
    await ensureSandbox();
    return jsonResponse({ ok: true, status: 'started' });
  } catch (err) {
    return jsonResponse({ error: `start failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
  }
}

// ── Files API: Transfer handler ──────────────────────────────────────────

async function handleFileTransfer(req: Request): Promise<Response> {
  try {
    const body = await req.json() as {
      direction?: string;
      sourcePath?: string;
      destPath?: string;
      group?: string;
    };

    const { direction, sourcePath, destPath, group = 'main' } = body;
    if (!direction || !sourcePath) {
      return jsonResponse({ error: 'direction and sourcePath required' }, 400);
    }

    if (direction === 'cua-to-agent') {
      if (!isSandboxRunning()) return jsonResponse({ error: 'sandbox not running' }, 400);
      if (!validateCuaPath(sourcePath)) return jsonResponse({ error: 'invalid source path' }, 400);

      // Read file from CUA
      const statResult = await runCuaCommand('run_command', {
        command: `stat -c '%s' ${shellSingleQuote(sourcePath)} 2>/dev/null || stat -f '%z' ${shellSingleQuote(sourcePath)} 2>/dev/null`,
      });
      const fileSize = parseInt(String(statResult).trim().replace(/'/g, ''), 10);
      if (isNaN(fileSize)) return jsonResponse({ error: 'source file not found in CUA' }, 404);
      if (fileSize > MAX_DOWNLOAD_SIZE) {
        return jsonResponse({ error: `file too large: ${(fileSize / 1024 / 1024).toFixed(1)}MB` }, 400);
      }

      const base64Content = await runCuaCommand('run_command', {
        command: `base64 -w0 ${shellSingleQuote(sourcePath)} 2>/dev/null || base64 ${shellSingleQuote(sourcePath)} 2>/dev/null | tr -d '\\n'`,
      });
      const content = String(base64Content).trim();
      if (!content) return jsonResponse({ error: 'failed to read CUA file' }, 500);

      const filename = path.basename(sourcePath);
      const destDir = destPath || 'media';
      const agentDir = validateAgentPath(group, destDir);
      if (!agentDir) return jsonResponse({ error: 'invalid destination path' }, 400);

      fs.mkdirSync(agentDir, { recursive: true });
      const ext = path.extname(filename);
      const stem = path.basename(filename, ext);
      const finalName = `${stem}-${Date.now()}${ext}`;
      const fullDest = path.join(agentDir, finalName);

      const fileBuffer = Buffer.from(content, 'base64');
      fs.writeFileSync(fullDest, fileBuffer);

      const groupRoot = path.join(GROUPS_DIR, group);
      return jsonResponse({ ok: true, name: finalName, size: fileBuffer.length, path: path.relative(groupRoot, fullDest) });

    } else if (direction === 'agent-to-cua') {
      if (!isSandboxRunning()) return jsonResponse({ error: 'sandbox not running' }, 400);

      const agentFile = validateAgentPath(group, sourcePath);
      if (!agentFile) return jsonResponse({ error: 'invalid source path' }, 400);
      if (!fs.existsSync(agentFile)) return jsonResponse({ error: 'source file not found' }, 404);

      const stat = fs.statSync(agentFile);
      if (!stat.isFile()) return jsonResponse({ error: 'source is not a file' }, 400);
      if (stat.size > MAX_UPLOAD_SIZE) {
        return jsonResponse({ error: `file too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB` }, 400);
      }

      const filename = path.basename(agentFile);
      const cuaDest = destPath || `/home/cua/Downloads/${filename}`;
      if (!validateCuaPath(cuaDest)) return jsonResponse({ error: 'invalid CUA destination' }, 400);

      const cuaDir = cuaDest.substring(0, cuaDest.lastIndexOf('/'));
      await runCuaCommand('run_command', { command: `mkdir -p ${shellSingleQuote(cuaDir)}` });

      const fileBuffer = fs.readFileSync(agentFile);
      const base64Content = fileBuffer.toString('base64');
      const CHUNK_SIZE = 64 * 1024;

      if (base64Content.length <= CHUNK_SIZE) {
        await runCuaCommand('run_command', {
          command: `printf '%s' '${base64Content}' | base64 -d > ${shellSingleQuote(cuaDest)}`,
        });
      } else {
        const totalChunks = Math.ceil(base64Content.length / CHUNK_SIZE);
        for (let i = 0; i < totalChunks; i++) {
          const chunk = base64Content.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
          const redirect = i === 0 ? '>' : '>>';
          await runCuaCommand('run_command', {
            command: `printf '%s' '${chunk}' | base64 -d ${redirect} ${shellSingleQuote(cuaDest)}`,
          });
        }
      }

      return jsonResponse({ ok: true, name: filename, size: fileBuffer.length, path: cuaDest });
    }

    return jsonResponse({ error: 'direction must be cua-to-agent or agent-to-cua' }, 400);
  } catch (err) {
    return jsonResponse({ error: `transfer failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
  }
}

// ── Processes API handlers ────────────────────────────────────────────────

function handleProcessesList(): Response {
  const agents = getContainerStatus().map((c) => ({
    type: 'agent' as const,
    ...c,
  }));

  const sandboxRunning = isSandboxRunning();
  const processes = [
    ...agents,
    {
      type: 'sandbox' as const,
      groupFolder: 'cua-sandbox',
      containerId: CUA_SANDBOX_CONTAINER_NAME,
      lastUsed: '',
      idleSeconds: 0,
      running: sandboxRunning,
    },
  ];

  return jsonResponse(processes);
}

async function handleProcessKill(req: Request): Promise<Response> {
  const body = (await req.json()) as { groupFolder?: string; type?: string };
  if (!body.groupFolder) return jsonResponse({ error: 'groupFolder required' }, 400);

  if (body.type === 'sandbox' || body.groupFolder === 'cua-sandbox') {
    resetSandbox();
    return jsonResponse({ ok: true, action: 'killed', target: 'cua-sandbox' });
  }

  killContainer(body.groupFolder, 'dashboard force-kill');
  return jsonResponse({ ok: true, action: 'killed', target: body.groupFolder });
}

async function handleProcessRestart(req: Request): Promise<Response> {
  const body = (await req.json()) as { groupFolder?: string; type?: string };
  if (!body.groupFolder) return jsonResponse({ error: 'groupFolder required' }, 400);

  if (body.type === 'sandbox' || body.groupFolder === 'cua-sandbox') {
    resetSandbox();
    await ensureSandbox();
    return jsonResponse({ ok: true, action: 'restarted', target: 'cua-sandbox' });
  }

  killContainer(body.groupFolder, 'dashboard restart');
  return jsonResponse({ ok: true, action: 'restarted', target: body.groupFolder });
}

async function handleProcessInterrupt(req: Request): Promise<Response> {
  const body = (await req.json()) as { groupFolder?: string };
  if (!body.groupFolder) return jsonResponse({ error: 'groupFolder required' }, 400);

  const result = interruptContainer(body.groupFolder);
  return jsonResponse(result);
}

// ── Takeover API handlers ────────────────────────────────────────────────

function handleTakeoverList(): Response {
  const requests = getAllWaitingRequests().map((r) => ({
    requestId: r.requestId,
    groupFolder: r.groupFolder,
    token: r.token,
    createdAt: r.createdAt,
    message: r.message,
    vncPassword: r.vncPassword,
    liveViewUrl: getSandboxUrl(),
  }));
  return jsonResponse(requests);
}

function extractTakeoverToken(pathname: string): string | null {
  const prefix = '/api/cua/takeover/';
  if (!pathname.startsWith(prefix)) return null;
  const remainder = pathname.slice(prefix.length);
  if (!remainder || remainder.includes('/')) return null;
  try {
    return decodeURIComponent(remainder);
  } catch {
    return null;
  }
}

function extractContinueToken(pathname: string): string | null {
  const suffix = '/continue';
  const prefix = '/api/cua/takeover/';
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return null;
  const tokenPath = pathname.slice(prefix.length, -suffix.length);
  if (!tokenPath || tokenPath.includes('/')) return null;
  try {
    return decodeURIComponent(tokenPath);
  } catch {
    return null;
  }
}

function handleTakeoverStatus(token: string): Response {
  const pending = getWaitForUserRequestByToken(token);
  if (!pending) {
    return jsonResponse({
      status: 'not_found',
      liveViewUrl: getSandboxUrl(),
      vncPassword: null,
    }, 404);
  }
  resetIdleTimer();
  return jsonResponse({
    status: 'pending',
    requestId: pending.requestId,
    groupFolder: pending.groupFolder,
    message: pending.message,
    createdAt: pending.createdAt,
    liveViewUrl: getSandboxUrl(),
    vncPassword: pending.vncPassword,
  });
}

function handleTakeoverContinue(token: string): Response {
  const resolved = resolveWaitForUserByToken(token);
  if (!resolved) {
    return jsonResponse(
      { status: 'error', error: 'takeover session not found or already completed' },
      404,
    );
  }
  return jsonResponse({ status: 'ok', result: 'control returned to agent' });
}

// ── Dashboard HTML ──────────────────────────────────────────────────────

function renderDashboardPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <title>NanoClaw Dashboard</title>
  <script src="https://telegram.org/js/telegram-web-app.js"><\/script>
  <link rel="stylesheet" href="/assets/dashboard.css">
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/assets/dashboard.js"><\/script>
</body>
</html>`;
}

// ── Trajectory API handlers ──────────────────────────────────────────────

function handleTrajectorySessions(url: URL): Response {
  const group = url.searchParams.get('group') || 'main';
  const limit = parseInt(url.searchParams.get('limit') || '20', 10);
  const sessions = getTrajectorySessions(group, Math.min(limit, 100));
  return jsonResponse(sessions);
}

function handleTrajectorySession(url: URL): Response {
  const group = url.searchParams.get('group') || 'main';
  const sessionId = url.searchParams.get('id') || '';
  if (!sessionId) return jsonResponse({ error: 'missing id parameter' }, 400);
  const session = getTrajectorySession(group, sessionId);
  if (!session) return jsonResponse({ error: 'session not found' }, 404);
  return jsonResponse(session);
}

function handleTrajectoryStream(req: Request, url: URL): Response {
  const groupFolder = url.searchParams.get('group') || 'main';

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      function send(eventType: string, data: unknown) {
        try {
          controller.enqueue(
            encoder.encode(
              `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`,
            ),
          );
        } catch {
          // Stream closed
        }
      }

      // Send current active session as catch-up
      const active = getActiveSession(groupFolder);
      if (active) {
        for (const event of active.events) {
          send('activity', event);
        }
      }

      // Subscribe to new events
      const onActivity = (event: CuaActivityEvent) => {
        if (event.groupFolder === groupFolder) {
          send('activity', event);
        }
      };
      cuaActivityEmitter.on('activity', onActivity);

      // Heartbeat
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          clearInterval(heartbeat);
        }
      }, 15_000);

      // Cleanup on disconnect
      req.signal.addEventListener('abort', () => {
        cuaActivityEmitter.off('activity', onActivity);
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // Already closed
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}

// ── Request router ──────────────────────────────────────────────────────

function handleRequest(req: Request, server: import('bun').Server<NoVncWsData>): Response | Promise<Response> | undefined {
  const url = new URL(req.url);
  const { pathname } = url;

  // Static assets (no auth needed)
  if (pathname.startsWith('/assets/')) {
    const asset = serveStaticAsset(pathname);
    if (asset) return asset;
  }

  // Health check (no auth)
  if (pathname === '/healthz') {
    return jsonResponse({ ok: true, service: 'dashboard', authRequired: true });
  }

  // noVNC WebSocket proxy (no auth — within authenticated iframe)
  if (pathname === '/novnc/websockify' || pathname === '/websockify') {
    const upgraded = server.upgrade(req, { data: makeNoVncWsData() });
    return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 500 });
  }

  // noVNC HTTP proxy (no auth — within authenticated iframe)
  if (req.method === 'GET' && pathname.startsWith('/novnc/')) {
    return proxyNoVncHttp(pathname);
  }

  // HTML pages (no auth — JS handles it)
  if (pathname === '/' || pathname === '/app') {
    return htmlResponse(renderDashboardPage());
  }
  // Auth endpoint
  if (pathname === '/api/auth') {
    return handleAuth(url);
  }

  // All other /api/* require auth
  const session = authenticateRequest(req, url);
  if (!session) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  // CUA Trajectory API
  if (pathname === '/api/cua/trajectory/sessions') return handleTrajectorySessions(url);
  if (pathname === '/api/cua/trajectory/session') return handleTrajectorySession(url);
  if (pathname === '/api/cua/trajectory/stream') return handleTrajectoryStream(req, url);

  // Logs
  if (pathname === '/api/logs/stream') return handleSSEStream(req, url);
  if (pathname === '/api/logs') return handleLogsQuery(url);
  if (pathname === '/api/logs/stats') return handleLogStats();
  if (pathname.match(/^\/api\/logs\/\d+$/)) return handleLogDetail(pathname);

  // Containers
  if (pathname === '/api/containers' && !pathname.includes('/api/containers/'))
    return handleContainersList(url);
  if (pathname.startsWith('/api/containers/'))
    return handleContainerLog(pathname);

  // Tasks
  if (pathname === '/api/tasks') return handleTasksList(url);
  if (pathname === '/api/tasks/runs') return handleTaskRunLogsList(url);

  // Processes (live running containers)
  if (pathname === '/api/processes') return handleProcessesList();
  if (req.method === 'POST' && pathname === '/api/processes/kill') return handleProcessKill(req);
  if (req.method === 'POST' && pathname === '/api/processes/restart') return handleProcessRestart(req);
  if (req.method === 'POST' && pathname === '/api/processes/interrupt') return handleProcessInterrupt(req);

  // Files API — GET routes
  if (pathname === '/api/files/groups') return handleFilesGroupsList();
  if (pathname === '/api/files/cua/status') return handleCuaStatus();
  if (pathname === '/api/files/agent/list') return handleAgentFilesList(url);
  if (pathname === '/api/files/agent/download') return handleAgentFileDownload(url);
  if (pathname === '/api/files/agent/info') return handleAgentFileInfo(url);
  if (pathname === '/api/files/agent/search') return handleAgentFileSearch(url);
  if (pathname === '/api/files/cua/list') return handleCuaFilesList(url);
  if (pathname === '/api/files/cua/download') return handleCuaFileDownload(url);
  if (pathname === '/api/files/cua/search') return handleCuaFileSearch(url);

  // Files API — POST routes
  if (req.method === 'POST') {
    if (pathname === '/api/files/agent/upload') return handleAgentFileUpload(req);
    if (pathname === '/api/files/agent/mkdir') return handleAgentFileMkdir(req);
    if (pathname === '/api/files/agent/rename') return handleAgentFileRename(req);
    if (pathname === '/api/files/cua/upload') return handleCuaFileUpload(req);
    if (pathname === '/api/files/cua/mkdir') return handleCuaFileMkdir(req);
    if (pathname === '/api/files/cua/rename') return handleCuaFileRename(req);
    if (pathname === '/api/files/transfer') return handleFileTransfer(req);
    if (pathname === '/api/files/cua/start') return handleCuaStart();
  }

  // Files API — DELETE routes
  if (req.method === 'DELETE') {
    if (pathname === '/api/files/agent/delete') return handleAgentFileDelete(req);
    if (pathname === '/api/files/cua/delete') return handleCuaFileDelete(req);
  }

  // Takeover API
  if (pathname === '/api/cua/takeover/list') return handleTakeoverList();

  if (req.method === 'POST') {
    const continueToken = extractContinueToken(pathname);
    if (continueToken) return handleTakeoverContinue(continueToken);
  }

  if (req.method === 'GET') {
    const takeoverToken = extractTakeoverToken(pathname);
    if (takeoverToken) return handleTakeoverStatus(takeoverToken);
  }

  return new Response('Not Found', { status: 404 });
}

// ── Server lifecycle ────────────────────────────────────────────────────

export function getDashboardUrl(): string | null {
  if (!DASHBOARD_ENABLED) return null;
  if (DASHBOARD_URL) return DASHBOARD_URL.replace(/\/$/, '');
  const tsUrl = getTailscaleHttpsUrl(DASHBOARD_PORT);
  if (tsUrl) return tsUrl;
  const ip = getSandboxHostIp();
  const protocol =
    DASHBOARD_TLS_CERT && DASHBOARD_TLS_KEY ? 'https' : 'http';
  return `${protocol}://${ip}:${DASHBOARD_PORT}`;
}

export function startDashboardServer(): void {
  if (!DASHBOARD_ENABLED) {
    logger.info('Dashboard disabled by config');
    return;
  }
  if (dashboardServer) return;

  const tlsOptions =
    DASHBOARD_TLS_CERT &&
    DASHBOARD_TLS_KEY &&
    fs.existsSync(DASHBOARD_TLS_CERT) &&
    fs.existsSync(DASHBOARD_TLS_KEY)
      ? {
          tls: {
            cert: Bun.file(DASHBOARD_TLS_CERT),
            key: Bun.file(DASHBOARD_TLS_KEY),
          },
        }
      : {};

  dashboardServer = Bun.serve({
    hostname: '127.0.0.1',
    port: DASHBOARD_PORT,
    ...tlsOptions,
    fetch: handleRequest,
    websocket: createNoVncWebSocketHandler(),
  });

  sessionCleanupInterval = setInterval(() => {
    cleanExpiredSessions();
  }, 60 * 60 * 1000);

  logger.info(
    { port: DASHBOARD_PORT, url: getDashboardUrl() },
    'Dashboard server started',
  );
}

export function stopDashboardServer(): void {
  if (sessionCleanupInterval) {
    clearInterval(sessionCleanupInterval);
    sessionCleanupInterval = null;
  }
  if (!dashboardServer) return;
  dashboardServer.stop(true);
  dashboardServer = null;
  logger.info('Dashboard server stopped');
}
