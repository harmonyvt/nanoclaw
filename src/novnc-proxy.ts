import { CUA_SANDBOX_NOVNC_PORT } from './config.js';

const NOVNC_BACKEND = `http://localhost:${CUA_SANDBOX_NOVNC_PORT}`;

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
