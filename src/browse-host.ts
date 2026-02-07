import fs from 'fs';
import path from 'path';
import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import { ensureSandbox, resetIdleTimer } from './sandbox-manager.js';

// Pending wait-for-user requests: requestId -> resolve function
const waitingForUser: Map<string, () => void> = new Map();

type BrowseResponse = {
  status: 'ok' | 'error';
  result?: unknown;
  error?: string;
};

type CuaPayload = {
  status?: string;
  content?: unknown;
  result?: unknown;
  error?: string;
  message?: string;
};

function parseSsePayload(raw: string): unknown {
  const dataLines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== '[DONE]');

  if (dataLines.length === 0) return {};

  let last: unknown = {};
  for (const entry of dataLines) {
    try {
      const parsed = JSON.parse(entry) as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(parsed, 'result')) {
        last = parsed.result;
      } else if (Object.prototype.hasOwnProperty.call(parsed, 'content')) {
        last = parsed.content;
      } else {
        last = parsed;
      }
    } catch {
      last = entry;
    }
  }
  return last;
}

async function runCuaCommand(
  command: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const sandbox = await ensureSandbox();

  const response = await fetch(sandbox.commandUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // `params` is the current computer-server schema; keep `args` for
    // compatibility with older sandbox images.
    body: JSON.stringify({ command, params: args, args }),
  });

  const rawBody = await response.text();

  if (!response.ok) {
    throw new Error(
      `CUA command HTTP ${response.status}: ${rawBody.slice(0, 500)}`,
    );
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase();

  let payload: CuaPayload;

  if (contentType.includes('text/event-stream')) {
    const streamed = parseSsePayload(rawBody);
    payload =
      streamed && typeof streamed === 'object'
        ? (streamed as CuaPayload)
        : { content: streamed };
  } else {
    try {
      payload = JSON.parse(rawBody) as CuaPayload;
    } catch {
      payload = { content: rawBody };
    }
  }

  if (
    payload.status &&
    payload.status !== 'success' &&
    payload.status !== 'ok'
  ) {
    throw new Error(
      payload.error || payload.message || `CUA command failed: ${command}`,
    );
  }
  if (payload.error) {
    throw new Error(payload.error);
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'content')) {
    return payload.content;
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'result')) {
    return payload.result;
  }
  return payload;
}

async function runCuaCommandWithFallback(
  attempts: Array<{ command: string; args?: Record<string, unknown> }>,
): Promise<unknown> {
  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      return await runCuaCommand(attempt.command, attempt.args || {});
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('CUA command failed with unknown error');
}

function selectorToElementDescription(selector: string): string {
  if (selector.startsWith('text=')) {
    return selector.slice(5).trim();
  }
  return selector.trim();
}

function extractCoordinates(input: unknown): { x: number; y: number } | null {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;

  const x =
    typeof record.center_x === 'number'
      ? record.center_x
      : typeof record.x === 'number'
        ? record.x
        : null;
  const y =
    typeof record.center_y === 'number'
      ? record.center_y
      : typeof record.y === 'number'
        ? record.y
        : null;

  if (typeof x === 'number' && typeof y === 'number') {
    return { x, y };
  }
  return null;
}

function extractBase64Png(input: unknown): string | null {
  if (typeof input === 'string') {
    const dataUrlPrefix = 'data:image/png;base64,';
    if (input.startsWith(dataUrlPrefix)) {
      return input.slice(dataUrlPrefix.length);
    }
    if (/^[A-Za-z0-9+/=\r\n]+$/.test(input)) {
      return input.replace(/\s/g, '');
    }
  }
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    if (typeof record.screenshot === 'string') {
      return extractBase64Png(record.screenshot);
    }
    if (typeof record.image === 'string') return extractBase64Png(record.image);
    if (typeof record.content === 'string') {
      return extractBase64Png(record.content);
    }
  }
  return null;
}

async function processCuaRequest(
  action: string,
  params: Record<string, unknown>,
  groupFolder: string,
): Promise<BrowseResponse> {
  switch (action) {
    case 'navigate': {
      const url = String(params.url || '').trim();
      if (!url) {
        return { status: 'error', error: 'navigate requires a URL' };
      }
      await runCuaCommandWithFallback([
        { command: 'press_key', args: { key: 'ctrl+l' } },
        { command: 'hotkey', args: { keys: 'ctrl+l' } },
      ]);
      await runCuaCommandWithFallback([
        { command: 'type', args: { text: url } },
        { command: 'type_text', args: { text: url } },
      ]);
      await runCuaCommandWithFallback([
        { command: 'press_key', args: { key: 'enter' } },
        { command: 'key', args: { key: 'enter' } },
      ]);
      await runCuaCommandWithFallback([
        { command: 'wait', args: { seconds: 1.5 } },
        { command: 'wait', args: { duration: 1.5 } },
      ]);
      return { status: 'ok', result: `Navigated to ${url}` };
    }
    case 'snapshot': {
      const snapshot = await runCuaCommand('get_accessibility_tree');
      return {
        status: 'ok',
        result:
          typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot),
      };
    }
    case 'click': {
      const selector = String(params.selector || '');
      const description = selectorToElementDescription(selector);
      const found = await runCuaCommandWithFallback([
        { command: 'find_element', args: { description } },
        { command: 'find_element', args: { query: description } },
      ]);
      const coords = extractCoordinates(found);
      if (!coords) {
        return {
          status: 'error',
          error: `CUA could not locate element for selector/description: ${selector}`,
        };
      }
      await runCuaCommand('left_click', { x: coords.x, y: coords.y });
      return { status: 'ok', result: `clicked (${coords.x}, ${coords.y})` };
    }
    case 'fill': {
      const selector = String(params.selector || '');
      const value = String(params.value || '');
      const description = selectorToElementDescription(selector);
      const found = await runCuaCommandWithFallback([
        { command: 'find_element', args: { description } },
        { command: 'find_element', args: { query: description } },
      ]);
      const coords = extractCoordinates(found);
      if (!coords) {
        return {
          status: 'error',
          error: `CUA could not locate input for selector/description: ${selector}`,
        };
      }
      await runCuaCommand('left_click', { x: coords.x, y: coords.y });
      await runCuaCommandWithFallback([
        { command: 'type', args: { text: value } },
        { command: 'type_text', args: { text: value } },
      ]);
      return { status: 'ok', result: `filled (${coords.x}, ${coords.y})` };
    }
    case 'screenshot': {
      const screenshotContent = await runCuaCommand('screenshot');
      const base64 = extractBase64Png(screenshotContent);
      if (!base64) {
        return {
          status: 'error',
          error: 'CUA screenshot returned an unsupported payload format',
        };
      }

      const mediaDir = path.join(GROUPS_DIR, groupFolder, 'media');
      fs.mkdirSync(mediaDir, { recursive: true });
      const filename = `screenshot-${Date.now()}.png`;
      const filePath = path.join(mediaDir, filename);
      fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
      return { status: 'ok', result: `/workspace/group/media/${filename}` };
    }
    case 'go_back': {
      await runCuaCommandWithFallback([
        { command: 'press_key', args: { key: 'alt+left' } },
        { command: 'hotkey', args: { keys: 'alt+left' } },
      ]);
      return { status: 'ok', result: 'navigated back' };
    }
    case 'evaluate':
      return {
        status: 'error',
        error:
          'browse_evaluate is not supported in CUA sandbox mode. Use browse_snapshot + follow-up actions instead.',
      };
    case 'close':
      await runCuaCommandWithFallback([
        { command: 'press_key', args: { key: 'ctrl+w' } },
        { command: 'hotkey', args: { keys: 'ctrl+w' } },
      ]);
      return { status: 'ok', result: 'closed' };
    default:
      return { status: 'error', error: `Unknown action: ${action}` };
  }
}

export async function processBrowseRequest(
  requestId: string,
  action: string,
  params: Record<string, unknown>,
  groupFolder: string,
  _ipcDir: string,
): Promise<{ status: 'ok' | 'error'; result?: unknown; error?: string }> {
  resetIdleTimer();

  try {
    if (action === 'wait_for_user') {
      return new Promise((resolve) => {
        waitingForUser.set(requestId, () => {
          resolve({ status: 'ok', result: 'User continued' });
        });
      });
    }

    return await processCuaRequest(action, params, groupFolder);
  } catch (err) {
    logger.error({ err, action, requestId }, 'Browse request failed');
    return {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Called when user sends "continue" in Telegram for a specific chat
export function resolveWaitForUser(requestId?: string): boolean {
  if (requestId && waitingForUser.has(requestId)) {
    waitingForUser.get(requestId)!();
    waitingForUser.delete(requestId);
    return true;
  }
  // If no specific ID, resolve the oldest waiting request
  const first = waitingForUser.entries().next();
  if (!first.done) {
    first.value[1]();
    waitingForUser.delete(first.value[0]);
    return true;
  }
  return false;
}

export function hasWaitingRequests(): boolean {
  return waitingForUser.size > 0;
}

export async function disconnectBrowser(): Promise<void> {
  // No persistent Playwright browser in CUA mode.
}
