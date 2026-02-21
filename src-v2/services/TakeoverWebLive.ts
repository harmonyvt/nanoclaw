/**
 * TakeoverWebLive — secure takeover server for wait_for_user sessions.
 */

import { execSync } from 'child_process';
import { Effect, Layer, Ref } from 'effect';

import { AppConfig } from '../config.js';
import { DashboardSession } from './DashboardSession.js';
import { TakeoverWeb } from './TakeoverWeb.js';
import type {
  PendingTakeoverRequest,
  TakeoverWaitHandlers,
  TakeoverWebService,
} from './TakeoverWeb.js';
import {
  createNoVncWebSocketHandler,
  makeNoVncWsData,
  proxyNoVncHttp,
  type NoVncWsData,
} from './NoVncProxy.js';

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

function extractSessionToken(req: Request, url: URL): string | null {
  const authHeader = req.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return url.searchParams.get('session');
}

function getTailscaleIp(): string | null {
  try {
    return execSync('tailscale ip -4', {
      stdio: 'pipe',
      timeout: 5000,
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function getTailscaleFqdn(): string | null {
  try {
    const raw = execSync('tailscale status --json', {
      stdio: 'pipe',
      timeout: 5000,
    }).toString();
    const status = JSON.parse(raw) as {
      Self?: { DNSName?: string };
    };
    const dnsName = status.Self?.DNSName;
    if (!dnsName) return null;
    return dnsName.replace(/\.$/, '');
  } catch {
    return null;
  }
}

function setupTailscaleServe(localPort: number, httpsPort: number): boolean {
  try {
    execSync(
      `tailscale serve --bg --https=${httpsPort} http://localhost:${localPort}`,
      { stdio: 'pipe', timeout: 10000 },
    );
    return true;
  } catch {
    return false;
  }
}

function removeTailscaleServe(httpsPort: number): void {
  try {
    execSync(`tailscale serve --https=${httpsPort} off`, {
      stdio: 'pipe',
      timeout: 5000,
    });
  } catch {
    // best effort
  }
}

function renderTakeoverPage(token: string, sessionToken: string): string {
  const safeToken = JSON.stringify(token);
  const safeSession = JSON.stringify(sessionToken);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CUA Takeover</title>
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0f172a; color: #e2e8f0; }
    .wrap { display: flex; flex-direction: column; min-height: 100vh; }
    .top { padding: 12px 16px; background: #111827; border-bottom: 1px solid #1f2937; display: flex; gap: 12px; align-items: center; }
    .status { font-size: 14px; opacity: 0.9; }
    .btn { margin-left: auto; background: #22c55e; color: #052e16; border: none; border-radius: 8px; padding: 8px 14px; font-weight: 700; cursor: pointer; }
    .btn[disabled] { opacity: 0.5; cursor: not-allowed; }
    iframe { flex: 1; width: 100%; border: 0; min-height: 520px; background: #030712; }
    .msg { padding: 12px 16px; font-size: 13px; background: #111827; border-top: 1px solid #1f2937; white-space: pre-wrap; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div id="status" class="status">Loading takeover session...</div>
      <button id="returnBtn" class="btn" disabled>Return Control To Agent</button>
    </div>
    <iframe id="desktop" src="about:blank" allow="fullscreen"></iframe>
    <div id="message" class="msg"></div>
  </div>
  <script>
    const token = ${safeToken};
    const session = ${safeSession};
    const statusEl = document.getElementById('status');
    const messageEl = document.getElementById('message');
    const iframe = document.getElementById('desktop');
    const returnBtn = document.getElementById('returnBtn');

    async function loadStatus() {
      const res = await fetch('/api/cua/takeover/' + encodeURIComponent(token) + '?session=' + encodeURIComponent(session));
      const data = await res.json();
      if (!res.ok || data.status === 'error') {
        statusEl.textContent = 'Session not active';
        messageEl.textContent = data.error || 'This takeover link is no longer active.';
        returnBtn.disabled = true;
        return;
      }

      statusEl.textContent = 'Takeover active';
      returnBtn.disabled = false;
      messageEl.textContent = (data.message || 'Use this session to complete login/verification, then click Return Control To Agent.') + '\nRequest: ' + data.requestId;

      const liveView = '/novnc/vnc.html?autoconnect=1&resize=remote&path=websockify';
      iframe.src = liveView;
    }

    returnBtn.addEventListener('click', async () => {
      returnBtn.disabled = true;
      const res = await fetch('/api/cua/takeover/' + encodeURIComponent(token) + '/continue?session=' + encodeURIComponent(session), {
        method: 'POST'
      });
      const data = await res.json();
      if (!res.ok || data.status === 'error') {
        statusEl.textContent = data.error || 'Failed to return control';
        returnBtn.disabled = false;
        return;
      }
      statusEl.textContent = 'Control returned to agent';
      messageEl.textContent = 'You can close this page now.';
    });

    loadStatus().catch((error) => {
      statusEl.textContent = 'Failed to load takeover status';
      messageEl.textContent = String(error);
    });
  </script>
</body>
</html>`;
}

export const TakeoverWebLive: Layer.Layer<
  TakeoverWeb,
  never,
  AppConfig | DashboardSession
> = Layer.scoped(
  TakeoverWeb,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const dashboardSession = yield* DashboardSession;

    const serverRef = yield* Ref.make<ReturnType<typeof Bun.serve<NoVncWsData>> | null>(null);
    const handlersRef = yield* Ref.make<TakeoverWaitHandlers | null>(null);
    const tailscaleFqdnRef = yield* Ref.make<string | null>(null);
    const tailscaleServeRef = yield* Ref.make<boolean>(false);

    const hostIp = () => {
      if (config.sandboxTailscaleEnabled) {
        return getTailscaleIp() || '127.0.0.1';
      }
      return '127.0.0.1';
    };

    const getTakeoverBaseUrlSync = (): string | null => {
      if (!config.cuaTakeoverWebEnabled) return null;

      const mapped = Effect.runSync(Ref.get(tailscaleServeRef));
      const fqdn = Effect.runSync(Ref.get(tailscaleFqdnRef));
      if (mapped && fqdn) {
        return `https://${fqdn}:${config.cuaTakeoverHttpsPort}`;
      }

      return `http://${hostIp()}:${config.cuaTakeoverWebPort}`;
    };

    const startServer = Effect.gen(function* () {
      if (!config.cuaTakeoverWebEnabled) return;

      const existing = yield* Ref.get(serverRef);
      if (existing) return;

      if (config.sandboxTailscaleEnabled) {
        const fqdn = getTailscaleFqdn();
        if (fqdn) {
          yield* Ref.set(tailscaleFqdnRef, fqdn);
          const mapped = setupTailscaleServe(
            config.cuaTakeoverWebPort,
            config.cuaTakeoverHttpsPort,
          );
          yield* Ref.set(tailscaleServeRef, mapped);
        }
      }

      const fetchHandler = (
        req: Request,
        server: import('bun').Server<NoVncWsData>,
      ): Response | Promise<Response> | undefined => {
        const url = new URL(req.url);
        const pathname = url.pathname;

        if (req.method === 'GET' && pathname === '/healthz') {
          return jsonResponse({
            ok: true,
            service: 'cua-takeover-v2',
            enabled: config.cuaTakeoverWebEnabled,
          });
        }

        if (pathname === '/novnc/websockify' || pathname === '/websockify') {
          const upgraded = server.upgrade(req, { data: makeNoVncWsData() });
          return upgraded
            ? undefined
            : new Response('WebSocket upgrade failed', { status: 500 });
        }

        if (req.method === 'GET' && pathname.startsWith('/novnc/')) {
          return proxyNoVncHttp(pathname, config.cuaSandboxNovncPort);
        }

        const sessionToken = extractSessionToken(req, url);
        const session = sessionToken
          ? Effect.runSync(dashboardSession.validateSession(sessionToken))
          : null;

        if (!sessionToken || !session) {
          return jsonResponse(
            { status: 'error', error: 'unauthorized' },
            401,
          );
        }

        if (req.method === 'GET') {
          const apiToken = extractToken(pathname, '/api/cua/takeover/');
          if (apiToken) {
            const handlers = Effect.runSync(Ref.get(handlersRef));
            const pending = handlers?.getByToken(apiToken) || null;
            if (!pending) {
              return jsonResponse(
                {
                  status: 'error',
                  error: 'takeover session not found',
                  liveViewUrl: '/novnc/vnc.html?autoconnect=1&resize=remote&path=websockify',
                  takeoverUrl: getTakeoverBaseUrlSync(),
                },
                404,
              );
            }

            if (handlers?.touch) {
              void Promise.resolve(handlers.touch());
            }

            const payload = {
              status: 'pending',
              requestId: pending.requestId,
              groupFolder: pending.groupFolder,
              message: pending.message,
              createdAt: pending.createdAt,
              liveViewUrl: '/novnc/vnc.html?autoconnect=1&resize=remote&path=websockify',
              vncPassword: pending.vncPassword,
              takeoverUrl: getTakeoverBaseUrlSync(),
            };

            return jsonResponse(payload);
          }
        }

        if (req.method === 'POST') {
          const continueToken = extractContinueToken(pathname);
          if (continueToken) {
            const handlers = Effect.runSync(Ref.get(handlersRef));
            const resolved = handlers?.resolveByToken(continueToken) || false;
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
      };

      const server = Bun.serve<NoVncWsData>({
        hostname: '127.0.0.1',
        port: config.cuaTakeoverWebPort,
        fetch: fetchHandler,
        websocket: createNoVncWebSocketHandler(config.cuaSandboxNovncPort),
      });

      yield* Ref.set(serverRef, server);
      yield* Effect.log(
        `Takeover web started at ${getTakeoverBaseUrlSync() || 'disabled'}`,
      );
    });

    const stopServer = Effect.gen(function* () {
      const server = yield* Ref.get(serverRef);
      if (server) {
        server.stop(true);
        yield* Ref.set(serverRef, null);
      }

      const mapped = yield* Ref.get(tailscaleServeRef);
      if (mapped) {
        removeTailscaleServe(config.cuaTakeoverHttpsPort);
        yield* Ref.set(tailscaleServeRef, false);
      }
    });

    yield* Effect.addFinalizer(() => stopServer.pipe(Effect.ignore));

    const service: TakeoverWebService = {
      start: startServer,
      setWaitHandlers: (handlers: TakeoverWaitHandlers) =>
        Ref.set(handlersRef, handlers),
      getTakeoverBaseUrl: Effect.gen(function* () {
        yield* startServer;
        return getTakeoverBaseUrlSync();
      }),
      getTakeoverUrl: (token: string, sessionToken?: string) =>
        Effect.gen(function* () {
          yield* startServer;
          const base = getTakeoverBaseUrlSync();
          if (!base) return null;
          const url = `${base}/cua/takeover/${encodeURIComponent(token)}`;
          if (!sessionToken) return url;
          return `${url}?session=${encodeURIComponent(sessionToken)}`;
        }),
    };

    return service;
  }),
);
