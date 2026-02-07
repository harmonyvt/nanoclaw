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
import { getSandboxHostIp } from './sandbox-manager.js';
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

let dashboardServer: ReturnType<typeof Bun.serve> | null = null;
let sessionCleanupInterval: ReturnType<typeof setInterval> | null = null;

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
  // Check Authorization header first
  const authHeader = req.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    return validateSession(token);
  }
  // Fall back to query param (needed for EventSource which can't set headers)
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

      // Send catch-up logs from ring buffer
      const catchUp = afterId > 0 ? getRingBufferSince(afterId) : getRingBuffer();
      for (const entry of catchUp) {
        send('log', entry);
      }

      // Subscribe to new logs
      const onLog = (entry: StructuredLog) => send('log', entry);
      logEmitter.on('log', onLog);

      // Heartbeat every 15s
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          clearInterval(heartbeat);
        }
      }, 15_000);

      // Cleanup on disconnect
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
  // /api/containers/:group/:filename
  const parts = pathname.replace('/api/containers/', '').split('/');
  if (parts.length !== 2) return jsonResponse({ error: 'invalid path' }, 400);

  const [group, filename] = parts;
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

  // Enrich with recent run logs
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

function handleSkillsList(): Response {
  const skillsDir = path.resolve(process.cwd(), '.claude', 'skills');
  try {
    if (!fs.existsSync(skillsDir)) return jsonResponse([]);
    const dirs = fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory());

    const skills: {
      name: string;
      description: string;
      hasCode: boolean;
    }[] = [];

    for (const dir of dirs) {
      const skillMd = path.join(skillsDir, dir.name, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;

      const content = fs.readFileSync(skillMd, 'utf8');
      // Parse YAML frontmatter
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      let name = dir.name;
      let description = '';
      if (fmMatch) {
        const nameMatch = fmMatch[1].match(/^name:\s*(.+)$/m);
        const descMatch = fmMatch[1].match(/^description:\s*(.+)$/m);
        if (nameMatch) name = nameMatch[1].trim();
        if (descMatch) description = descMatch[1].trim();
      }

      // Check if skill has code files beyond SKILL.md
      const files = fs.readdirSync(path.join(skillsDir, dir.name));
      const hasCode = files.some(
        (f) => f !== 'SKILL.md' && !f.startsWith('.'),
      );

      skills.push({ name, description, hasCode });
    }

    skills.sort((a, b) => a.name.localeCompare(b.name));
    return jsonResponse(skills);
  } catch {
    return jsonResponse([]);
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
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
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
  <div class="tab" data-tab="skills">Skills</div>
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

<!-- Skills pane -->
<div class="pane" id="pane-skills">
  <div class="card-list" id="skillList">
    <div class="loading">Loading skills...</div>
  </div>
</div>

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
  const LEVEL_NAMES = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' };
  const MAX_LOG_ENTRIES = 2000;

  let authToken = null;
  let lastLogId = 0;
  let autoScroll = true;
  let currentTab = 'logs';
  let eventSource = null;
  let searchTimeout = null;
  let isSearchMode = false;

  const $ = (id) => document.getElementById(id);
  const statusDot = $('statusDot');
  const statusLabel = $('statusLabel');
  const logContainer = $('logContainer');
  const scrollBtn = $('scrollBtn');
  const logFilters = $('logFilters');
  const authScreen = $('authScreen');
  const tabsBar = $('tabsBar');

  // ── Telegram WebApp Auth ─────────────────────────────────────
  async function authenticate() {
    const tg = window.Telegram?.WebApp;
    if (tg?.initData) {
      tg.ready();
      tg.expand();
      try { tg.setHeaderColor('#0b1219'); } catch {}
      try { tg.setBackgroundColor('#0b1219'); } catch {}

      try {
        const res = await fetch('/api/auth?initData=' + encodeURIComponent(tg.initData));
        if (res.ok) {
          const data = await res.json();
          authToken = data.token;
          return true;
        }
      } catch {}
      return false;
    }

    // No Telegram context: try unauthenticated access (dev mode)
    try {
      const res = await fetch('/healthz');
      if (res.ok) {
        const data = await res.json();
        if (data.authRequired === false) {
          authToken = 'dev';
          return true;
        }
      }
    } catch {}
    return false;
  }

  // ── SSE Connection ───────────────────────────────────────────
  function connectSSE() {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    if (!authToken) return;

    const url = '/api/logs/stream?token=' + encodeURIComponent(authToken) + '&afterId=' + lastLogId;
    eventSource = new EventSource(url);

    eventSource.addEventListener('log', function(e) {
      try {
        const log = JSON.parse(e.data);
        if (log.id > lastLogId) lastLogId = log.id;
        if (!isSearchMode) appendLogEntry(log);
      } catch {}
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
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function appendLogEntry(log) {
    const el = document.createElement('div');
    el.className = 'log-entry';

    const level = log.level || 30;
    const levelName = LEVEL_NAMES[level] || 'LOG';
    const timeStr = formatTime(log.time);
    const module = log.module || '';
    const msg = log.msg || '';

    el.innerHTML =
      '<span class="log-time mono">' + timeStr + '</span>' +
      '<span class="log-level log-level-' + level + '">' + levelName + '</span>' +
      (module ? '<span class="log-module mono">' + escapeH(module) + '</span>' : '') +
      '<span class="log-msg mono">' + escapeH(msg) + '</span>';

    logContainer.appendChild(el);

    // Cap DOM entries
    while (logContainer.children.length > MAX_LOG_ENTRIES) {
      logContainer.removeChild(logContainer.firstChild);
    }

    if (autoScroll) {
      logContainer.scrollTop = logContainer.scrollHeight;
    }
  }

  function escapeH(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // ── Auto-scroll detection ────────────────────────────────────
  logContainer.addEventListener('scroll', function() {
    const atBottom = logContainer.scrollHeight - logContainer.scrollTop - logContainer.clientHeight < 60;
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
    const tab = e.target.closest('.tab');
    if (!tab) return;
    const name = tab.dataset.tab;
    if (name === currentTab) return;

    document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
    document.querySelectorAll('.pane').forEach(function(p) { p.classList.remove('active'); });
    tab.classList.add('active');
    $('pane-' + name).classList.add('active');
    logFilters.style.display = name === 'logs' ? '' : 'none';
    currentTab = name;

    if (name === 'containers') loadContainers();
    if (name === 'tasks') loadTasks();
    if (name === 'skills') loadSkills();
  });

  // ── Filters ──────────────────────────────────────────────────
  $('filterToggle').addEventListener('click', function() {
    $('filterAdvanced').classList.toggle('show');
    this.textContent = $('filterAdvanced').classList.contains('show') ? 'Less' : 'More';
  });

  function getFilterParams() {
    const params = new URLSearchParams();
    const level = $('filterLevel').value;
    const search = $('filterSearch').value;
    const group = $('filterGroup').value;
    if (level) params.set('level', level);
    if (search) params.set('search', search);
    if (group) params.set('group', group);
    params.set('limit', '200');
    return params;
  }

  function applyFilters() {
    const level = $('filterLevel').value;
    const search = $('filterSearch').value;
    const group = $('filterGroup').value;

    if (!level && !search && !group) {
      // Return to live mode
      isSearchMode = false;
      return;
    }

    isSearchMode = true;
    logContainer.innerHTML = '<div class="loading">Searching...</div>';

    fetch('/api/logs?' + getFilterParams().toString(), {
      headers: authToken !== 'dev' ? { 'Authorization': 'Bearer ' + authToken } : {}
    })
      .then(function(r) { return r.json(); })
      .then(function(logs) {
        logContainer.innerHTML = '';
        if (logs.length === 0) {
          logContainer.innerHTML = '<div class="empty">No matching logs found</div>';
          return;
        }
        // Logs come in DESC order, reverse for display
        logs.reverse().forEach(function(log) { appendLogEntry(log); });
      })
      .catch(function() {
        logContainer.innerHTML = '<div class="empty">Search failed</div>';
      });
  }

  $('filterLevel').addEventListener('change', applyFilters);
  $('filterGroup').addEventListener('change', applyFilters);
  $('filterSearch').addEventListener('input', function() {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(applyFilters, 300);
  });

  // ── Containers Tab ───────────────────────────────────────────
  function loadContainers() {
    const list = $('containerList');
    list.innerHTML = '<div class="loading">Loading...</div>';

    fetch('/api/containers?limit=50', {
      headers: authToken !== 'dev' ? { 'Authorization': 'Bearer ' + authToken } : {}
    })
      .then(function(r) { return r.json(); })
      .then(function(containers) {
        list.innerHTML = '';
        if (containers.length === 0) {
          list.innerHTML = '<div class="empty">No container runs found</div>';
          return;
        }
        containers.forEach(function(c) {
          const statusClass = c.status === 'error' || (c.exit_code && c.exit_code !== 0) ? 'badge-error' : 'badge-ok';
          const statusText = c.status || (c.exit_code === 0 ? 'ok' : c.exit_code !== null ? 'exit ' + c.exit_code : 'unknown');
          const dur = c.duration_ms ? (c.duration_ms / 1000).toFixed(1) + 's' : '—';
          const time = c.timestamp ? timeAgo(c.timestamp) : '—';
          const size = c.file_size ? formatBytes(c.file_size) : '';

          const card = document.createElement('div');
          card.className = 'card';
          card.innerHTML =
            '<div class="card-header">' +
              '<span class="card-title">' + escapeH(c.group_folder) + '</span>' +
              '<span class="badge ' + statusClass + '">' + escapeH(statusText) + '</span>' +
            '</div>' +
            '<div class="card-meta">' +
              (c.mode ? escapeH(c.mode) + ' &middot; ' : '') +
              'Duration: ' + dur + ' &middot; ' + time +
              (size ? ' &middot; ' + size : '') +
            '</div>';
          list.appendChild(card);
        });
      })
      .catch(function() {
        list.innerHTML = '<div class="empty">Failed to load containers</div>';
      });
  }

  // ── Tasks Tab ────────────────────────────────────────────────
  function loadTasks() {
    const list = $('taskList');
    list.innerHTML = '<div class="loading">Loading...</div>';

    fetch('/api/tasks', {
      headers: authToken !== 'dev' ? { 'Authorization': 'Bearer ' + authToken } : {}
    })
      .then(function(r) { return r.json(); })
      .then(function(tasks) {
        list.innerHTML = '';
        if (tasks.length === 0) {
          list.innerHTML = '<div class="empty">No scheduled tasks</div>';
          return;
        }
        tasks.forEach(function(t) {
          const statusClass = t.status === 'active' ? 'badge-active' : t.status === 'paused' ? 'badge-paused' : 'badge-ok';
          const nextRun = t.next_run ? timeAgo(t.next_run) : '—';

          let runsHtml = '';
          if (t.recent_runs && t.recent_runs.length > 0) {
            runsHtml = '<div class="run-list">';
            t.recent_runs.forEach(function(r) {
              const rStatus = r.status === 'error' ? 'badge-error' : 'badge-ok';
              const dur = (r.duration_ms / 1000).toFixed(1) + 's';
              const time = timeAgo(r.run_at);
              runsHtml += '<div class="run-item">' +
                '<span class="badge ' + rStatus + '">' + escapeH(r.status) + '</span>' +
                '<span>' + dur + '</span>' +
                '<span>' + time + '</span>' +
                (r.error ? '<span style="color:var(--danger);font-size:11px">' + escapeH(r.error.slice(0, 60)) + '</span>' : '') +
              '</div>';
            });
            runsHtml += '</div>';
          }

          const card = document.createElement('div');
          card.className = 'card';
          card.innerHTML =
            '<div class="card-header">' +
              '<span class="card-title">' + escapeH(truncate(t.prompt, 60)) + '</span>' +
              '<span class="badge ' + statusClass + '">' + escapeH(t.status) + '</span>' +
            '</div>' +
            '<div class="card-meta">' +
              escapeH(t.schedule_type) + ': ' + escapeH(t.schedule_value) +
              ' &middot; Group: ' + escapeH(t.group_folder) +
              ' &middot; Next: ' + nextRun +
            '</div>' +
            runsHtml;
          list.appendChild(card);
        });
      })
      .catch(function() {
        list.innerHTML = '<div class="empty">Failed to load tasks</div>';
      });
  }

  // ── Skills Tab ───────────────────────────────────────────────
  function loadSkills() {
    var list = $('skillList');
    list.innerHTML = '<div class="loading">Loading...</div>';

    fetch('/api/skills', {
      headers: authToken !== 'dev' ? { 'Authorization': 'Bearer ' + authToken } : {}
    })
      .then(function(r) { return r.json(); })
      .then(function(skills) {
        list.innerHTML = '';
        if (skills.length === 0) {
          list.innerHTML = '<div class="empty">No skills found</div>';
          return;
        }
        skills.forEach(function(s) {
          var card = document.createElement('div');
          card.className = 'card';
          card.innerHTML =
            '<div class="card-header">' +
              '<span class="card-title" style="color:var(--accent)">/' + escapeH(s.name) + '</span>' +
              (s.hasCode ? '<span class="badge badge-active">code</span>' : '<span class="badge badge-ok">prompt</span>') +
            '</div>' +
            (s.description ? '<div class="card-meta">' + escapeH(s.description) + '</div>' : '');
          list.appendChild(card);
        });
      })
      .catch(function() {
        list.innerHTML = '<div class="empty">Failed to load skills</div>';
      });
  }

  // ── Helpers ──────────────────────────────────────────────────
  function timeAgo(iso) {
    const ms = Date.now() - new Date(iso).getTime();
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
    fetch('/api/containers?limit=100', {
      headers: authToken !== 'dev' ? { 'Authorization': 'Bearer ' + authToken } : {}
    })
      .then(function(r) { return r.json(); })
      .then(function(containers) {
        const groups = new Set();
        containers.forEach(function(c) { if (c.group_folder) groups.add(c.group_folder); });
        const sel = $('filterGroup');
        groups.forEach(function(g) {
          const opt = document.createElement('option');
          opt.value = g;
          opt.textContent = g;
          sel.appendChild(opt);
        });
      })
      .catch(function() {});
  }

  // ── Init ─────────────────────────────────────────────────────
  async function init() {
    const ok = await authenticate();
    if (!ok) {
      // Hide main UI, show auth screen
      document.querySelectorAll('.header,.tabs,.filters,.pane,.scroll-btn').forEach(function(el) { el.style.display = 'none'; });
      authScreen.style.display = '';
      return;
    }

    connectSSE();
    loadGroups();
  }

  init();
})();
</script>
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

  if (pathname === '/api/logs/stream') return handleSSEStream(req, url);
  if (pathname === '/api/logs') return handleLogsQuery(url);
  if (pathname === '/api/logs/stats') return handleLogStats();
  if (pathname === '/api/containers' && !pathname.includes('/api/containers/'))
    return handleContainersList(url);
  if (pathname.startsWith('/api/containers/'))
    return handleContainerLog(pathname);
  if (pathname === '/api/tasks') return handleTasksList(url);
  if (pathname === '/api/tasks/runs') return handleTaskRunLogsList(url);
  if (pathname === '/api/skills') return handleSkillsList();

  return new Response('Not Found', { status: 404 });
}

// ── Server lifecycle ────────────────────────────────────────────────────

export function getDashboardUrl(): string | null {
  if (!DASHBOARD_ENABLED) return null;
  // Prefer explicit DASHBOARD_URL (e.g. manual override)
  if (DASHBOARD_URL) return DASHBOARD_URL.replace(/\/$/, '');
  // Prefer auto-detected tailscale HTTPS URL
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
    hostname: '0.0.0.0',
    port: DASHBOARD_PORT,
    ...tlsOptions,
    fetch: handleRequest,
  });

  // Cleanup expired sessions every hour
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
