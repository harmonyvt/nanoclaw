import { CUA_TAKEOVER_WEB_ENABLED, CUA_TAKEOVER_WEB_PORT, CUA_SANDBOX_NOVNC_PORT } from './config.js';
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
import { serveStaticAsset } from './ui-assets.js';

let takeoverServer: ReturnType<typeof Bun.serve> | null = null;

const NOVNC_BACKEND = `http://localhost:${CUA_SANDBOX_NOVNC_PORT}`;

type NoVncWsData = {
  backend: WebSocket | null;
  buffer: (string | ArrayBuffer | Buffer)[];
  closed: boolean;
};

async function proxyNoVncHttp(pathname: string): Promise<Response> {
  const backendPath = pathname.slice('/novnc'.length) || '/';
  try {
    const upstream = await fetch(`${NOVNC_BACKEND}${backendPath}`);
    const headers = new Headers();
    upstream.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower === 'x-frame-options' || lower === 'content-security-policy') return;
      headers.set(key, value);
    });
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch {
    return new Response('noVNC backend unavailable', { status: 502 });
  }
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

  if (pending) {
    resetIdleTimer();
  }

  const data = pending
    ? {
        status: 'active' as const,
        token,
        session: sessionToken || '',
        requestId: pending.requestId,
        groupFolder: pending.groupFolder,
        message: pending.message || undefined,
        createdAt: pending.createdAt,
        liveViewUrl: getSandboxUrl(),
        vncPassword: pending.vncPassword,
        takeoverUrl: getTakeoverUrl(token),
      }
    : { status: 'expired' as const };

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>CUA Browser Takeover</title>
  <link rel="stylesheet" href="/assets/takeover.css">
</head>
<body>
  <div id="app"></div>
  <script>window.__TAKEOVER_DATA__ = ${JSON.stringify(data)}</script>
  <script type="module" src="/assets/takeover.js"></script>
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
  vncPassword?: string | null;
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
    vncPassword: pending.vncPassword,
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

function handleTakeoverRequest(req: Request, server: import('bun').Server<NoVncWsData>): Response | undefined | Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;

  // Static assets (no auth needed)
  if (pathname.startsWith('/assets/')) {
    const asset = serveStaticAsset(pathname);
    if (asset) return asset;
  }

  if (req.method === 'GET' && pathname === '/healthz') {
    return jsonResponse({
      ok: true,
      service: 'cua-takeover',
      enabled: CUA_TAKEOVER_WEB_ENABLED,
    });
  }

  // Proxy noVNC WebSocket (no session auth -- localhost-only, Tailscale provides auth)
  if (pathname === '/novnc/websockify' || pathname === '/websockify') {
    const upgraded = server.upgrade(req, {
      data: { backend: null, buffer: [], closed: false } as NoVncWsData,
    });
    return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 500 });
  }

  // Proxy noVNC HTTP assets (no session auth -- served within authenticated iframe)
  if (req.method === 'GET' && pathname.startsWith('/novnc/')) {
    return proxyNoVncHttp(pathname);
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
    websocket: {
      open(ws) {
        const data = ws.data as NoVncWsData;
        const backend = new WebSocket(`ws://localhost:${CUA_SANDBOX_NOVNC_PORT}/websockify`);
        backend.binaryType = 'arraybuffer';
        data.backend = backend;

        backend.addEventListener('open', () => {
          for (const msg of data.buffer) backend.send(msg);
          data.buffer.length = 0;
        });
        backend.addEventListener('message', (event) => {
          if (!data.closed) ws.send(event.data);
        });
        backend.addEventListener('close', () => {
          if (!data.closed) { data.closed = true; ws.close(); }
        });
        backend.addEventListener('error', () => {
          if (!data.closed) { data.closed = true; ws.close(); }
        });
      },
      message(ws, message) {
        const data = ws.data as NoVncWsData;
        if (data.closed) return;
        if (data.backend && data.backend.readyState === WebSocket.OPEN) {
          data.backend.send(message);
        } else {
          data.buffer.push(message);
        }
      },
      close(ws) {
        const data = ws.data as NoVncWsData;
        data.closed = true;
        if (data.backend && data.backend.readyState === WebSocket.OPEN) {
          data.backend.close();
        }
        data.backend = null;
        data.buffer.length = 0;
      },
    },
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
