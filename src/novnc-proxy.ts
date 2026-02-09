import { CUA_SANDBOX_NOVNC_PORT } from './config.js';

const NOVNC_BACKEND = `http://localhost:${CUA_SANDBOX_NOVNC_PORT}`;

/**
 * Serve vnc_lite.html with the VNC password injected server-side,
 * so the password never reaches the client via API responses.
 */
export async function proxyNoVncFollowPage(vncPassword: string | null): Promise<Response> {
  try {
    const upstream = await fetch(`${NOVNC_BACKEND}/vnc_lite.html`);
    if (!upstream.ok) {
      return new Response('noVNC backend unavailable', { status: 502 });
    }
    let html = await upstream.text();

    // Inject password + view_only into the page before the closing </head>
    // noVNC reads these from URL params via WebUtil, so we override them with a script
    const inject = `<script>
(function() {
  var p = new URLSearchParams(window.location.search);
  if (!p.has('autoconnect')) p.set('autoconnect', 'true');
  if (!p.has('resize')) p.set('resize', 'scale');
  p.set('view_only', 'true');
  ${vncPassword ? `p.set('password', ${JSON.stringify(vncPassword)});` : ''}
  if (window.location.search !== '?' + p.toString()) {
    history.replaceState(null, '', window.location.pathname + '?' + p.toString());
  }
})();
</script>`;
    html = html.replace('</head>', inject + '\n</head>');

    const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' });
    return new Response(html, { status: 200, headers });
  } catch {
    return new Response('noVNC backend unavailable', { status: 502 });
  }
}

export async function proxyNoVncHttp(pathname: string): Promise<Response> {
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

export type NoVncWsData = {
  backend: WebSocket | null;
  buffer: (string | ArrayBuffer | Buffer)[];
  closed: boolean;
};

export function createNoVncWebSocketHandler(): import('bun').WebSocketHandler<NoVncWsData> {
  return {
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
  };
}

export function makeNoVncWsData(): NoVncWsData {
  return { backend: null, buffer: [], closed: false };
}
