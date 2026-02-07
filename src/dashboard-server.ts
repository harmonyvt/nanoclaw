import fs from 'fs';
import path from 'path';

import {
  DASHBOARD_ENABLED,
  DASHBOARD_PORT,
  DASHBOARD_TLS_CERT,
  DASHBOARD_TLS_KEY,
  DASHBOARD_URL,
  GROUPS_DIR,
} from './config.js';
import { getSandboxHostIp, isSandboxRunning, ensureSandbox } from './sandbox-manager.js';
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
  getLogStats,
  queryContainerLogs,
  getAllTasks,
  getTaskRunLogs,
  getAllTaskRunLogs,
} from './db.js';
import { runCuaCommand, shellSingleQuote } from './browse-host.js';

let dashboardServer: ReturnType<typeof Bun.serve> | null = null;
let sessionCleanupInterval: ReturnType<typeof setInterval> | null = null;

const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_DOWNLOAD_SIZE = 100 * 1024 * 1024; // 100MB
const MAX_PREVIEW_TEXT = 10 * 1024; // 10KB
const MAX_PREVIEW_IMAGE = 2 * 1024 * 1024; // 2MB
const PROTECTED_FILES = ['CLAUDE.md', 'SOUL.md'];
const CUA_SAFE_ROOTS = ['/home/', '/tmp/', '/root/', '/var/', '/opt/'];

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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function authenticateRequest(
  req: Request,
  url: URL,
): { userId: number } | null {
  const authHeader = req.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    return validateSession(token);
  }
  const token = url.searchParams.get('token');
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
  return CUA_SAFE_ROOTS.some(root => p.startsWith(root)) || p === '/' || p === '~' || p.startsWith('~/');
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
  const cuaPath = url.searchParams.get('path') || '/root';

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
    const cuaPath = String(formData.get('path') || '/root/Downloads');
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
        command: `echo '${base64Content}' | base64 -d > ${shellSingleQuote(destPath)}`,
      });
    } else {
      const totalChunks = Math.ceil(base64Content.length / CHUNK_SIZE);
      for (let i = 0; i < totalChunks; i++) {
        const chunk = base64Content.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        const redirect = i === 0 ? '>' : '>>';
        await runCuaCommand('run_command', {
          command: `echo '${chunk}' | base64 -d ${redirect} ${shellSingleQuote(destPath)}`,
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
  const cuaPath = url.searchParams.get('path') || '/root';

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
      const cuaDest = destPath || `/root/Downloads/${filename}`;
      if (!validateCuaPath(cuaDest)) return jsonResponse({ error: 'invalid CUA destination' }, 400);

      const cuaDir = cuaDest.substring(0, cuaDest.lastIndexOf('/'));
      await runCuaCommand('run_command', { command: `mkdir -p ${shellSingleQuote(cuaDir)}` });

      const fileBuffer = fs.readFileSync(agentFile);
      const base64Content = fileBuffer.toString('base64');
      const CHUNK_SIZE = 64 * 1024;

      if (base64Content.length <= CHUNK_SIZE) {
        await runCuaCommand('run_command', {
          command: `echo '${base64Content}' | base64 -d > ${shellSingleQuote(cuaDest)}`,
        });
      } else {
        const totalChunks = Math.ceil(base64Content.length / CHUNK_SIZE);
        for (let i = 0; i < totalChunks; i++) {
          const chunk = base64Content.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
          const redirect = i === 0 ? '>' : '>>';
          await runCuaCommand('run_command', {
            command: `echo '${chunk}' | base64 -d ${redirect} ${shellSingleQuote(cuaDest)}`,
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

// ── Dashboard HTML ──────────────────────────────────────────────────────

function renderDashboardPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <title>NanoClaw Dashboard</title>
  <script src="https://telegram.org/js/telegram-web-app.js"><\/script>
  <style>
    :root {
      --bg: #0b1219;
      --panel: #16212c;
      --panel-2: #1d2b39;
      --text: #edf3f9;
      --muted: #9bb2c7;
      --accent: #38bdf8;
      --accent-2: #f59e0b;
      --ok: #22c55e;
      --danger: #ef4444;
      --radius: 12px;
      --level-trace: #94a3b8;
      --level-debug: #38bdf8;
      --level-info: #22c55e;
      --level-warn: #f59e0b;
      --level-error: #ef4444;
      --level-fatal: #dc2626;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: "Space Grotesk", -apple-system, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      -webkit-tap-highlight-color: transparent;
    }
    .mono { font-family: "IBM Plex Mono", "Menlo", "Consolas", monospace; }

    /* Header */
    .header {
      position: sticky; top: 0; z-index: 100;
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 16px;
      background: rgba(11,18,25,0.92);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid rgba(255,255,255,0.08);
      min-height: 48px;
    }
    .header-left { display: flex; align-items: center; gap: 10px; }
    .header h1 { font-size: 16px; font-weight: 600; letter-spacing: 0.02em; }
    .header-right { display: flex; align-items: center; gap: 8px; }
    .status-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--muted);
      transition: background 300ms;
    }
    .status-dot.live { background: var(--ok); box-shadow: 0 0 6px var(--ok); }
    .status-dot.error { background: var(--danger); }
    .status-label { font-size: 12px; color: var(--muted); }

    /* Tabs */
    .tabs {
      position: sticky; top: 48px; z-index: 99;
      display: flex;
      background: var(--panel);
      border-bottom: 1px solid rgba(255,255,255,0.08);
    }
    .tab {
      flex: 1;
      padding: 12px 8px;
      text-align: center;
      font-size: 13px; font-weight: 500;
      color: var(--muted);
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: color 200ms, border-color 200ms;
      min-height: 44px;
      display: flex; align-items: center; justify-content: center;
      user-select: none;
    }
    .tab.active { color: var(--accent); border-bottom-color: var(--accent); }

    /* Filter bar */
    .filters {
      display: flex; flex-wrap: wrap; gap: 8px;
      padding: 10px 12px;
      background: var(--panel);
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .filter-group { display: flex; align-items: center; gap: 4px; }
    .filter-group label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
    select, input[type="text"], input[type="datetime-local"] {
      background: var(--panel-2);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 8px;
      color: var(--text);
      padding: 6px 10px;
      font-size: 13px;
      min-height: 36px;
      outline: none;
    }
    select:focus, input:focus { border-color: var(--accent); }
    input[type="text"] { flex: 1; min-width: 120px; }
    .filter-expand {
      font-size: 12px; color: var(--accent); cursor: pointer;
      padding: 6px 8px; border: none; background: none;
      min-height: 36px;
    }
    .filters-advanced { display: none; width: 100%; }
    .filters-advanced.show { display: flex; flex-wrap: wrap; gap: 8px; }

    /* Tab panes */
    .pane { display: none; flex: 1; flex-direction: column; min-height: 0; }
    .pane.active { display: flex; }

    /* Log entries */
    .log-container {
      flex: 1; overflow-y: auto; overflow-x: hidden;
      padding: 4px 0;
      scroll-behavior: smooth;
    }
    .log-entry {
      display: flex; align-items: flex-start; gap: 6px;
      padding: 3px 12px;
      font-size: 12px;
      line-height: 1.5;
      border-bottom: 1px solid rgba(255,255,255,0.03);
    }
    .log-entry:hover { background: rgba(255,255,255,0.03); }
    .log-time { color: var(--muted); white-space: nowrap; flex-shrink: 0; }
    .log-level {
      display: inline-block; min-width: 44px;
      padding: 1px 6px; border-radius: 4px;
      text-align: center; font-size: 10px; font-weight: 600;
      text-transform: uppercase; flex-shrink: 0;
    }
    .log-level-10 { color: var(--level-trace); border: 1px solid var(--level-trace); }
    .log-level-20 { color: var(--level-debug); border: 1px solid var(--level-debug); }
    .log-level-30 { color: var(--level-info); border: 1px solid var(--level-info); }
    .log-level-40 { color: var(--level-warn); border: 1px solid var(--level-warn); background: rgba(245,158,11,0.1); }
    .log-level-50 { color: var(--level-error); border: 1px solid var(--level-error); background: rgba(239,68,68,0.1); }
    .log-level-60 { color: var(--level-fatal); border: 1px solid var(--level-fatal); background: rgba(220,38,38,0.15); }
    .log-module { color: var(--accent); font-size: 11px; flex-shrink: 0; }
    .log-msg { word-break: break-word; }
    .log-msg.mono { font-size: 12px; }

    /* Scroll to bottom button */
    .scroll-btn {
      position: fixed; bottom: 20px; right: 20px;
      width: 44px; height: 44px;
      border-radius: 50%; border: none;
      background: var(--accent); color: #041017;
      font-size: 20px; cursor: pointer;
      box-shadow: 0 4px 16px rgba(56,189,248,0.3);
      display: none; z-index: 50;
      align-items: center; justify-content: center;
    }
    .scroll-btn.show { display: flex; }

    /* Container / Task cards */
    .card-list { flex: 1; overflow-y: auto; padding: 8px 12px; }
    .card {
      background: var(--panel);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: var(--radius);
      padding: 12px;
      margin-bottom: 8px;
    }
    .card-header { display: flex; justify-content: space-between; align-items: center; }
    .card-title { font-size: 14px; font-weight: 600; }
    .card-meta { font-size: 12px; color: var(--muted); margin-top: 4px; }
    .badge {
      display: inline-block; padding: 2px 8px; border-radius: 6px;
      font-size: 11px; font-weight: 600;
    }
    .badge-ok { color: var(--ok); border: 1px solid var(--ok); }
    .badge-error { color: var(--danger); border: 1px solid var(--danger); }
    .badge-active { color: var(--accent); border: 1px solid var(--accent); }
    .badge-paused { color: var(--accent-2); border: 1px solid var(--accent-2); }
    .run-list { margin-top: 8px; }
    .run-item {
      display: flex; align-items: center; gap: 8px;
      padding: 4px 0;
      font-size: 12px; color: var(--muted);
      border-top: 1px solid rgba(255,255,255,0.04);
    }
    .run-item:first-child { border-top: none; }

    /* Empty state */
    .empty {
      display: flex; align-items: center; justify-content: center;
      flex: 1; color: var(--muted); font-size: 14px;
      padding: 40px 20px; text-align: center;
    }

    /* Auth screen */
    .auth-screen {
      display: flex; align-items: center; justify-content: center;
      flex: 1; padding: 40px 20px; text-align: center;
    }
    .auth-screen h2 { font-size: 20px; margin-bottom: 12px; }
    .auth-screen p { color: var(--muted); line-height: 1.6; max-width: 360px; }

    /* Loading */
    .loading { text-align: center; padding: 20px; color: var(--muted); font-size: 13px; }

    /* ── Files Tab ─────────────────────────────────────────── */
    .files-header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 8px 12px;
      background: var(--panel);
      border-bottom: 1px solid rgba(255,255,255,0.06);
      gap: 8px;
    }
    .source-toggle { display: flex; gap: 4px; flex-shrink: 0; }
    .source-btn {
      padding: 6px 14px; border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.1);
      background: var(--panel-2); color: var(--muted);
      font-size: 12px; font-weight: 500; cursor: pointer;
      transition: all 200ms; white-space: nowrap;
    }
    .source-btn.active {
      color: var(--accent); border-color: var(--accent);
      background: rgba(56,189,248,0.1);
    }
    .source-btn .sdot {
      display: inline-block; width: 6px; height: 6px;
      border-radius: 50%; margin-left: 4px; vertical-align: middle;
    }
    .sdot.on { background: var(--ok); }
    .sdot.off { background: var(--danger); }
    .files-actions { display: flex; gap: 4px; }
    .files-action-btn {
      padding: 6px 12px; border-radius: 8px; border: none;
      background: var(--panel-2); color: var(--accent);
      font-size: 12px; font-weight: 500; cursor: pointer;
      transition: background 200ms;
    }
    .files-action-btn:hover { background: rgba(56,189,248,0.15); }
    .files-group-bar {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 12px;
      background: var(--panel);
      border-bottom: 1px solid rgba(255,255,255,0.04);
      font-size: 12px;
    }
    .files-group-bar label { color: var(--muted); font-size: 11px; text-transform: uppercase; }
    .files-group-bar select { font-size: 12px; padding: 4px 8px; min-height: 28px; }
    .files-search-bar {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 12px;
      background: var(--panel);
      border-bottom: 1px solid rgba(255,255,255,0.04);
    }
    .files-search-bar input {
      flex: 1; background: var(--panel-2);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 8px; color: var(--text);
      padding: 6px 10px; font-size: 12px; min-height: 32px; outline: none;
    }
    .files-search-bar input:focus { border-color: var(--accent); }
    .breadcrumb {
      display: flex; align-items: center; gap: 2px;
      padding: 6px 12px; font-size: 12px; color: var(--muted);
      overflow-x: auto; white-space: nowrap;
      background: var(--bg);
      border-bottom: 1px solid rgba(255,255,255,0.04);
      -webkit-overflow-scrolling: touch;
    }
    .bc-seg { cursor: pointer; color: var(--accent); padding: 2px 4px; border-radius: 4px; }
    .bc-seg:hover { background: rgba(56,189,248,0.1); }
    .bc-sep { color: var(--muted); margin: 0 1px; font-size: 10px; }
    .bc-current { color: var(--text); font-weight: 500; }
    .file-list { flex: 1; overflow-y: auto; padding: 0; }
    .file-item {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 12px;
      border-bottom: 1px solid rgba(255,255,255,0.04);
      cursor: pointer; transition: background 150ms;
    }
    .file-item:hover { background: rgba(255,255,255,0.04); }
    .file-item:active { background: rgba(255,255,255,0.07); }
    .file-icon { font-size: 22px; width: 30px; text-align: center; flex-shrink: 0; line-height: 1; }
    .file-info { flex: 1; min-width: 0; }
    .file-name {
      font-size: 13px; font-weight: 500;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .file-name .protected-badge {
      display: inline-block; font-size: 10px; margin-left: 4px;
      color: var(--accent-2); vertical-align: middle;
    }
    .file-meta { font-size: 11px; color: var(--muted); margin-top: 2px; }
    .file-actions { display: flex; gap: 2px; flex-shrink: 0; }
    .fa-btn {
      width: 32px; height: 32px; border-radius: 8px; border: none;
      background: transparent; color: var(--muted); font-size: 15px;
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      transition: all 150ms;
    }
    .fa-btn:hover { color: var(--text); background: rgba(255,255,255,0.08); }
    .fa-btn.danger:hover { color: var(--danger); background: rgba(239,68,68,0.1); }
    .transfer-bar {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 12px;
      background: rgba(56,189,248,0.08);
      border-top: 1px solid rgba(56,189,248,0.3);
      font-size: 12px;
    }
    .transfer-bar .t-info { flex: 1; color: var(--text); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .transfer-bar .t-btn {
      padding: 6px 14px; border-radius: 8px; border: none;
      font-size: 12px; font-weight: 600; cursor: pointer;
    }
    .t-btn-go { background: var(--accent); color: #041017; }
    .t-btn-cancel { background: var(--panel-2); color: var(--muted); }
    .file-preview-modal {
      position: fixed; inset: 0; z-index: 200;
      background: rgba(0,0,0,0.9);
      display: flex; flex-direction: column;
    }
    .preview-header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 10px 16px; background: var(--panel);
      border-bottom: 1px solid rgba(255,255,255,0.08);
    }
    .preview-header .pv-name { font-size: 14px; font-weight: 500; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .preview-header .pv-actions { display: flex; gap: 6px; }
    .pv-btn {
      padding: 6px 12px; border-radius: 8px; border: none;
      font-size: 12px; cursor: pointer;
    }
    .pv-btn-dl { background: var(--accent); color: #041017; font-weight: 600; }
    .pv-btn-close { background: var(--panel-2); color: var(--muted); }
    .preview-content {
      flex: 1; overflow: auto; padding: 16px;
      display: flex; align-items: flex-start; justify-content: center;
    }
    .preview-content img { max-width: 100%; height: auto; border-radius: 8px; }
    .preview-content pre {
      font-family: "IBM Plex Mono", monospace; font-size: 12px;
      white-space: pre-wrap; word-break: break-word;
      color: var(--text); line-height: 1.6; width: 100%;
      background: var(--panel); padding: 12px; border-radius: 8px;
    }
    .preview-content .pv-info {
      text-align: center; color: var(--muted); padding: 40px 20px;
    }
    .cua-offline {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      flex: 1; gap: 16px; padding: 40px 20px; text-align: center;
    }
    .cua-offline p { color: var(--muted); font-size: 14px; }
    .cua-start-btn {
      padding: 10px 24px; border-radius: 10px; border: none;
      background: var(--accent); color: #041017;
      font-size: 14px; font-weight: 600; cursor: pointer;
    }
    .toast {
      position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%);
      background: var(--panel); color: var(--text);
      border: 1px solid rgba(255,255,255,0.12); border-radius: 10px;
      padding: 10px 20px; font-size: 13px; z-index: 300;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
      animation: toastIn 200ms ease-out;
    }
    @keyframes toastIn { from { opacity: 0; transform: translateX(-50%) translateY(10px); } }
    .ctx-menu {
      position: fixed; z-index: 250;
      background: var(--panel); border: 1px solid rgba(255,255,255,0.12);
      border-radius: var(--radius); min-width: 180px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      overflow: hidden;
    }
    .ctx-item {
      padding: 11px 14px; font-size: 13px; cursor: pointer;
      display: flex; align-items: center; gap: 10px;
      transition: background 100ms;
    }
    .ctx-item:hover { background: rgba(255,255,255,0.06); }
    .ctx-item.danger { color: var(--danger); }
    .ctx-sep { height: 1px; background: rgba(255,255,255,0.06); margin: 2px 0; }
  </style>
</head>
<body>

<div class="header">
  <div class="header-left">
    <h1>NanoClaw</h1>
  </div>
  <div class="header-right">
    <div class="status-dot" id="statusDot"></div>
    <span class="status-label" id="statusLabel">Connecting...</span>
  </div>
</div>

<div class="tabs" id="tabsBar">
  <div class="tab active" data-tab="logs">Logs</div>
  <div class="tab" data-tab="containers">Containers</div>
  <div class="tab" data-tab="tasks">Tasks</div>
  <div class="tab" data-tab="files">Files</div>
</div>

<!-- Filters (Logs tab) -->
<div class="filters" id="logFilters">
  <div class="filter-group">
    <label>Level</label>
    <select id="filterLevel">
      <option value="">All</option>
      <option value="10">Trace</option>
      <option value="20">Debug</option>
      <option value="30">Info</option>
      <option value="40">Warn</option>
      <option value="50">Error</option>
      <option value="60">Fatal</option>
    </select>
  </div>
  <div class="filter-group" style="flex:1">
    <input type="text" id="filterSearch" placeholder="Search logs...">
  </div>
  <button class="filter-expand" id="filterToggle">More</button>
  <div class="filters-advanced" id="filterAdvanced">
    <div class="filter-group">
      <label>Group</label>
      <select id="filterGroup"><option value="">All</option></select>
    </div>
  </div>
</div>

<!-- Logs pane -->
<div class="pane active" id="pane-logs">
  <div class="log-container" id="logContainer"></div>
</div>

<!-- Containers pane -->
<div class="pane" id="pane-containers">
  <div class="card-list" id="containerList">
    <div class="loading">Loading container runs...</div>
  </div>
</div>

<!-- Tasks pane -->
<div class="pane" id="pane-tasks">
  <div class="card-list" id="taskList">
    <div class="loading">Loading tasks...</div>
  </div>
</div>

<!-- Files pane -->
<div class="pane" id="pane-files">
  <div class="files-header">
    <div class="source-toggle">
      <button class="source-btn active" data-source="agent" id="srcAgent">Agent</button>
      <button class="source-btn" data-source="cua" id="srcCua">CUA <span class="sdot off" id="cuaDot"></span></button>
    </div>
    <div class="files-actions">
      <button class="files-action-btn" id="filesSearchToggle" title="Search">Search</button>
      <button class="files-action-btn" id="filesUploadBtn" title="Upload">Upload</button>
      <button class="files-action-btn" id="filesMkdirBtn" title="New folder">+ Folder</button>
    </div>
  </div>
  <div class="files-group-bar" id="filesGroupBar">
    <label>Group</label>
    <select id="filesGroup"></select>
  </div>
  <div class="files-search-bar" id="filesSearchBar" style="display:none">
    <input type="text" id="filesSearchInput" placeholder="Search files by name...">
  </div>
  <div class="breadcrumb" id="filesBreadcrumb"></div>
  <div class="file-list" id="fileList">
    <div class="empty">Select a source to browse files</div>
  </div>
  <div class="transfer-bar" id="transferBar" style="display:none">
    <span class="t-info" id="transferInfo"></span>
    <button class="t-btn t-btn-go" id="transferGo">Transfer Here</button>
    <button class="t-btn t-btn-cancel" id="transferCancel">Cancel</button>
  </div>
</div>

<!-- Hidden file input for uploads -->
<input type="file" id="fileInput" style="display:none" multiple>

<!-- Scroll to bottom -->
<button class="scroll-btn" id="scrollBtn">&#8595;</button>

<!-- Auth screen (hidden when authenticated) -->
<div class="auth-screen" id="authScreen" style="display:none">
  <div>
    <h2>NanoClaw Dashboard</h2>
    <p>Open this dashboard from Telegram using the <strong>/dashboard</strong> command for authenticated access.</p>
    <p style="margin-top:16px;font-size:12px;color:var(--muted)">Direct browser access is available when authentication is disabled.</p>
  </div>
</div>

<script>
(function() {
  var LEVEL_NAMES = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' };
  var MAX_LOG_ENTRIES = 2000;

  var authToken = null;
  var lastLogId = 0;
  var autoScroll = true;
  var currentTab = 'logs';
  var eventSource = null;
  var searchTimeout = null;
  var isSearchMode = false;

  var $ = function(id) { return document.getElementById(id); };
  var statusDot = $('statusDot');
  var statusLabel = $('statusLabel');
  var logContainer = $('logContainer');
  var scrollBtn = $('scrollBtn');
  var logFilters = $('logFilters');
  var authScreen = $('authScreen');
  var tabsBar = $('tabsBar');

  function authHeaders() {
    return authToken && authToken !== 'dev' ? { 'Authorization': 'Bearer ' + authToken } : {};
  }

  // ── Telegram WebApp Auth ─────────────────────────────────────
  async function authenticate() {
    var tg = window.Telegram && window.Telegram.WebApp;
    if (tg && tg.initData) {
      tg.ready();
      tg.expand();
      try { tg.setHeaderColor('#0b1219'); } catch(e) {}
      try { tg.setBackgroundColor('#0b1219'); } catch(e) {}

      try {
        var res = await fetch('/api/auth?initData=' + encodeURIComponent(tg.initData));
        if (res.ok) {
          var data = await res.json();
          authToken = data.token;
          return true;
        }
      } catch(e) {}
      return false;
    }

    try {
      var res2 = await fetch('/healthz');
      if (res2.ok) {
        var data2 = await res2.json();
        if (data2.authRequired === false) {
          authToken = 'dev';
          return true;
        }
      }
    } catch(e) {}
    return false;
  }

  // ── SSE Connection ───────────────────────────────────────────
  function connectSSE() {
    if (eventSource) { eventSource.close(); eventSource = null; }
    if (!authToken) return;

    var url = '/api/logs/stream?token=' + encodeURIComponent(authToken) + '&afterId=' + lastLogId;
    eventSource = new EventSource(url);

    eventSource.addEventListener('log', function(e) {
      try {
        var log = JSON.parse(e.data);
        if (log.id > lastLogId) lastLogId = log.id;
        if (!isSearchMode) appendLogEntry(log);
      } catch(err) {}
    });

    eventSource.onopen = function() {
      statusDot.className = 'status-dot live';
      statusLabel.textContent = 'Live';
    };

    eventSource.onerror = function() {
      statusDot.className = 'status-dot error';
      statusLabel.textContent = 'Reconnecting...';
      eventSource.close();
      eventSource = null;
      setTimeout(connectSSE, 3000);
    };
  }

  // ── Log Rendering ────────────────────────────────────────────
  function formatTime(ts) {
    var d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function appendLogEntry(log) {
    var el = document.createElement('div');
    el.className = 'log-entry';
    var level = log.level || 30;
    var levelName = LEVEL_NAMES[level] || 'LOG';
    var timeStr = formatTime(log.time);
    var module = log.module || '';
    var msg = log.msg || '';
    el.innerHTML =
      '<span class="log-time mono">' + timeStr + '</span>' +
      '<span class="log-level log-level-' + level + '">' + levelName + '</span>' +
      (module ? '<span class="log-module mono">' + escapeH(module) + '</span>' : '') +
      '<span class="log-msg mono">' + escapeH(msg) + '</span>';
    logContainer.appendChild(el);
    while (logContainer.children.length > MAX_LOG_ENTRIES) {
      logContainer.removeChild(logContainer.firstChild);
    }
    if (autoScroll) { logContainer.scrollTop = logContainer.scrollHeight; }
  }

  function escapeH(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // ── Auto-scroll detection ────────────────────────────────────
  logContainer.addEventListener('scroll', function() {
    var atBottom = logContainer.scrollHeight - logContainer.scrollTop - logContainer.clientHeight < 60;
    autoScroll = atBottom;
    scrollBtn.className = atBottom ? 'scroll-btn' : 'scroll-btn show';
  });

  scrollBtn.addEventListener('click', function() {
    autoScroll = true;
    logContainer.scrollTop = logContainer.scrollHeight;
    scrollBtn.className = 'scroll-btn';
  });

  // ── Tabs ─────────────────────────────────────────────────────
  tabsBar.addEventListener('click', function(e) {
    var tab = e.target.closest('.tab');
    if (!tab) return;
    var name = tab.dataset.tab;
    if (name === currentTab) return;

    document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
    document.querySelectorAll('.pane').forEach(function(p) { p.classList.remove('active'); });
    tab.classList.add('active');
    $('pane-' + name).classList.add('active');
    logFilters.style.display = name === 'logs' ? '' : 'none';
    currentTab = name;

    if (name === 'containers') loadContainers();
    if (name === 'tasks') loadTasks();
    if (name === 'files') initFiles();
  });

  // ── Filters ──────────────────────────────────────────────────
  $('filterToggle').addEventListener('click', function() {
    $('filterAdvanced').classList.toggle('show');
    this.textContent = $('filterAdvanced').classList.contains('show') ? 'Less' : 'More';
  });

  function getFilterParams() {
    var params = new URLSearchParams();
    var level = $('filterLevel').value;
    var search = $('filterSearch').value;
    var group = $('filterGroup').value;
    if (level) params.set('level', level);
    if (search) params.set('search', search);
    if (group) params.set('group', group);
    params.set('limit', '200');
    return params;
  }

  function applyFilters() {
    var level = $('filterLevel').value;
    var search = $('filterSearch').value;
    var group = $('filterGroup').value;

    if (!level && !search && !group) { isSearchMode = false; return; }
    isSearchMode = true;
    logContainer.innerHTML = '<div class="loading">Searching...</div>';

    fetch('/api/logs?' + getFilterParams().toString(), { headers: authHeaders() })
      .then(function(r) { return r.json(); })
      .then(function(logs) {
        logContainer.innerHTML = '';
        if (logs.length === 0) { logContainer.innerHTML = '<div class="empty">No matching logs found</div>'; return; }
        logs.reverse().forEach(function(log) { appendLogEntry(log); });
      })
      .catch(function() { logContainer.innerHTML = '<div class="empty">Search failed</div>'; });
  }

  $('filterLevel').addEventListener('change', applyFilters);
  $('filterGroup').addEventListener('change', applyFilters);
  $('filterSearch').addEventListener('input', function() {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(applyFilters, 300);
  });

  // ── Containers Tab ───────────────────────────────────────────
  function loadContainers() {
    var list = $('containerList');
    list.innerHTML = '<div class="loading">Loading...</div>';
    fetch('/api/containers?limit=50', { headers: authHeaders() })
      .then(function(r) { return r.json(); })
      .then(function(containers) {
        list.innerHTML = '';
        if (containers.length === 0) { list.innerHTML = '<div class="empty">No container runs found</div>'; return; }
        containers.forEach(function(c) {
          var statusClass = c.status === 'error' || (c.exit_code && c.exit_code !== 0) ? 'badge-error' : 'badge-ok';
          var statusText = c.status || (c.exit_code === 0 ? 'ok' : c.exit_code !== null ? 'exit ' + c.exit_code : 'unknown');
          var dur = c.duration_ms ? (c.duration_ms / 1000).toFixed(1) + 's' : '\\u2014';
          var time = c.timestamp ? timeAgo(c.timestamp) : '\\u2014';
          var size = c.file_size ? formatBytes(c.file_size) : '';
          var card = document.createElement('div');
          card.className = 'card';
          card.innerHTML =
            '<div class="card-header"><span class="card-title">' + escapeH(c.group_folder) + '</span><span class="badge ' + statusClass + '">' + escapeH(statusText) + '</span></div>' +
            '<div class="card-meta">' + (c.mode ? escapeH(c.mode) + ' \\u00B7 ' : '') + 'Duration: ' + dur + ' \\u00B7 ' + time + (size ? ' \\u00B7 ' + size : '') + '</div>';
          list.appendChild(card);
        });
      })
      .catch(function() { list.innerHTML = '<div class="empty">Failed to load containers</div>'; });
  }

  // ── Tasks Tab ────────────────────────────────────────────────
  function loadTasks() {
    var list = $('taskList');
    list.innerHTML = '<div class="loading">Loading...</div>';
    fetch('/api/tasks', { headers: authHeaders() })
      .then(function(r) { return r.json(); })
      .then(function(tasks) {
        list.innerHTML = '';
        if (tasks.length === 0) { list.innerHTML = '<div class="empty">No scheduled tasks</div>'; return; }
        tasks.forEach(function(t) {
          var statusClass = t.status === 'active' ? 'badge-active' : t.status === 'paused' ? 'badge-paused' : 'badge-ok';
          var nextRun = t.next_run ? timeAgo(t.next_run) : '\\u2014';
          var runsHtml = '';
          if (t.recent_runs && t.recent_runs.length > 0) {
            runsHtml = '<div class="run-list">';
            t.recent_runs.forEach(function(r) {
              var rStatus = r.status === 'error' ? 'badge-error' : 'badge-ok';
              var dur = (r.duration_ms / 1000).toFixed(1) + 's';
              var time = timeAgo(r.run_at);
              runsHtml += '<div class="run-item"><span class="badge ' + rStatus + '">' + escapeH(r.status) + '</span><span>' + dur + '</span><span>' + time + '</span>' + (r.error ? '<span style="color:var(--danger);font-size:11px">' + escapeH(r.error.slice(0,60)) + '</span>' : '') + '</div>';
            });
            runsHtml += '</div>';
          }
          var card = document.createElement('div');
          card.className = 'card';
          card.innerHTML =
            '<div class="card-header"><span class="card-title">' + escapeH(truncate(t.prompt, 60)) + '</span><span class="badge ' + statusClass + '">' + escapeH(t.status) + '</span></div>' +
            '<div class="card-meta">' + escapeH(t.schedule_type) + ': ' + escapeH(t.schedule_value) + ' \\u00B7 Group: ' + escapeH(t.group_folder) + ' \\u00B7 Next: ' + nextRun + '</div>' +
            runsHtml;
          list.appendChild(card);
        });
      })
      .catch(function() { list.innerHTML = '<div class="empty">Failed to load tasks</div>'; });
  }

  // ── Files Tab ────────────────────────────────────────────────
  var filesSource = 'agent';
  var filesGroup = 'main';
  var filesPath = '.';
  var cuaPath = '/root';
  var cuaRunning = false;
  var filesClipboard = null; // { source, path, name }
  var filesInited = false;
  var filesSearchVisible = false;
  var filesSearchTimer = null;

  var FILE_ICONS = {
    directory: '\\uD83D\\uDCC1', image: '\\uD83D\\uDDBC', video: '\\uD83C\\uDFA5',
    audio: '\\uD83C\\uDFB5', pdf: '\\uD83D\\uDCC4', archive: '\\uD83D\\uDCE6',
    code: '\\uD83D\\uDCBB', text: '\\uD83D\\uDCC3', markdown: '\\uD83D\\uDCDD',
    default: '\\uD83D\\uDCC4'
  };

  function getFileIcon(name, type) {
    if (type === 'directory') return FILE_ICONS.directory;
    var ext = (name.split('.').pop() || '').toLowerCase();
    if (['png','jpg','jpeg','gif','webp','svg','bmp'].indexOf(ext) >= 0) return FILE_ICONS.image;
    if (['mp4','mov','avi','webm','mkv'].indexOf(ext) >= 0) return FILE_ICONS.video;
    if (['mp3','ogg','wav','flac','m4a'].indexOf(ext) >= 0) return FILE_ICONS.audio;
    if (ext === 'pdf') return FILE_ICONS.pdf;
    if (['zip','tar','gz','7z','rar','bz2','tgz'].indexOf(ext) >= 0) return FILE_ICONS.archive;
    if (['ts','js','py','rs','go','java','c','cpp','h','sh','rb','swift','jsx','tsx'].indexOf(ext) >= 0) return FILE_ICONS.code;
    if (['md','markdown'].indexOf(ext) >= 0) return FILE_ICONS.markdown;
    if (['txt','log','csv','json','yaml','yml','xml','html','css','ini','conf','toml','env'].indexOf(ext) >= 0) return FILE_ICONS.text;
    return FILE_ICONS.default;
  }

  function showToast(msg) {
    var existing = document.querySelector('.toast');
    if (existing) existing.remove();
    var t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function() { t.remove(); }, 2500);
  }

  function initFiles() {
    if (!filesInited) {
      filesInited = true;
      loadFileGroups();
      checkCuaStatus();
    }
    loadFiles();
  }

  function loadFileGroups() {
    fetch('/api/files/groups', { headers: authHeaders() })
      .then(function(r) { return r.json(); })
      .then(function(groups) {
        var sel = $('filesGroup');
        sel.innerHTML = '';
        groups.forEach(function(g) {
          var opt = document.createElement('option');
          opt.value = g.name;
          opt.textContent = g.name;
          if (g.name === filesGroup) opt.selected = true;
          sel.appendChild(opt);
        });
      })
      .catch(function() {});
  }

  function checkCuaStatus() {
    fetch('/api/files/cua/status', { headers: authHeaders() })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        cuaRunning = d.running;
        $('cuaDot').className = 'sdot ' + (cuaRunning ? 'on' : 'off');
      })
      .catch(function() {});
  }

  function loadFiles() {
    if (filesSource === 'agent') {
      loadAgentFiles();
    } else {
      if (!cuaRunning) {
        renderCuaOffline();
      } else {
        loadCuaFiles();
      }
    }
    renderBreadcrumb();
    $('filesGroupBar').style.display = filesSource === 'agent' ? '' : 'none';
  }

  function loadAgentFiles() {
    var list = $('fileList');
    list.innerHTML = '<div class="loading">Loading...</div>';
    var url = '/api/files/agent/list?group=' + encodeURIComponent(filesGroup) + '&path=' + encodeURIComponent(filesPath);
    fetch(url, { headers: authHeaders() })
      .then(function(r) { return r.json(); })
      .then(function(files) { renderFileList(files, 'agent'); })
      .catch(function() { list.innerHTML = '<div class="empty">Failed to load files</div>'; });
  }

  function loadCuaFiles() {
    var list = $('fileList');
    list.innerHTML = '<div class="loading">Loading...</div>';
    var url = '/api/files/cua/list?path=' + encodeURIComponent(cuaPath);
    fetch(url, { headers: authHeaders() })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.error) { list.innerHTML = '<div class="empty">' + escapeH(data.error) + '</div>'; return; }
        renderFileList(data, 'cua');
      })
      .catch(function() { list.innerHTML = '<div class="empty">Failed to load CUA files</div>'; });
  }

  function renderCuaOffline() {
    var list = $('fileList');
    list.innerHTML = '<div class="cua-offline"><p>CUA Sandbox is not running</p><button class="cua-start-btn" id="cuaStartBtn">Start Sandbox</button></div>';
    $('cuaStartBtn').addEventListener('click', function() {
      this.textContent = 'Starting...';
      this.disabled = true;
      fetch('/api/files/cua/start', { method: 'POST', headers: authHeaders() })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          if (d.ok) { cuaRunning = true; $('cuaDot').className = 'sdot on'; loadCuaFiles(); showToast('Sandbox started'); }
          else { showToast('Failed: ' + (d.error || 'unknown')); }
        })
        .catch(function() { showToast('Failed to start sandbox'); })
        .finally(function() { var btn = $('cuaStartBtn'); if(btn) { btn.textContent = 'Start Sandbox'; btn.disabled = false; } });
    });
  }

  var PROTECTED = ['CLAUDE.md', 'SOUL.md'];

  function renderFileList(files, source) {
    var list = $('fileList');
    list.innerHTML = '';
    if (!files || files.length === 0) {
      list.innerHTML = '<div class="empty">Empty directory</div>';
      return;
    }
    files.forEach(function(f) {
      var item = document.createElement('div');
      item.className = 'file-item';
      var icon = getFileIcon(f.name, f.type);
      var isProtected = PROTECTED.indexOf(f.name) >= 0;
      var size = f.type === 'file' ? formatBytes(f.size) : '';
      var mod = f.modified ? timeAgo(f.modified) : '';
      var meta = [size, mod].filter(Boolean).join(' \\u00B7 ');

      var actionsHtml = '<div class="file-actions">';
      if (f.type === 'file') {
        actionsHtml += '<button class="fa-btn" data-action="download" title="Download">\\u2B07</button>';
        actionsHtml += '<button class="fa-btn" data-action="transfer" title="Transfer">\\u21C4</button>';
      }
      if (!isProtected) {
        actionsHtml += '<button class="fa-btn danger" data-action="delete" title="Delete">\\u2715</button>';
      }
      actionsHtml += '</div>';

      item.innerHTML =
        '<span class="file-icon">' + icon + '</span>' +
        '<div class="file-info"><div class="file-name">' + escapeH(f.name) + (isProtected ? '<span class="protected-badge">\\uD83D\\uDD12</span>' : '') + '</div>' +
        '<div class="file-meta">' + meta + (f.permissions ? ' \\u00B7 ' + f.permissions : '') + '</div></div>' +
        actionsHtml;

      item.dataset.name = f.name;
      item.dataset.type = f.type;
      item.dataset.path = f.path;
      item.dataset.source = source;

      // Click directory to navigate
      item.addEventListener('click', function(e) {
        if (e.target.closest('.fa-btn')) return;
        if (f.type === 'directory') {
          if (source === 'agent') { filesPath = f.path; }
          else { cuaPath = f.path; }
          loadFiles();
        } else {
          openPreview(f, source);
        }
      });

      // Action buttons
      item.querySelectorAll('.fa-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          var action = btn.dataset.action;
          if (action === 'download') downloadFile(f, source);
          else if (action === 'transfer') startTransfer(f, source);
          else if (action === 'delete') deleteFile(f, source);
        });
      });

      list.appendChild(item);
    });
  }

  function renderBreadcrumb() {
    var bc = $('filesBreadcrumb');
    bc.innerHTML = '';
    if (filesSource === 'agent') {
      var parts = filesPath === '.' ? [] : filesPath.split('/').filter(Boolean);
      var rootSeg = document.createElement('span');
      rootSeg.className = 'bc-seg';
      rootSeg.textContent = filesGroup;
      rootSeg.addEventListener('click', function() { filesPath = '.'; loadFiles(); });
      bc.appendChild(rootSeg);
      var accumulated = '';
      parts.forEach(function(p, i) {
        var sep = document.createElement('span');
        sep.className = 'bc-sep';
        sep.textContent = '/';
        bc.appendChild(sep);
        accumulated += (accumulated ? '/' : '') + p;
        var seg = document.createElement('span');
        if (i === parts.length - 1) {
          seg.className = 'bc-current';
          seg.textContent = p;
        } else {
          seg.className = 'bc-seg';
          seg.textContent = p;
          var target = accumulated;
          seg.addEventListener('click', function() { filesPath = target; loadFiles(); });
        }
        bc.appendChild(seg);
      });
    } else {
      var cParts = cuaPath.split('/').filter(Boolean);
      var cRoot = document.createElement('span');
      cRoot.className = 'bc-seg';
      cRoot.textContent = '/';
      cRoot.addEventListener('click', function() { cuaPath = '/'; loadFiles(); });
      bc.appendChild(cRoot);
      var cAcc = '';
      cParts.forEach(function(p, i) {
        var sep = document.createElement('span');
        sep.className = 'bc-sep';
        sep.textContent = '/';
        bc.appendChild(sep);
        cAcc += '/' + p;
        var seg = document.createElement('span');
        if (i === cParts.length - 1) {
          seg.className = 'bc-current';
          seg.textContent = p;
        } else {
          seg.className = 'bc-seg';
          seg.textContent = p;
          var target = cAcc;
          seg.addEventListener('click', function() { cuaPath = target; loadFiles(); });
        }
        bc.appendChild(seg);
      });
    }
  }

  function downloadFile(f, source) {
    var url;
    if (source === 'agent') {
      url = '/api/files/agent/download?group=' + encodeURIComponent(filesGroup) + '&path=' + encodeURIComponent(f.path);
    } else {
      url = '/api/files/cua/download?path=' + encodeURIComponent(f.path);
    }
    // Use token in URL for direct download
    if (authToken && authToken !== 'dev') url += '&token=' + encodeURIComponent(authToken);
    var a = document.createElement('a');
    a.href = url;
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function startTransfer(f, source) {
    filesClipboard = { source: source, path: f.path, name: f.name, group: filesGroup };
    var targetLabel = source === 'agent' ? 'CUA' : 'Agent';
    $('transferInfo').textContent = f.name + ' \\u2192 ' + targetLabel;
    $('transferBar').style.display = '';
    showToast('Switch to ' + targetLabel + ' and navigate to destination');
  }

  $('transferGo').addEventListener('click', function() {
    if (!filesClipboard) return;
    var clip = filesClipboard;
    var direction, destPath;
    if (clip.source === 'agent' && filesSource === 'cua') {
      direction = 'agent-to-cua';
      destPath = cuaPath;
    } else if (clip.source === 'cua' && filesSource === 'agent') {
      direction = 'cua-to-agent';
      destPath = filesPath === '.' ? 'media' : filesPath;
    } else {
      showToast('Switch to the other source first');
      return;
    }
    $('transferGo').textContent = 'Transferring...';
    $('transferGo').disabled = true;

    fetch('/api/files/transfer', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify({ direction: direction, sourcePath: clip.path, destPath: destPath, group: clip.source === 'agent' ? clip.group : filesGroup })
    })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.ok) { showToast('Transferred ' + d.name + ' (' + formatBytes(d.size) + ')'); loadFiles(); }
        else { showToast('Error: ' + (d.error || 'unknown')); }
      })
      .catch(function() { showToast('Transfer failed'); })
      .finally(function() {
        filesClipboard = null;
        $('transferBar').style.display = 'none';
        $('transferGo').textContent = 'Transfer Here';
        $('transferGo').disabled = false;
      });
  });

  $('transferCancel').addEventListener('click', function() {
    filesClipboard = null;
    $('transferBar').style.display = 'none';
  });

  function deleteFile(f, source) {
    if (!confirm('Delete ' + f.name + '?')) return;
    var url, opts;
    if (source === 'agent') {
      url = '/api/files/agent/delete';
      opts = { method: 'DELETE', headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()), body: JSON.stringify({ group: filesGroup, path: f.path }) };
    } else {
      url = '/api/files/cua/delete';
      opts = { method: 'DELETE', headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()), body: JSON.stringify({ path: f.path }) };
    }
    fetch(url, opts)
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.ok) { showToast('Deleted ' + f.name); loadFiles(); }
        else { showToast('Error: ' + (d.error || 'unknown')); }
      })
      .catch(function() { showToast('Delete failed'); });
  }

  function openPreview(f, source) {
    if (source === 'agent') {
      var url = '/api/files/agent/info?group=' + encodeURIComponent(filesGroup) + '&path=' + encodeURIComponent(f.path);
      fetch(url, { headers: authHeaders() })
        .then(function(r) { return r.json(); })
        .then(function(info) { showPreviewModal(info, f, source); })
        .catch(function() { showToast('Failed to load preview'); });
    } else {
      // For CUA files, show basic info
      showPreviewModal({ name: f.name, size: f.size, modified: f.modified, isPreviewable: false, mimeType: '' }, f, source);
    }
  }

  function showPreviewModal(info, f, source) {
    var existing = document.querySelector('.file-preview-modal');
    if (existing) existing.remove();

    var modal = document.createElement('div');
    modal.className = 'file-preview-modal';

    var contentHtml = '';
    if (info.isPreviewable && info.preview) {
      if (typeof info.preview === 'string' && info.preview.startsWith('data:image')) {
        contentHtml = '<img src="' + info.preview + '" alt="' + escapeH(info.name) + '">';
      } else {
        contentHtml = '<pre>' + escapeH(info.preview) + '</pre>';
      }
    } else {
      contentHtml = '<div class="pv-info"><p style="font-size:40px;margin-bottom:12px">' + getFileIcon(f.name, 'file') + '</p>' +
        '<p><strong>' + escapeH(info.name) + '</strong></p>' +
        '<p style="margin-top:8px">' + formatBytes(info.size || 0) + (info.modified ? ' \\u00B7 ' + timeAgo(info.modified) : '') + '</p>' +
        (info.mimeType ? '<p style="margin-top:4px;font-size:12px">' + escapeH(info.mimeType) + '</p>' : '') +
        '</div>';
    }

    modal.innerHTML =
      '<div class="preview-header">' +
        '<span class="pv-name">' + escapeH(info.name) + '</span>' +
        '<div class="pv-actions">' +
          '<button class="pv-btn pv-btn-dl" id="pvDownload">Download</button>' +
          '<button class="pv-btn pv-btn-close" id="pvClose">Close</button>' +
        '</div>' +
      '</div>' +
      '<div class="preview-content">' + contentHtml + '</div>';

    document.body.appendChild(modal);

    $('pvClose').addEventListener('click', function() { modal.remove(); });
    $('pvDownload').addEventListener('click', function() { downloadFile(f, source); });
    modal.addEventListener('click', function(e) { if (e.target === modal) modal.remove(); });
  }

  // Source toggle
  $('srcAgent').addEventListener('click', function() {
    if (filesSource === 'agent') return;
    filesSource = 'agent';
    $('srcAgent').classList.add('active');
    $('srcCua').classList.remove('active');
    loadFiles();
  });
  $('srcCua').addEventListener('click', function() {
    if (filesSource === 'cua') return;
    filesSource = 'cua';
    checkCuaStatus();
    $('srcCua').classList.add('active');
    $('srcAgent').classList.remove('active');
    loadFiles();
  });

  // Group selector
  $('filesGroup').addEventListener('change', function() {
    filesGroup = this.value;
    filesPath = '.';
    loadFiles();
  });

  // Upload
  $('filesUploadBtn').addEventListener('click', function() { $('fileInput').click(); });
  $('fileInput').addEventListener('change', function() {
    var files = this.files;
    if (!files || files.length === 0) return;
    var formData = new FormData();
    if (filesSource === 'agent') {
      formData.append('group', filesGroup);
      formData.append('path', filesPath);
    } else {
      formData.append('path', cuaPath);
    }
    // Upload first file (multi-file: loop)
    for (var i = 0; i < files.length; i++) {
      var fd = new FormData();
      if (filesSource === 'agent') { fd.append('group', filesGroup); fd.append('path', filesPath); }
      else { fd.append('path', cuaPath); }
      fd.append('file', files[i]);
      var url = filesSource === 'agent' ? '/api/files/agent/upload' : '/api/files/cua/upload';
      fetch(url, { method: 'POST', headers: authHeaders(), body: fd })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          if (d.ok) showToast('Uploaded ' + d.name);
          else showToast('Error: ' + (d.error || 'unknown'));
          loadFiles();
        })
        .catch(function() { showToast('Upload failed'); });
    }
    this.value = '';
  });

  // Mkdir
  $('filesMkdirBtn').addEventListener('click', function() {
    var name = prompt('New folder name:');
    if (!name || !name.trim()) return;
    name = name.trim();
    if (filesSource === 'agent') {
      var newPath = (filesPath === '.' ? '' : filesPath + '/') + name;
      fetch('/api/files/agent/mkdir', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
        body: JSON.stringify({ group: filesGroup, path: newPath })
      })
        .then(function(r) { return r.json(); })
        .then(function(d) { if (d.ok) { showToast('Created ' + name); loadFiles(); } else showToast(d.error || 'failed'); })
        .catch(function() { showToast('Failed'); });
    } else {
      var cNewPath = (cuaPath.endsWith('/') ? cuaPath : cuaPath + '/') + name;
      fetch('/api/files/cua/mkdir', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
        body: JSON.stringify({ path: cNewPath })
      })
        .then(function(r) { return r.json(); })
        .then(function(d) { if (d.ok) { showToast('Created ' + name); loadFiles(); } else showToast(d.error || 'failed'); })
        .catch(function() { showToast('Failed'); });
    }
  });

  // Search toggle
  $('filesSearchToggle').addEventListener('click', function() {
    filesSearchVisible = !filesSearchVisible;
    $('filesSearchBar').style.display = filesSearchVisible ? '' : 'none';
    if (filesSearchVisible) $('filesSearchInput').focus();
    else { $('filesSearchInput').value = ''; loadFiles(); }
  });

  $('filesSearchInput').addEventListener('input', function() {
    clearTimeout(filesSearchTimer);
    var q = this.value.trim();
    if (!q) { loadFiles(); return; }
    filesSearchTimer = setTimeout(function() {
      var list = $('fileList');
      list.innerHTML = '<div class="loading">Searching...</div>';
      var url;
      if (filesSource === 'agent') {
        url = '/api/files/agent/search?group=' + encodeURIComponent(filesGroup) + '&q=' + encodeURIComponent(q);
      } else {
        url = '/api/files/cua/search?path=' + encodeURIComponent(cuaPath) + '&q=' + encodeURIComponent(q);
      }
      fetch(url, { headers: authHeaders() })
        .then(function(r) { return r.json(); })
        .then(function(results) {
          if (results.error) { list.innerHTML = '<div class="empty">' + escapeH(results.error) + '</div>'; return; }
          renderFileList(results, filesSource);
        })
        .catch(function() { list.innerHTML = '<div class="empty">Search failed</div>'; });
    }, 300);
  });

  // ── Helpers ──────────────────────────────────────────────────
  function timeAgo(iso) {
    var ms = Date.now() - new Date(iso).getTime();
    if (ms < 0) return 'in ' + formatDuration(-ms);
    return formatDuration(ms) + ' ago';
  }

  function formatDuration(ms) {
    if (ms < 60000) return Math.round(ms / 1000) + 's';
    if (ms < 3600000) return Math.round(ms / 60000) + 'm';
    if (ms < 86400000) return Math.round(ms / 3600000) + 'h';
    return Math.round(ms / 86400000) + 'd';
  }

  function formatBytes(b) {
    if (b < 1024) return b + 'B';
    if (b < 1048576) return (b / 1024).toFixed(1) + 'KB';
    return (b / 1048576).toFixed(1) + 'MB';
  }

  function truncate(s, n) {
    return s.length > n ? s.slice(0, n) + '...' : s;
  }

  // ── Populate group filter ────────────────────────────────────
  function loadGroups() {
    fetch('/api/containers?limit=100', { headers: authHeaders() })
      .then(function(r) { return r.json(); })
      .then(function(containers) {
        var groups = new Set();
        containers.forEach(function(c) { if (c.group_folder) groups.add(c.group_folder); });
        var sel = $('filterGroup');
        groups.forEach(function(g) {
          var opt = document.createElement('option');
          opt.value = g;
          opt.textContent = g;
          sel.appendChild(opt);
        });
      })
      .catch(function() {});
  }

  // ── Init ─────────────────────────────────────────────────────
  async function init() {
    var ok = await authenticate();
    if (!ok) {
      document.querySelectorAll('.header,.tabs,.filters,.pane,.scroll-btn').forEach(function(el) { el.style.display = 'none'; });
      authScreen.style.display = '';
      return;
    }

    connectSSE();
    loadGroups();
  }

  init();
})();
<\/script>
</body>
</html>`;
}

// ── Request router ──────────────────────────────────────────────────────

function handleRequest(req: Request): Response | Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;

  // Health check (no auth)
  if (pathname === '/healthz') {
    return jsonResponse({ ok: true, service: 'dashboard', authRequired: true });
  }

  // HTML page (no auth — JS handles it)
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

  // Logs
  if (pathname === '/api/logs/stream') return handleSSEStream(req, url);
  if (pathname === '/api/logs') return handleLogsQuery(url);
  if (pathname === '/api/logs/stats') return handleLogStats();

  // Containers
  if (pathname === '/api/containers' && !pathname.includes('/api/containers/'))
    return handleContainersList(url);
  if (pathname.startsWith('/api/containers/'))
    return handleContainerLog(pathname);

  // Tasks
  if (pathname === '/api/tasks') return handleTasksList(url);
  if (pathname === '/api/tasks/runs') return handleTaskRunLogsList(url);

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
  });

  sessionCleanupInterval = setInterval(cleanExpiredSessions, 60 * 60 * 1000);

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
