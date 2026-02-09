import { CUA_TAKEOVER_WEB_ENABLED, CUA_TAKEOVER_WEB_PORT } from './config.js';
import {
  getSandboxHostIp,
  getSandboxUrl,
  resetIdleTimer,
} from './sandbox-manager.js';
import { getTailscaleHttpsUrl } from './tailscale-serve.js';
import {
  getWaitForUserRequestByToken,
  resolveWaitForUserByToken,
} from './browse-host.js';
import { logger } from './logger.js';
import { validateSession } from './dashboard-auth.js';

let takeoverServer: ReturnType<typeof Bun.serve> | null = null;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function extractToken(pathname: string, prefix: string): string | null {
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

export function getTakeoverBaseUrl(): string | null {
  if (!CUA_TAKEOVER_WEB_ENABLED) return null;
  const tsUrl = getTailscaleHttpsUrl(CUA_TAKEOVER_WEB_PORT);
  if (tsUrl) return tsUrl;
  return `http://${getSandboxHostIp()}:${CUA_TAKEOVER_WEB_PORT}`;
}

export function getTakeoverUrl(
  token: string,
  sessionToken?: string,
): string | null {
  const base = getTakeoverBaseUrl();
  if (!base) return null;
  const url = `${base}/cua/takeover/${encodeURIComponent(token)}`;
  return sessionToken
    ? `${url}?session=${encodeURIComponent(sessionToken)}`
    : url;
}

function renderTakeoverPage(token: string, sessionToken?: string): string {
  const pending = getWaitForUserRequestByToken(token);
  if (!pending) {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>CUA Takeover Expired</title>
  <style>
    :root {
      --bg: #0f1720;
      --panel: #1a2531;
      --text: #ecf2f8;
      --muted: #9db1c5;
      --warn: #f59e0b;
    }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Space Grotesk", "Avenir Next", "Segoe UI", sans-serif;
      background:
        radial-gradient(1100px circle at 10% -10%, #26455e 0%, transparent 55%),
        radial-gradient(850px circle at 95% 95%, #3e2a20 0%, transparent 45%),
        var(--bg);
      color: var(--text);
      display: grid;
      place-items: center;
      padding: 24px;
      box-sizing: border-box;
    }
    .card {
      width: min(720px, 100%);
      background: linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.02));
      border: 1px solid rgba(255,255,255,0.16);
      border-radius: 18px;
      padding: 22px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.32);
    }
    h1 { margin: 0 0 8px; font-size: 26px; }
    p { margin: 0; color: var(--muted); line-height: 1.45; }
    .warn { color: var(--warn); margin-top: 10px; }
  </style>
</head>
<body>
  <main class="card">
    <h1>Takeover Session Not Active</h1>
    <p>This takeover link is no longer active. Ask the agent to request <code>browse_wait_for_user</code> again.</p>
    <p class="warn">If a session is currently active, use the latest link from chat.</p>
  </main>
</body>
</html>`;
  }

  resetIdleTimer();
  const liveViewUrl = getSandboxUrl();
  const takeoverUrl = getTakeoverUrl(token);
  const escapedMessage = escapeHtml(
    pending.message ||
      'Use this page to control the CUA browser, then return control to the agent.',
  );
  const escapedRequestId = escapeHtml(pending.requestId);
  const escapedGroup = escapeHtml(pending.groupFolder);
  const escapedCreatedAt = escapeHtml(pending.createdAt);
  const escapedTakeoverUrl = takeoverUrl ? escapeHtml(takeoverUrl) : '';

  // Build authenticated noVNC iframe URL with per-session VNC password
  let iframeSrc = '';
  if (liveViewUrl) {
    const noVncUrl = new URL('/vnc_lite.html', liveViewUrl);
    noVncUrl.searchParams.set('autoconnect', 'true');
    noVncUrl.searchParams.set('resize', 'scale');
    if (pending.vncPassword) {
      noVncUrl.searchParams.set('password', pending.vncPassword);
    }
    iframeSrc = escapeHtml(noVncUrl.toString());
  }

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>CUA Browser Takeover</title>
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
      --radius: 18px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Space Grotesk", "Avenir Next", "Segoe UI", sans-serif;
      color: var(--text);
      background:
        radial-gradient(1300px circle at 5% 0%, rgba(56,189,248,0.16) 0%, transparent 55%),
        radial-gradient(900px circle at 95% 100%, rgba(245,158,11,0.16) 0%, transparent 44%),
        var(--bg);
      display: flex;
      flex-direction: column;
      animation: fadeIn 260ms ease-out;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    header {
      padding: 16px 20px;
      border-bottom: 1px solid rgba(255,255,255,0.12);
      background: rgba(11,18,25,0.84);
      backdrop-filter: blur(8px);
    }
    .title {
      margin: 0;
      font-size: 20px;
      letter-spacing: 0.02em;
    }
    .subtitle {
      margin: 6px 0 0;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.45;
    }
    .shell {
      display: grid;
      grid-template-columns: minmax(260px, 350px) minmax(0, 1fr);
      gap: 14px;
      padding: 14px;
      flex: 1;
      min-height: 0;
    }
    .panel {
      background: linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.02));
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: var(--radius);
      box-shadow: 0 16px 44px rgba(0,0,0,0.25);
      min-height: 0;
    }
    .meta {
      padding: 16px;
      display: grid;
      gap: 14px;
      align-content: start;
    }
    .meta-item {
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 12px;
      padding: 11px;
    }
    .meta-label {
      font-family: "IBM Plex Mono", "Menlo", "Consolas", monospace;
      font-size: 12px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .meta-value {
      margin-top: 6px;
      word-break: break-word;
      font-size: 14px;
      line-height: 1.4;
    }
    .controls {
      display: grid;
      gap: 10px;
    }
    .btn {
      appearance: none;
      border: 0;
      border-radius: 12px;
      padding: 11px 14px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 140ms ease, box-shadow 140ms ease, opacity 140ms ease;
    }
    .btn:hover { transform: translateY(-1px); }
    .btn:disabled { opacity: 0.56; cursor: not-allowed; transform: none; }
    .btn-primary {
      color: #041017;
      background: linear-gradient(145deg, var(--accent), #0ea5e9);
      box-shadow: 0 10px 28px rgba(56,189,248,0.28);
    }
    .btn-link {
      color: #fff;
      text-decoration: none;
      text-align: center;
      background: linear-gradient(145deg, #334155, #1f2937);
    }
    .btn-success {
      color: #08120b;
      background: linear-gradient(145deg, var(--ok), #16a34a);
      box-shadow: 0 10px 28px rgba(34,197,94,0.25);
    }
    .status {
      color: var(--muted);
      font-size: 13px;
      min-height: 20px;
      line-height: 1.45;
    }
    .workspace {
      min-height: 420px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .workspace-bar {
      height: 42px;
      border-bottom: 1px solid rgba(255,255,255,0.12);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 14px;
      color: var(--muted);
      font-size: 13px;
    }
    .workspace-frame {
      border: 0;
      width: 100%;
      flex: 1;
      background: var(--panel-2);
    }
    .fallback {
      padding: 16px;
      color: var(--muted);
      line-height: 1.5;
    }
    code {
      font-family: "IBM Plex Mono", "Menlo", "Consolas", monospace;
      background: rgba(255,255,255,0.09);
      border-radius: 6px;
      padding: 1px 5px;
      font-size: 12px;
    }
    @media (max-width: 900px) {
      .shell {
        grid-template-columns: 1fr;
      }
      .workspace {
        min-height: 56vh;
      }
    }
  </style>
</head>
<body>
  <header>
    <h1 class="title">CUA Browser Takeover</h1>
    <p class="subtitle">${escapedMessage}</p>
  </header>

  <section class="shell">
    <aside class="panel meta">
      <div class="meta-item">
        <div class="meta-label">Request</div>
        <div class="meta-value"><code>${escapedRequestId}</code></div>
      </div>
      <div class="meta-item">
        <div class="meta-label">Group</div>
        <div class="meta-value">${escapedGroup}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">Created</div>
        <div class="meta-value">${escapedCreatedAt}</div>
      </div>
      <div class="controls">
        <button class="btn btn-primary" id="continueBtn">Return Control To Agent</button>
        <div class="status" id="statusText">${
          escapedTakeoverUrl
            ? `Takeover URL: <code>${escapedTakeoverUrl}</code>`
            : 'Takeover URL unavailable.'
        }</div>
      </div>
    </aside>

    <main class="panel workspace">
      <div class="workspace-bar">
        <span>Live CUA Desktop</span>
        <span id="liveIndicator">${iframeSrc ? 'active' : 'unavailable'}</span>
      </div>
      ${
        iframeSrc
          ? `<iframe class="workspace-frame" src="${iframeSrc}" title="CUA Live Desktop"></iframe>`
          : `<div class="fallback">Sandbox live view is currently unavailable. Keep this page open and try again, or request a new handoff link from chat.</div>`
      }
    </main>
  </section>

  <script>
    const token = ${JSON.stringify(token)};
    const session = ${JSON.stringify(sessionToken || '')};
    const authHeaders = session ? { 'Authorization': 'Bearer ' + session } : {};
    const continueBtn = document.getElementById('continueBtn');
    const statusText = document.getElementById('statusText');

    function setStatus(text, ok) {
      statusText.textContent = text;
      statusText.style.color = ok === true ? 'var(--ok)' : ok === false ? 'var(--danger)' : 'var(--muted)';
    }

    async function pollStatus() {
      try {
        const res = await fetch('/api/cua/takeover/' + encodeURIComponent(token), { cache: 'no-store', headers: authHeaders });
        if (!res.ok) {
          setStatus('Takeover session is no longer active.', false);
          continueBtn.disabled = true;
          return;
        }
        const payload = await res.json();
        if (payload.status !== 'pending') {
          continueBtn.disabled = true;
          continueBtn.classList.remove('btn-primary');
          continueBtn.classList.add('btn-success');
          continueBtn.textContent = 'Control Returned';
          setStatus('Agent has resumed control.', true);
          return;
        }
        if (!continueBtn.disabled) {
          setStatus('You control the browser now. Click "Return Control To Agent" when done.', null);
        }
      } catch {
        setStatus('Status check failed. Keep this page open and retry shortly.', false);
      }
    }

    continueBtn.addEventListener('click', async () => {
      continueBtn.disabled = true;
      setStatus('Returning control...', null);
      try {
        const res = await fetch('/api/cua/takeover/' + encodeURIComponent(token) + '/continue', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders },
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => null);
          throw new Error(payload && payload.error ? payload.error : 'request failed');
        }
        continueBtn.classList.remove('btn-primary');
        continueBtn.classList.add('btn-success');
        continueBtn.textContent = 'Control Returned';
        setStatus('Agent has resumed control.', true);
      } catch (err) {
        continueBtn.disabled = false;
        setStatus('Could not return control: ' + (err && err.message ? err.message : 'unknown error'), false);
      }
    });

    pollStatus();
    setInterval(pollStatus, 15000);
  </script>
</body>
</html>`;
}

function buildTakeoverApiPayload(
  token: string,
  sessionToken?: string,
): {
  status: 'pending' | 'not_found';
  requestId?: string;
  groupFolder?: string;
  message?: string | null;
  createdAt?: string;
  liveViewUrl?: string | null;
  takeoverUrl?: string | null;
} {
  const pending = getWaitForUserRequestByToken(token);
  if (!pending) {
    return {
      status: 'not_found',
      liveViewUrl: getSandboxUrl(),
      takeoverUrl: getTakeoverUrl(token, sessionToken),
    };
  }
  resetIdleTimer();
  return {
    status: 'pending',
    requestId: pending.requestId,
    groupFolder: pending.groupFolder,
    message: pending.message,
    createdAt: pending.createdAt,
    liveViewUrl: getSandboxUrl(),
    takeoverUrl: getTakeoverUrl(token, sessionToken),
  };
}

function extractSessionToken(req: Request, url: URL): string | null {
  const authHeader = req.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return url.searchParams.get('session');
}

function handleTakeoverRequest(req: Request): Response {
  const url = new URL(req.url);
  const { pathname } = url;

  if (req.method === 'GET' && pathname === '/healthz') {
    return jsonResponse({
      ok: true,
      service: 'cua-takeover',
      enabled: CUA_TAKEOVER_WEB_ENABLED,
    });
  }

  // Require a valid dashboard session for all takeover endpoints
  const sessionToken = extractSessionToken(req, url);
  if (!sessionToken || !validateSession(sessionToken)) {
    return jsonResponse(
      { status: 'error', error: 'unauthorized' },
      401,
    );
  }

  if (req.method === 'GET') {
    const apiToken = extractToken(pathname, '/api/cua/takeover/');
    if (apiToken) {
      const payload = buildTakeoverApiPayload(apiToken, sessionToken);
      if (payload.status === 'not_found') {
        return jsonResponse(
          { status: 'error', error: 'takeover session not found' },
          404,
        );
      }
      return jsonResponse(payload);
    }
  }

  if (req.method === 'POST') {
    const continueToken = extractContinueToken(pathname);
    if (continueToken) {
      const resolved = resolveWaitForUserByToken(continueToken);
      if (!resolved) {
        return jsonResponse(
          {
            status: 'error',
            error: 'takeover session not found or already completed',
          },
          404,
        );
      }
      return jsonResponse({
        status: 'ok',
        result: 'control returned to agent',
      });
    }
  }

  if (req.method === 'GET') {
    const pageToken = extractToken(pathname, '/cua/takeover/');
    if (pageToken) {
      return htmlResponse(renderTakeoverPage(pageToken, sessionToken));
    }
  }

  return new Response('Not Found', { status: 404 });
}

export function startCuaTakeoverServer(): void {
  if (!CUA_TAKEOVER_WEB_ENABLED) {
    logger.info('CUA takeover web UI disabled by config');
    return;
  }
  if (takeoverServer) return;

  takeoverServer = Bun.serve({
    hostname: '127.0.0.1',
    port: CUA_TAKEOVER_WEB_PORT,
    fetch: handleTakeoverRequest,
  });

  logger.info(
    {
      port: CUA_TAKEOVER_WEB_PORT,
      baseUrl: getTakeoverBaseUrl(),
    },
    'CUA takeover web server started',
  );
}

export function stopCuaTakeoverServer(): void {
  if (!takeoverServer) return;
  takeoverServer.stop(true);
  takeoverServer = null;
  logger.info('CUA takeover web server stopped');
}
