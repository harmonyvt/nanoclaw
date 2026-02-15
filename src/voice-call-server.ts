/**
 * HTTP callback server for voice call sidecar.
 * Receives utterance audio POSTs from the pytgcalls sidecar and dispatches
 * them to the voice call pipeline.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { VOICE_CALLBACK_PORT } from './config.js';
import { logger } from './logger.js';

export type UtteranceHandler = (wavBuffer: Buffer, chatId: string) => Promise<void>;

let server: Server | null = null;
let utteranceHandler: UtteranceHandler | null = null;

export function setUtteranceHandler(handler: UtteranceHandler): void {
  utteranceHandler = handler;
}

function parseMultipart(
  body: Buffer,
  boundary: string,
): { audio?: Buffer; chatId?: string } {
  const result: { audio?: Buffer; chatId?: string } = {};
  const boundaryBuf = Buffer.from(`--${boundary}`);

  // Split on boundary
  let start = 0;
  const parts: Buffer[] = [];
  while (true) {
    const idx = body.indexOf(boundaryBuf, start);
    if (idx === -1) break;
    if (start > 0) {
      parts.push(body.subarray(start, idx));
    }
    start = idx + boundaryBuf.length;
    // Skip \r\n after boundary
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;
  }

  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headers = part.subarray(0, headerEnd).toString('utf-8');
    const content = part.subarray(headerEnd + 4);
    // Trim trailing \r\n
    const trimmed = content[content.length - 2] === 0x0d && content[content.length - 1] === 0x0a
      ? content.subarray(0, content.length - 2)
      : content;

    if (headers.includes('name="audio"')) {
      result.audio = Buffer.from(trimmed);
    } else if (headers.includes('name="chat_id"')) {
      result.chatId = trimmed.toString('utf-8').trim();
    }
  }
  return result;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"status":"ok"}');
    return;
  }

  if (req.method !== 'POST' || req.url !== '/voice-utterance') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  if (!utteranceHandler) {
    res.writeHead(503);
    res.end('No handler registered');
    return;
  }

  // Read full body
  const chunks: Buffer[] = [];
  let totalSize = 0;
  const maxSize = 50 * 1024 * 1024; // 50MB max

  for await (const chunk of req) {
    totalSize += (chunk as Buffer).length;
    if (totalSize > maxSize) {
      res.writeHead(413);
      res.end('Payload too large');
      return;
    }
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks);

  // Parse multipart form data
  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=(.+?)(?:;|$)/);
  if (!boundaryMatch) {
    res.writeHead(400);
    res.end('Missing multipart boundary');
    return;
  }

  const { audio, chatId } = parseMultipart(body, boundaryMatch[1]);
  if (!audio || !chatId) {
    res.writeHead(400);
    res.end('Missing audio or chat_id');
    return;
  }

  logger.info(
    { module: 'voice-callback', chatId, audioSize: audio.length },
    'Received utterance from sidecar',
  );

  // Respond immediately, process async
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{"status":"accepted"}');

  try {
    await utteranceHandler(audio, chatId);
  } catch (err) {
    logger.error(
      { module: 'voice-callback', err: err instanceof Error ? err.message : String(err) },
      'Utterance processing failed',
    );
  }
}

export function startVoiceCallbackServer(): void {
  if (server) return;
  server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      logger.error({ module: 'voice-callback', err }, 'Request handler error');
      if (!res.writableEnded) {
        res.writeHead(500);
        res.end('Internal error');
      }
    });
  });
  server.listen(VOICE_CALLBACK_PORT, () => {
    logger.info(
      { module: 'voice-callback', port: VOICE_CALLBACK_PORT },
      'Voice callback server started',
    );
  });
}

export function stopVoiceCallbackServer(): void {
  if (server) {
    server.close();
    server = null;
    logger.info({ module: 'voice-callback' }, 'Voice callback server stopped');
  }
}
