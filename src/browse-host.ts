import fs from 'fs';
import path from 'path';
import { GROUPS_DIR } from './config.js';
import { CuaClient } from './cua-client.js';
import { logger } from './logger.js';
import { ensureSandbox, resetIdleTimer } from './sandbox-manager.js';

type PendingWaitForUser = {
  groupFolder: string;
  resolve: () => void;
};

// Pending wait-for-user requests: requestId -> group + resolve function
const waitingForUser: Map<string, PendingWaitForUser> = new Map();
const lastNavigatedUrlByGroup = new Map<string, string>();

type BrowseResponse = {
  status: 'ok' | 'error';
  result?: unknown;
  error?: string;
};

type CuaPayload = {
  status?: string;
  success?: boolean;
  content?: unknown;
  result?: unknown;
  output?: unknown;
  error?: string;
  message?: string;
};

function detectImageMimeFromBytes(bytes: Buffer): string | null {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6) {
    const sig6 = bytes.subarray(0, 6).toString('ascii');
    if (sig6 === 'GIF87a' || sig6 === 'GIF89a') return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

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
  const client = CuaClient.fromCommandUrl(sandbox.commandUrl);
  if (!client.isKnownCommand(command)) {
    logger.warn({ command }, 'Attempting unknown CUA command');
  }
  const response = await client.commandRaw(command, args);

  const contentType = (
    response.headers.get('content-type') || ''
  ).toLowerCase();
  const responseBytes = Buffer.from(await response.arrayBuffer());

  if (!response.ok) {
    const rawBody = responseBytes.toString('utf8');
    throw new Error(
      `CUA command HTTP ${response.status}: ${rawBody.slice(0, 500)}`,
    );
  }

  if (
    contentType.includes('image/') ||
    contentType.includes('application/octet-stream')
  ) {
    const mimeType = contentType.split(';', 1)[0] || 'image/png';
    return `data:${mimeType};base64,${responseBytes.toString('base64')}`;
  }

  // Some CUA builds return raw image bytes with a text-like content-type.
  if (command === 'screenshot') {
    const detectedMime = detectImageMimeFromBytes(responseBytes);
    if (detectedMime) {
      return `data:${detectedMime};base64,${responseBytes.toString('base64')}`;
    }
  }

  const rawBody = responseBytes.toString('utf8');

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
    if (!CuaClient.isKnownCommandName(attempt.command)) {
      logger.debug(
        { command: attempt.command },
        'Skipping unknown CUA command',
      );
      continue;
    }
    try {
      return await runCuaCommand(attempt.command, attempt.args || {});
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('CUA command fallback failed: no compatible command succeeded');
}

async function tryCuaCommandWithFallback(
  attempts: Array<{ command: string; args?: Record<string, unknown> }>,
): Promise<boolean> {
  try {
    await runCuaCommandWithFallback(attempts);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function buildOpenUrlAttempts(
  url: string,
): Array<{ command: string; args?: Record<string, unknown> }> {
  const quotedUrl = shellSingleQuote(url);
  return [
    { command: 'open', args: { uri: url } },
    { command: 'open', args: { url } },
    { command: 'open_url', args: { url } },
    { command: 'navigate', args: { url } },
    { command: 'run_command', args: { cmd: `xdg-open ${quotedUrl}` } },
    { command: 'run_command', args: { command: `xdg-open ${quotedUrl}` } },
  ];
}

function coerceSnapshotRecord(input: unknown): Record<string, unknown> | null {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not JSON
    }
  }
  return null;
}

function looksLikeDesktopSnapshot(snapshot: unknown): boolean {
  const record = coerceSnapshotRecord(snapshot);
  if (!record) return false;
  const title = String(record.title || '').toLowerCase();
  const role = String(record.role || '').toLowerCase();
  const children = Array.isArray(record.children) ? record.children : [];
  return (
    children.length === 0 &&
    role === 'window' &&
    (title.includes('linux window') || title.includes('desktop'))
  );
}

function collectWindowIds(payload: unknown): Array<string | number> {
  const ids: Array<string | number> = [];

  const pushIfId = (candidate: unknown): void => {
    if (typeof candidate === 'string' || typeof candidate === 'number') {
      ids.push(candidate);
    }
  };

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (!value || typeof value !== 'object') return;

    const record = value as Record<string, unknown>;
    pushIfId(record.window_id);
    pushIfId(record.windowId);
    pushIfId(record.id);

    if (Array.isArray(record.windows)) {
      visit(record.windows);
    }
  };

  visit(payload);
  return ids;
}

async function focusBrowserWindow(): Promise<boolean> {
  const candidates = ['chromium', 'google-chrome', 'chrome', 'firefox'];

  for (const app of candidates) {
    let windows: unknown;
    try {
      windows = await runCuaCommand('get_application_windows', { app });
    } catch {
      continue;
    }

    const windowIds = collectWindowIds(windows);
    for (const windowId of windowIds) {
      const activated = await tryCuaCommandWithFallback([
        { command: 'activate_window', args: { window_id: windowId } },
      ]);
      if (!activated) continue;

      await tryCuaCommandWithFallback([
        { command: 'maximize_window', args: { window_id: windowId } },
      ]);
      return true;
    }
  }

  return false;
}

async function stabilizeBrowserForScreenshot(
  groupFolder: string,
): Promise<void> {
  const focusedWindow = await focusBrowserWindow();
  if (focusedWindow) {
    await sleep(250);
  }

  // Quick focus nudge in case desktop grabbed focus.
  const switched = await tryCuaCommandWithFallback([
    { command: 'hotkey', args: { keys: 'alt+tab' } },
    { command: 'press_key', args: { key: 'alt+tab' } },
  ]);
  if (switched) await sleep(300);

  let snapshot: unknown = null;
  try {
    snapshot = await runCuaCommand('get_accessibility_tree');
  } catch {
    // Snapshot may fail on some CUA builds; continue best-effort.
  }

  if (!looksLikeDesktopSnapshot(snapshot)) {
    return;
  }

  const lastUrl = lastNavigatedUrlByGroup.get(groupFolder);
  if (!lastUrl) {
    logger.warn(
      { groupFolder },
      'Desktop appears focused before screenshot and no last URL is available',
    );
    return;
  }

  const reopened = await tryCuaCommandWithFallback(
    buildOpenUrlAttempts(lastUrl),
  );
  if (reopened) {
    await focusBrowserWindow();
    logger.debug(
      { groupFolder, lastUrl },
      'Re-opened last URL before screenshot due to desktop-focused snapshot',
    );
    await sleep(2200);
  }
}

function normalizeSelectorToken(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeCssSelectorValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function addQueryCandidate(
  target: Map<string, string>,
  candidate: string | null | undefined,
): void {
  if (typeof candidate !== 'string') return;
  const trimmed = candidate.trim();
  if (!trimmed) return;
  const key = normalizeForSearch(trimmed);
  if (!target.has(key)) {
    target.set(key, trimmed);
  }
}

export function buildElementSearchQueries(selector: string): string[] {
  const raw = selector.trim();
  if (!raw) return [];

  const candidates = new Map<string, string>();

  if (raw.startsWith('text=')) {
    addQueryCandidate(candidates, raw.slice(5));
    return [...candidates.values()];
  }

  addQueryCandidate(candidates, raw);

  const attrPattern =
    /\[\s*([A-Za-z0-9:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*\]/g;
  let attrMatch: RegExpExecArray | null = null;
  while ((attrMatch = attrPattern.exec(raw)) !== null) {
    const attrName = (attrMatch[1] || '').toLowerCase();
    const attrValue = decodeCssSelectorValue(
      attrMatch[2] || attrMatch[3] || attrMatch[4] || '',
    );
    addQueryCandidate(candidates, attrValue);
    addQueryCandidate(candidates, normalizeSelectorToken(attrValue));

    if (attrName === 'type' && attrValue.toLowerCase() === 'search') {
      addQueryCandidate(candidates, 'search');
      addQueryCandidate(candidates, 'search box');
    }
    if (attrName === 'role' && attrValue.toLowerCase() === 'searchbox') {
      addQueryCandidate(candidates, 'search');
      addQueryCandidate(candidates, 'search box');
    }
  }

  const idMatches = raw.match(/#[A-Za-z0-9_-]+/g) || [];
  for (const match of idMatches) {
    addQueryCandidate(candidates, normalizeSelectorToken(match.slice(1)));
  }

  const classMatches = raw.match(/\.[A-Za-z0-9_-]+/g) || [];
  for (const match of classMatches) {
    addQueryCandidate(candidates, normalizeSelectorToken(match.slice(1)));
  }

  if (raw.toLowerCase().includes('search')) {
    addQueryCandidate(candidates, 'search');
    addQueryCandidate(candidates, 'search box');
  }

  return [...candidates.values()];
}

function formatAttemptedQueries(queries: string[]): string {
  if (queries.length === 0) return 'none';
  const shown = queries.slice(0, 4);
  const suffix =
    queries.length > shown.length
      ? ` (+${queries.length - shown.length} more)`
      : '';
  return `${shown.join(' | ')}${suffix}`;
}

type LocatedElement = {
  coords: { x: number; y: number };
  matchedQuery: string;
};

async function findElementCoordinates(
  queries: string[],
): Promise<LocatedElement | null> {
  if (queries.length === 0) return null;

  const retryDelaysMs = [0, 500, 1200];
  for (const delay of retryDelaysMs) {
    if (delay > 0) {
      await sleep(delay);
    }

    for (const query of queries) {
      let found: unknown;
      try {
        found = await runCuaCommandWithFallback([
          { command: 'find_element', args: { description: query } },
          { command: 'find_element', args: { query } },
          { command: 'find_element', args: { title: query } },
          { command: 'find_element', args: { selector: query } },
        ]);
      } catch {
        continue;
      }

      const coords = extractCoordinates(found);
      if (coords) {
        return { coords, matchedQuery: query };
      }
    }
  }

  return null;
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

async function getAccessibilitySnapshotSafe(): Promise<unknown | null> {
  try {
    return await runCuaCommand('get_accessibility_tree');
  } catch {
    return null;
  }
}

function toSnapshotComparableString(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function didSnapshotChange(
  before: unknown | null,
  after: unknown | null,
): boolean | null {
  if (before === null || after === null) return null;
  return (
    toSnapshotComparableString(before) !== toSnapshotComparableString(after)
  );
}

function normalizeForSearch(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function snapshotContainsText(
  snapshot: unknown | null,
  needle: string,
): boolean | null {
  const normalizedNeedle = normalizeForSearch(needle);
  if (!normalizedNeedle) return null;
  if (snapshot === null) return null;

  const haystack = normalizeForSearch(toSnapshotComparableString(snapshot));
  if (!haystack) return null;
  return haystack.includes(normalizedNeedle);
}

function verificationSuffix(status: string): string {
  return `; verification: ${status}`;
}

function extractBase64Png(input: unknown): string | null {
  const visited = new WeakSet<object>();

  const extractFromString = (value: string): string | null => {
    const trimmed = value.trim();

    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        const nested = visit(parsed);
        if (nested) return nested;
      } catch {
        // Not JSON payload, continue with string parsing.
      }
    }

    const quotedMatch = trimmed.match(/^"(.*)"$/s);
    if (quotedMatch) {
      try {
        const parsed = JSON.parse(trimmed) as string;
        const nested = extractFromString(parsed);
        if (nested) return nested;
      } catch {
        // Not a valid JSON string; continue.
      }
    }

    const dataUrlMatch = value.match(
      /^data:image\/[A-Za-z0-9.+-]+;base64,(.+)$/s,
    );
    if (dataUrlMatch) {
      return dataUrlMatch[1].replace(/\s/g, '');
    }

    let normalized = value.replace(/\s/g, '');
    if (normalized.startsWith('base64,')) {
      normalized = normalized.slice('base64,'.length);
    }
    if (normalized.startsWith('data:image/')) {
      const idx = normalized.indexOf(';base64,');
      if (idx >= 0) {
        normalized = normalized.slice(idx + ';base64,'.length);
      }
    }

    // Support URL-safe base64.
    const normalizedUrlSafe = normalized.replace(/-/g, '+').replace(/_/g, '/');
    const padding = normalizedUrlSafe.length % 4;
    const padded =
      padding === 0
        ? normalizedUrlSafe
        : normalizedUrlSafe + '='.repeat(4 - padding);

    // Avoid treating short plain strings as image bytes.
    if (padded.length >= 256 && /^[A-Za-z0-9+/=]+$/.test(padded)) {
      const decoded = Buffer.from(padded, 'base64');
      if (decoded.length >= 128 && detectImageMimeFromBytes(decoded)) {
        return decoded.toString('base64');
      }
    }

    // Fallback: extract the largest base64-like chunk from mixed strings.
    const matches = value.match(/[A-Za-z0-9+/_=-]{512,}/g);
    if (matches) {
      const sorted = [...matches].sort((a, b) => b.length - a.length);
      for (const candidate of sorted) {
        const urlSafe = candidate.replace(/-/g, '+').replace(/_/g, '/');
        const rem = urlSafe.length % 4;
        const withPad = rem === 0 ? urlSafe : urlSafe + '='.repeat(4 - rem);
        if (!/^[A-Za-z0-9+/=]+$/.test(withPad)) continue;
        const decoded = Buffer.from(withPad, 'base64');
        if (decoded.length >= 128 && detectImageMimeFromBytes(decoded)) {
          return decoded.toString('base64');
        }
      }
    }
    return null;
  };

  const visit = (value: unknown): string | null => {
    if (typeof value === 'string') {
      return extractFromString(value);
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const extracted = visit(item);
        if (extracted) return extracted;
      }
      return null;
    }

    if (!value || typeof value !== 'object') {
      return null;
    }

    const record = value as Record<string, unknown>;
    if (visited.has(value)) return null;
    visited.add(value);

    // Common CUA/agent image payload shapes.
    const imageUrl = record.image_url;
    if (typeof imageUrl === 'string') {
      const extracted = extractFromString(imageUrl);
      if (extracted) return extracted;
    } else if (imageUrl && typeof imageUrl === 'object') {
      const nestedUrl = (imageUrl as Record<string, unknown>).url;
      if (typeof nestedUrl === 'string') {
        const extracted = extractFromString(nestedUrl);
        if (extracted) return extracted;
      }
    }

    const prioritizedKeys = [
      'screenshot',
      'image',
      'content',
      'data',
      'base64',
      'image_base64',
      'imageUrl',
      'image_url',
      'url',
      'result',
      'output',
    ];
    for (const key of prioritizedKeys) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      const extracted = visit(record[key]);
      if (extracted) return extracted;
    }

    // Final fallback: recursively scan all object values.
    for (const nested of Object.values(record)) {
      const extracted = visit(nested);
      if (extracted) return extracted;
    }

    return null;
  };

  return visit(input);
}

function describePayloadShape(input: unknown): string {
  if (input === null) return 'null';
  if (input === undefined) return 'undefined';
  if (typeof input === 'string') return `string(len=${input.length})`;
  if (typeof input !== 'object') return typeof input;
  if (Array.isArray(input)) return `array(len=${input.length})`;

  const keys = Object.keys(input as Record<string, unknown>).slice(0, 10);
  return `object(keys=${keys.join(',') || 'none'})`;
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

      let openedViaDirectCommand = false;
      try {
        await runCuaCommandWithFallback(buildOpenUrlAttempts(url));
        openedViaDirectCommand = true;
      } catch (openErr) {
        logger.debug(
          { err: openErr, url },
          'Direct URL open command failed; falling back to keyboard navigation',
        );
      }

      if (!openedViaDirectCommand) {
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
      }

      // Some CUA builds do not expose a `wait` command. Keep a host-side delay.
      await sleep(openedViaDirectCommand ? 2200 : 1500);
      lastNavigatedUrlByGroup.set(groupFolder, url);
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
      const queries = buildElementSearchQueries(selector);
      const beforeSnapshot = await getAccessibilitySnapshotSafe();
      const located = await findElementCoordinates(queries);
      if (!located) {
        return {
          status: 'error',
          error: `CUA could not locate element for selector/description: ${selector}; attempted queries: ${formatAttemptedQueries(queries)}`,
        };
      }
      await runCuaCommand('left_click', {
        x: located.coords.x,
        y: located.coords.y,
      });
      await sleep(250);
      const afterSnapshot = await getAccessibilitySnapshotSafe();
      const changed = didSnapshotChange(beforeSnapshot, afterSnapshot);
      const verify =
        changed === true
          ? 'verified (accessibility tree changed)'
          : changed === false
            ? 'not confirmed (no tree change detected)'
            : 'not confirmed (snapshot unavailable)';
      return {
        status: 'ok',
        result: `clicked (${located.coords.x}, ${located.coords.y})${verificationSuffix(verify)}; matched query: ${located.matchedQuery}`,
      };
    }
    case 'fill': {
      const selector = String(params.selector || '');
      const value = String(params.value || '');
      const queries = buildElementSearchQueries(selector);
      const beforeSnapshot = await getAccessibilitySnapshotSafe();
      const located = await findElementCoordinates(queries);
      if (!located) {
        return {
          status: 'error',
          error: `CUA could not locate input for selector/description: ${selector}; attempted queries: ${formatAttemptedQueries(queries)}`,
        };
      }
      await runCuaCommand('left_click', {
        x: located.coords.x,
        y: located.coords.y,
      });
      await runCuaCommandWithFallback([
        { command: 'type', args: { text: value } },
        { command: 'type_text', args: { text: value } },
      ]);
      await sleep(250);
      const afterSnapshot = await getAccessibilitySnapshotSafe();
      const changed = didSnapshotChange(beforeSnapshot, afterSnapshot);
      const valueSeen = snapshotContainsText(afterSnapshot, value);
      const verify =
        valueSeen === true
          ? 'verified (input value observed in accessibility tree)'
          : changed === true
            ? 'partially verified (tree changed, value not observed)'
            : changed === false
              ? 'not confirmed (no tree change detected)'
              : 'not confirmed (snapshot unavailable)';
      return {
        status: 'ok',
        result: `filled (${located.coords.x}, ${located.coords.y})${verificationSuffix(verify)}; matched query: ${located.matchedQuery}`,
      };
    }
    case 'scroll': {
      const deltaY = Number(params.deltaY ?? params.dy ?? 500);
      const deltaX = Number(params.deltaX ?? params.dx ?? 0);
      const beforeSnapshot = await getAccessibilitySnapshotSafe();
      await runCuaCommandWithFallback([
        { command: 'scroll', args: { delta_x: deltaX, delta_y: deltaY } },
        { command: 'scroll', args: { x: deltaX, y: deltaY } },
        { command: 'mouse_wheel', args: { delta_x: deltaX, delta_y: deltaY } },
        { command: 'mouse_wheel', args: { x: deltaX, y: deltaY } },
        { command: 'wheel', args: { deltaY, deltaX } },
      ]);
      await sleep(250);
      const afterSnapshot = await getAccessibilitySnapshotSafe();
      const changed = didSnapshotChange(beforeSnapshot, afterSnapshot);
      const verify =
        changed === true
          ? 'verified (accessibility tree changed)'
          : changed === false
            ? 'not confirmed (no tree change detected)'
            : 'not confirmed (snapshot unavailable)';
      return {
        status: 'ok',
        result: `scrolled dx=${deltaX}, dy=${deltaY}${verificationSuffix(verify)}`,
      };
    }
    case 'screenshot': {
      await stabilizeBrowserForScreenshot(groupFolder);
      const screenshotContent = await runCuaCommand('screenshot');
      const base64 = extractBase64Png(screenshotContent);
      if (!base64) {
        const shape = describePayloadShape(screenshotContent);
        logger.warn({ shape }, 'CUA screenshot payload format is unsupported');
        return {
          status: 'error',
          error: `CUA screenshot returned an unsupported payload format (${shape})`,
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
        waitingForUser.set(requestId, {
          groupFolder,
          resolve: () => {
            resolve({ status: 'ok', result: 'User continued' });
          },
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
export function resolveWaitForUser(
  groupFolder: string,
  requestId?: string,
): boolean {
  if (requestId) {
    const pending = waitingForUser.get(requestId);
    if (!pending || pending.groupFolder !== groupFolder) {
      return false;
    }
    pending.resolve();
    waitingForUser.delete(requestId);
    return true;
  }

  // If no specific ID, resolve the oldest waiting request for this group.
  for (const [id, pending] of waitingForUser.entries()) {
    if (pending.groupFolder !== groupFolder) continue;
    pending.resolve();
    waitingForUser.delete(id);
    return true;
  }
  return false;
}

export function hasWaitingRequests(groupFolder?: string): boolean {
  if (!groupFolder) return waitingForUser.size > 0;
  for (const pending of waitingForUser.values()) {
    if (pending.groupFolder === groupFolder) return true;
  }
  return false;
}

export async function disconnectBrowser(): Promise<void> {
  // No persistent Playwright browser in CUA mode.
}
