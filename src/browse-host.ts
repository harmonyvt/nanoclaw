import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { GROUPS_DIR, DATA_DIR } from './config.js';
import { CuaClient } from './cua-client.js';
import { logger } from './logger.js';
import { ensureSandbox, resetIdleTimer, rotateSandboxVncPassword } from './sandbox-manager.js';

type PendingWaitForUser = {
  requestId: string;
  groupFolder: string;
  token: string;
  createdAt: string;
  message: string | null;
  vncPassword: string | null;
  promise: Promise<BrowseResponse>;
  resolve: (result: BrowseResponse) => void;
};

export type PendingWaitForUserView = {
  requestId: string;
  groupFolder: string;
  token: string;
  createdAt: string;
  message: string | null;
  vncPassword: string | null;
};

// Pending wait-for-user requests: requestId -> metadata + resolver
const waitingForUser: Map<string, PendingWaitForUser> = new Map();
const waitingForUserByToken: Map<string, string> = new Map();

type BrowseResponse = {
  status: 'ok' | 'error';
  result?: unknown;
  error?: string;
  analysis?: ScreenshotAnalysis;
};

export type ScreenshotGrid = {
  rows: number;
  cols: number;
  width: number;
  height: number;
};

export type ScreenshotAnalysisElement = {
  id: number;
  label: string;
  role: string | null;
  interactive: boolean;
  center: { x: number; y: number };
  bounds: { x: number; y: number; width: number; height: number };
  grid: { row: number; col: number; key: string };
};

export type ScreenshotAnalysis = {
  capturedAt: string;
  grid: ScreenshotGrid;
  elementCount: number;
  truncated: boolean;
  elements: ScreenshotAnalysisElement[];
  metadataPath?: string;
  summary: string;
};

const SCREENSHOT_GRID_ROWS = 8;
const SCREENSHOT_GRID_COLS = 12;
const SCREENSHOT_MAX_ELEMENTS = 40;
const SCREENSHOT_SUMMARY_LIMIT = 20;

type CuaPayload = {
  status?: string;
  success?: boolean;
  content?: unknown;
  result?: unknown;
  output?: unknown;
  error?: string;
  message?: string;
};

function normalizeWaitMessage(message: unknown): string | null {
  if (typeof message !== 'string') return null;
  const trimmed = message.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function createWaitToken(): string {
  return randomBytes(18).toString('base64url');
}

function toPendingView(pending: PendingWaitForUser): PendingWaitForUserView {
  return {
    requestId: pending.requestId,
    groupFolder: pending.groupFolder,
    token: pending.token,
    createdAt: pending.createdAt,
    message: pending.message,
    vncPassword: pending.vncPassword,
  };
}

function ensurePendingWaitForUser(
  requestId: string,
  groupFolder: string,
  message?: unknown,
): PendingWaitForUser {
  const existing = waitingForUser.get(requestId);
  if (existing) {
    if (existing.groupFolder !== groupFolder) {
      logger.warn(
        {
          requestId,
          existingGroup: existing.groupFolder,
          requestedGroup: groupFolder,
        },
        'wait_for_user request already exists for another group',
      );
    }
    const nextMessage = normalizeWaitMessage(message);
    if (nextMessage) existing.message = nextMessage;
    return existing;
  }

  let token = createWaitToken();
  while (waitingForUserByToken.has(token)) {
    token = createWaitToken();
  }

  let resolvePromise!: (value: BrowseResponse) => void;
  const promise = new Promise<BrowseResponse>((resolve) => {
    resolvePromise = resolve;
  });

  const pending: PendingWaitForUser = {
    requestId,
    groupFolder,
    token,
    createdAt: new Date().toISOString(),
    message: normalizeWaitMessage(message),
    vncPassword: null,
    promise,
    resolve: resolvePromise,
  };

  waitingForUser.set(requestId, pending);
  waitingForUserByToken.set(token, requestId);

  // Rotate VNC password for this takeover session (async, updates entry in-place)
  rotateSandboxVncPassword()
    .then((password) => {
      pending.vncPassword = password;
    })
    .catch((err) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to rotate VNC password for new takeover session',
      );
    });

  return pending;
}

function completePendingWaitForUser(
  pending: PendingWaitForUser,
  result: BrowseResponse,
): void {
  waitingForUser.delete(pending.requestId);
  waitingForUserByToken.delete(pending.token);
  pending.resolve(result);

  // Rotate VNC password to invalidate the old takeover session's credential.
  // Fire-and-forget: don't block the resolve on this.
  rotateSandboxVncPassword().catch((err) => {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to rotate VNC password after takeover completion',
    );
  });
}

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

export async function runCuaCommand(
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

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function shellSingleQuote(value: string): string {
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

  // Split multi-word descriptors into individual words as candidates.
  // e.g. "Search Input" → also try "Search" and "Input" individually.
  const words = raw.split(/\s+/).filter((w) => w.length >= 3);
  if (words.length > 1) {
    for (const word of words) {
      addQueryCandidate(candidates, word);
    }
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

// ─── Vision Fallback for Element Finding ────────────────────────────────────

const VISION_MODEL = 'claude-sonnet-4-5-20250929';
const VISION_RATE_LIMIT_WINDOW_MS = 10_000;
const VISION_RATE_LIMIT_MAX = 3;
const VISION_SCREENSHOT_CACHE_MS = 2_000;

const visionCallTimestamps: number[] = [];
let cachedVisionScreenshot: { base64: string; timestamp: number } | null = null;

function resolveApiKeyForVision(): string | null {
  // Check process.env first
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;

  // Fallback: read from data/env/env file (written by container-runner credential resolution)
  try {
    const envFilePath = path.join(DATA_DIR, 'env', 'env');
    if (fs.existsSync(envFilePath)) {
      const content = fs.readFileSync(envFilePath, 'utf-8');
      for (const line of content.split('\n')) {
        const match = line.match(/^ANTHROPIC_API_KEY=(.+)$/);
        if (match) return match[1].trim();
      }
    }
  } catch {
    // ignore
  }

  return null;
}

function isVisionRateLimited(): boolean {
  const now = Date.now();
  // Remove timestamps outside the window
  while (visionCallTimestamps.length > 0 && visionCallTimestamps[0] < now - VISION_RATE_LIMIT_WINDOW_MS) {
    visionCallTimestamps.shift();
  }
  return visionCallTimestamps.length >= VISION_RATE_LIMIT_MAX;
}

async function findElementViaVision(
  description: string,
): Promise<LocatedElement | null> {
  const apiKey = resolveApiKeyForVision();
  if (!apiKey) {
    logger.debug('Vision fallback skipped: no ANTHROPIC_API_KEY available');
    return null;
  }

  if (isVisionRateLimited()) {
    logger.debug('Vision fallback skipped: rate limited');
    return null;
  }

  try {
    // Get screenshot (use cache if recent)
    let base64: string | null = null;
    if (cachedVisionScreenshot && Date.now() - cachedVisionScreenshot.timestamp < VISION_SCREENSHOT_CACHE_MS) {
      base64 = cachedVisionScreenshot.base64;
    } else {
      const screenshotContent = await runCuaCommand('screenshot');
      base64 = extractBase64Png(screenshotContent);
      if (base64) {
        cachedVisionScreenshot = { base64, timestamp: Date.now() };
      }
    }

    if (!base64) {
      logger.warn('Vision fallback: could not capture screenshot');
      return null;
    }

    const screenshotBytes = Buffer.from(base64, 'base64');
    const dimensions = getImageDimensionsFromBytes(screenshotBytes)
      || (await getScreenSizeSafe())
      || { width: 1024, height: 768 };

    // Record the call for rate limiting
    visionCallTimestamps.push(Date.now());

    logger.info({ description }, 'Vision fallback: calling Anthropic Messages API');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        max_tokens: 256,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: base64 },
            },
            {
              type: 'text',
              text: `This screenshot is ${dimensions.width}x${dimensions.height} pixels. Find the UI element matching this description: "${description}". Return ONLY a JSON object with the center pixel coordinates: {"x": number, "y": number}. If not found, return {"x": null, "y": null}. No other text.`,
            },
          ],
        }],
      }),
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, 'Vision fallback: API call failed');
      return null;
    }

    const result = await response.json() as {
      content?: Array<{ type: string; text?: string }>;
    };
    const textBlock = result.content?.find((b) => b.type === 'text');
    if (!textBlock?.text) {
      logger.warn('Vision fallback: no text in API response');
      return null;
    }

    // Extract JSON from the response (may be wrapped in markdown code block)
    const jsonMatch = textBlock.text.match(/\{[^}]+\}/);
    if (!jsonMatch) {
      logger.warn({ text: textBlock.text.slice(0, 200) }, 'Vision fallback: no JSON in response');
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]) as { x: number | null; y: number | null };
    if (parsed.x == null || parsed.y == null) {
      logger.info({ description }, 'Vision fallback: element not found in screenshot');
      return null;
    }

    // Validate coordinates are within screen bounds
    const x = Math.round(parsed.x);
    const y = Math.round(parsed.y);
    if (x < 0 || x >= dimensions.width || y < 0 || y >= dimensions.height) {
      logger.warn({ x, y, dimensions }, 'Vision fallback: coordinates out of bounds');
      return null;
    }

    logger.info({ description, x, y }, 'Element found via vision fallback');
    return { coords: { x, y }, matchedQuery: `vision:${description}` };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Vision fallback: unexpected error',
    );
    return null;
  }
}

// ─── Element Coordinate Finding ──────────────────────────────────────────────

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
          { command: 'find_element', args: { title: query } },
          { command: 'find_element', args: { role: 'entry', title: query } },
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

  // Fallback: parse the accessibility tree ourselves to find the element.
  const treeMatch = await findElementInAccessibilityTree(queries);
  if (treeMatch) return treeMatch;

  // Vision fallback: use Claude's vision API to locate the element in a screenshot.
  const visionMatch = await findElementViaVision(queries[0]);
  if (visionMatch) return visionMatch;

  return null;
}

const LABEL_FIELDS = [
  'title',
  'label',
  'name',
  'text',
  'description',
  'value',
  'content',
  'aria_label',
  'ariaLabel',
  'placeholder',
];

async function findElementInAccessibilityTree(
  queries: string[],
): Promise<LocatedElement | null> {
  if (queries.length === 0) return null;

  const snapshot = await getAccessibilitySnapshotSafe();
  if (!snapshot) return null;

  const screenSize =
    (await getScreenSizeSafe()) || { width: 1024, height: 768 };

  return matchElementInSnapshot(snapshot, queries, screenSize);
}

export function matchElementInSnapshot(
  snapshot: unknown,
  queries: string[],
  screenSize: { width: number; height: number },
): LocatedElement | null {
  if (queries.length === 0) return null;

  const root = resolveAccessibilityRoot(snapshot);
  if (!root) return null;

  const nodes: Record<string, unknown>[] = [];
  collectAccessibilityNodes(root, nodes);

  type Candidate = LocatedElement & {
    interactive: boolean;
    area: number;
    exact: boolean;
  };
  const candidates: Candidate[] = [];

  for (const node of nodes) {
    const bounds = extractBoundsFromNode(node);
    if (!bounds) continue;

    const resolved = resolvePixelBounds(bounds, screenSize.width, screenSize.height);
    if (!resolved) continue;

    const role = firstNonEmptyString(node, [
      'role',
      'class',
      'type',
      'controlType',
      'control_type',
    ]);

    // Collect all label-like text from the node for matching.
    const labelTexts: string[] = [];
    for (const field of LABEL_FIELDS) {
      const raw = node[field];
      if (typeof raw === 'string' && raw.trim()) {
        labelTexts.push(raw.trim());
      }
    }
    if (labelTexts.length === 0) continue;

    const normalizedLabels = labelTexts.map(normalizeForSearch);

    for (const query of queries) {
      const normalizedQuery = normalizeForSearch(query);
      if (!normalizedQuery) continue;

      const exact = normalizedLabels.some((l) => l === normalizedQuery);
      const partial = !exact && normalizedLabels.some((l) => l.includes(normalizedQuery));
      if (!exact && !partial) continue;

      const centerX = Math.round(resolved.x + resolved.width / 2);
      const centerY = Math.round(resolved.y + resolved.height / 2);
      const interactive = nodeIsInteractive(node, role);
      const area = resolved.width * resolved.height;

      candidates.push({
        coords: { x: centerX, y: centerY },
        matchedQuery: query,
        interactive,
        area,
        exact,
      });
      break; // One match per node is enough
    }
  }

  if (candidates.length === 0) return null;

  // Prefer: exact match > interactive > smallest area
  candidates.sort((a, b) => {
    if (a.exact !== b.exact) return a.exact ? -1 : 1;
    if (a.interactive !== b.interactive) return a.interactive ? -1 : 1;
    return a.area - b.area;
  });

  return {
    coords: candidates[0].coords,
    matchedQuery: candidates[0].matchedQuery,
  };
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

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function getImageDimensionsFromBytes(
  bytes: Buffer,
): { width: number; height: number } | null {
  // PNG: width/height in IHDR chunk at offsets 16..23 (big-endian)
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  ) {
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width > 0 && height > 0) return { width, height };
  }

  // GIF: logical screen descriptor at offsets 6..9 (little-endian)
  if (bytes.length >= 10) {
    const signature = bytes.subarray(0, 6).toString('ascii');
    if (signature === 'GIF87a' || signature === 'GIF89a') {
      const width = bytes.readUInt16LE(6);
      const height = bytes.readUInt16LE(8);
      if (width > 0 && height > 0) return { width, height };
    }
  }

  // JPEG: scan SOF markers for dimensions.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
      if (offset + 3 >= bytes.length) break;

      const marker = bytes[offset + 1];
      offset += 2;

      if (marker === 0xd8 || marker === 0x01) continue;
      if (marker === 0xd9 || marker === 0xda) break;
      if (offset + 2 > bytes.length) break;

      const segmentLength = bytes.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > bytes.length) break;

      const isSofMarker =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSofMarker && segmentLength >= 7) {
        const height = bytes.readUInt16BE(offset + 3);
        const width = bytes.readUInt16BE(offset + 5);
        if (width > 0 && height > 0) return { width, height };
        break;
      }

      offset += segmentLength;
    }
  }

  return null;
}

async function getScreenSizeSafe(): Promise<{
  width: number;
  height: number;
} | null> {
  try {
    const response = await runCuaCommand('get_screen_size');
    if (!response || typeof response !== 'object') return null;
    const record = response as Record<string, unknown>;

    const nested = coerceSnapshotRecord(record.size);
    const width = toFiniteNumber(record.width) ?? toFiniteNumber(nested?.width);
    const height =
      toFiniteNumber(record.height) ?? toFiniteNumber(nested?.height);
    if (typeof width === 'number' && typeof height === 'number') {
      if (width > 0 && height > 0) {
        return { width: Math.round(width), height: Math.round(height) };
      }
    }
  } catch {
    // best-effort
  }
  return null;
}

function firstNonEmptyString(
  record: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const raw = record[key];
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function resolveAccessibilityRoot(
  snapshot: unknown,
): Record<string, unknown> | null {
  const record = coerceSnapshotRecord(snapshot);
  if (!record) return null;
  return coerceSnapshotRecord(record.tree) || record;
}

function collectAccessibilityNodes(
  node: Record<string, unknown>,
  output: Record<string, unknown>[],
  depth = 0,
): void {
  if (depth > 200) return;
  output.push(node);

  const childKeys = ['children', 'nodes', 'elements', 'items'];
  for (const key of childKeys) {
    const raw = node[key];
    if (!Array.isArray(raw)) continue;
    for (const child of raw) {
      const childRecord = coerceSnapshotRecord(child);
      if (!childRecord) continue;
      collectAccessibilityNodes(childRecord, output, depth + 1);
    }
  }
}

type RawBounds = { x: number; y: number; width: number; height: number };

function boxFromXywh(
  x: number | null,
  y: number | null,
  width: number | null,
  height: number | null,
): RawBounds | null {
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number'
  ) {
    return null;
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function boxFromCorners(
  x1: number | null,
  y1: number | null,
  x2: number | null,
  y2: number | null,
): RawBounds | null {
  if (
    typeof x1 !== 'number' ||
    typeof y1 !== 'number' ||
    typeof x2 !== 'number' ||
    typeof y2 !== 'number'
  ) {
    return null;
  }
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);
  return boxFromXywh(left, top, width, height);
}

function extractBoundsFromNode(
  node: Record<string, unknown>,
): RawBounds | null {
  const bounds = coerceSnapshotRecord(node.bounds);
  if (bounds) {
    const xywh =
      boxFromXywh(
        toFiniteNumber(bounds.x),
        toFiniteNumber(bounds.y),
        toFiniteNumber(bounds.width),
        toFiniteNumber(bounds.height),
      ) ||
      boxFromCorners(
        toFiniteNumber(bounds.left) ?? toFiniteNumber(bounds.x1),
        toFiniteNumber(bounds.top) ?? toFiniteNumber(bounds.y1),
        toFiniteNumber(bounds.right) ?? toFiniteNumber(bounds.x2),
        toFiniteNumber(bounds.bottom) ?? toFiniteNumber(bounds.y2),
      );
    if (xywh) return xywh;
  }

  const position = coerceSnapshotRecord(node.position);
  const size = coerceSnapshotRecord(node.size);
  const positionSize = boxFromXywh(
    toFiniteNumber(position?.x),
    toFiniteNumber(position?.y),
    toFiniteNumber(size?.width),
    toFiniteNumber(size?.height),
  );
  if (positionSize) return positionSize;

  const directXywh = boxFromXywh(
    toFiniteNumber(node.x),
    toFiniteNumber(node.y),
    toFiniteNumber(node.width),
    toFiniteNumber(node.height),
  );
  if (directXywh) return directXywh;

  const directCorners = boxFromCorners(
    toFiniteNumber(node.x1),
    toFiniteNumber(node.y1),
    toFiniteNumber(node.x2),
    toFiniteNumber(node.y2),
  );
  if (directCorners) return directCorners;

  if (Array.isArray(node.bbox) && node.bbox.length >= 4) {
    const [x1, y1, x2, y2] = node.bbox;
    const fromBbox = boxFromCorners(
      toFiniteNumber(x1),
      toFiniteNumber(y1),
      toFiniteNumber(x2),
      toFiniteNumber(y2),
    );
    if (fromBbox) return fromBbox;
  }

  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function resolvePixelBounds(
  bounds: RawBounds,
  imageWidth: number,
  imageHeight: number,
): RawBounds | null {
  let { x, y, width, height } = bounds;

  const normalizedCandidate =
    x >= 0 &&
    x <= 1 &&
    y >= 0 &&
    y <= 1 &&
    width >= 0 &&
    width <= 1 &&
    height >= 0 &&
    height <= 1;
  if (normalizedCandidate) {
    x *= imageWidth;
    y *= imageHeight;
    width *= imageWidth;
    height *= imageHeight;
  }

  const x1 = clamp(x, 0, imageWidth);
  const y1 = clamp(y, 0, imageHeight);
  const x2 = clamp(x + width, 0, imageWidth);
  const y2 = clamp(y + height, 0, imageHeight);
  const resolvedWidth = x2 - x1;
  const resolvedHeight = y2 - y1;

  if (resolvedWidth < 2 || resolvedHeight < 2) return null;
  return { x: x1, y: y1, width: resolvedWidth, height: resolvedHeight };
}

function toGridColumnName(col: number): string {
  let index = col;
  let label = '';
  while (index > 0) {
    const remainder = (index - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    index = Math.floor((index - 1) / 26);
  }
  return label || 'A';
}

function toGridCell(
  x: number,
  y: number,
  grid: ScreenshotGrid,
): { row: number; col: number; key: string } {
  const col = clamp(
    Math.floor((x / Math.max(grid.width, 1)) * grid.cols) + 1,
    1,
    grid.cols,
  );
  const row = clamp(
    Math.floor((y / Math.max(grid.height, 1)) * grid.rows) + 1,
    1,
    grid.rows,
  );
  const key = `${toGridColumnName(col)}${row}`;
  return { row, col, key };
}

function nodeIsInteractive(
  node: Record<string, unknown>,
  role: string | null,
): boolean {
  const roleText = (role || '').toLowerCase();
  if (node.clickable === true) return true;
  if (node.interactive === true || node.interactivity === true) return true;
  return /button|input|entry|link|checkbox|textbox|tab|menuitem|combobox|search/i.test(
    roleText,
  );
}

function shouldSkipStructuralNode(
  role: string | null,
  bounds: RawBounds,
  imageWidth: number,
  imageHeight: number,
  hasChildren: boolean,
): boolean {
  const roleText = (role || '').toLowerCase();
  const areaRatio =
    (bounds.width * bounds.height) / Math.max(imageWidth * imageHeight, 1);
  if (!hasChildren) return false;
  if (areaRatio < 0.85) return false;
  return /window|application|desktop|pane/.test(roleText);
}

function formatAnalysisSummary(
  screenshotPath: string,
  analysis: ScreenshotAnalysis,
): string {
  const lines: string[] = [];
  lines.push(`Screenshot saved: ${screenshotPath}`);
  lines.push(
    `Grid: ${analysis.grid.cols}x${analysis.grid.rows} (${analysis.grid.width}x${analysis.grid.height})`,
  );
  lines.push(
    `Detected elements: ${analysis.elementCount}${analysis.truncated ? ` (showing ${analysis.elements.length})` : ''}`,
  );

  if (analysis.elements.length > 0) {
    lines.push('Labeled elements:');
    const limited = analysis.elements.slice(0, SCREENSHOT_SUMMARY_LIMIT);
    for (const element of limited) {
      const rolePart = element.role ? ` role=${element.role}` : '';
      lines.push(
        `${element.id}. [${element.grid.key}] "${element.label}"${rolePart} center=(${element.center.x},${element.center.y})`,
      );
    }
    if (analysis.elements.length > limited.length) {
      lines.push(
        `... ${analysis.elements.length - limited.length} additional element(s) omitted`,
      );
    }
  } else {
    lines.push(
      'Labeled elements: none (accessibility tree did not expose element bounds).',
    );
    lines.push(
      'IMPORTANT: Use the Read tool on the screenshot path above to visually identify elements, then use browse_click_xy with pixel coordinates.',
    );
  }

  if (analysis.metadataPath) {
    lines.push(`Metadata JSON: ${analysis.metadataPath}`);
  }

  if (analysis.elements.length > 0) {
    lines.push(
      'Tip: If browse_click fails for any element, use browse_click_xy with the center coordinates shown above.',
    );
  }

  return lines.join('\n');
}

export function buildScreenshotAnalysis(
  snapshot: unknown,
  imageDimensions: { width: number; height: number },
  options?: { rows?: number; cols?: number; maxElements?: number },
): ScreenshotAnalysis {
  const grid: ScreenshotGrid = {
    rows: options?.rows || SCREENSHOT_GRID_ROWS,
    cols: options?.cols || SCREENSHOT_GRID_COLS,
    width: Math.max(1, Math.round(imageDimensions.width)),
    height: Math.max(1, Math.round(imageDimensions.height)),
  };
  const maxElements = Math.max(
    1,
    options?.maxElements || SCREENSHOT_MAX_ELEMENTS,
  );

  const nodes: Record<string, unknown>[] = [];
  const root = resolveAccessibilityRoot(snapshot);
  if (root) collectAccessibilityNodes(root, nodes);

  const seen = new Set<string>();
  const candidates: Array<
    Omit<ScreenshotAnalysisElement, 'id'> & { sortWeight: number }
  > = [];

  for (const node of nodes) {
    const bounds = extractBoundsFromNode(node);
    if (!bounds) continue;

    const resolvedBounds = resolvePixelBounds(bounds, grid.width, grid.height);
    if (!resolvedBounds) continue;

    const role = firstNonEmptyString(node, [
      'role',
      'class',
      'type',
      'controlType',
      'control_type',
    ]);
    const labelCandidate = firstNonEmptyString(node, [
      'title',
      'label',
      'name',
      'text',
      'description',
      'value',
      'content',
      'aria_label',
      'ariaLabel',
      'placeholder',
      'resource_id',
      'resourceId',
      'id',
    ]);
    const hasChildren =
      Array.isArray(node.children) && node.children.length > 0;

    if (
      shouldSkipStructuralNode(
        role,
        resolvedBounds,
        grid.width,
        grid.height,
        hasChildren,
      )
    ) {
      continue;
    }

    const label = labelCandidate || role || 'unnamed element';
    const centerX = Math.round(resolvedBounds.x + resolvedBounds.width / 2);
    const centerY = Math.round(resolvedBounds.y + resolvedBounds.height / 2);
    const dedupeKey = `${centerX}:${centerY}:${normalizeForSearch(label)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const interactive = nodeIsInteractive(node, role);
    const gridCell = toGridCell(centerX, centerY, grid);
    candidates.push({
      label,
      role: role || null,
      interactive,
      center: { x: centerX, y: centerY },
      bounds: {
        x: Math.round(resolvedBounds.x),
        y: Math.round(resolvedBounds.y),
        width: Math.round(resolvedBounds.width),
        height: Math.round(resolvedBounds.height),
      },
      grid: gridCell,
      sortWeight: interactive ? 0 : 1,
    });
  }

  candidates.sort((a, b) => {
    if (a.sortWeight !== b.sortWeight) return a.sortWeight - b.sortWeight;
    if (a.center.y !== b.center.y) return a.center.y - b.center.y;
    return a.center.x - b.center.x;
  });

  const limited = candidates.slice(0, maxElements).map((element, index) => ({
    id: index + 1,
    label: element.label,
    role: element.role,
    interactive: element.interactive,
    center: element.center,
    bounds: element.bounds,
    grid: element.grid,
  }));

  return {
    capturedAt: new Date().toISOString(),
    grid,
    elementCount: candidates.length,
    truncated: candidates.length > limited.length,
    elements: limited,
    summary: '',
  };
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
    case 'click_xy': {
      const x = Number(params.x);
      const y = Number(params.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return {
          status: 'error',
          error: 'click_xy requires valid numeric x and y coordinates',
        };
      }
      const beforeSnapshot = await getAccessibilitySnapshotSafe();
      await runCuaCommand('left_click', { x, y });
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
        result: `clicked (${x}, ${y})${verificationSuffix(verify)}`,
      };
    }
    case 'type_at_xy': {
      const x = Number(params.x);
      const y = Number(params.y);
      const value = String(params.value || '');
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return {
          status: 'error',
          error: 'type_at_xy requires valid numeric x and y coordinates',
        };
      }
      const beforeSnapshot = await getAccessibilitySnapshotSafe();
      await runCuaCommand('left_click', { x, y });
      if (params.clear_first) {
        // Select all existing content before typing, so the new value
        // replaces instead of appending (useful for spreadsheet cells, etc.)
        await runCuaCommandWithFallback([
          { command: 'press_key', args: { key: 'ctrl+a' } },
          { command: 'hotkey', args: { keys: 'ctrl+a' } },
        ]);
        await sleep(100);
      }
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
        result: `typed at (${x}, ${y})${verificationSuffix(verify)}`,
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
      const direction = String(params.direction || 'down');
      const clicks = Math.max(1, Math.round(Number(params.clicks || 3)));
      const beforeSnapshot = await getAccessibilitySnapshotSafe();

      // Use dedicated directional scroll commands which work in discrete
      // "wheel click" units — much more reliable than raw pixel deltas.
      const dirCommand: Record<string, string> = {
        up: 'scroll_up',
        down: 'scroll_down',
        left: 'scroll_left',
        right: 'scroll_right',
      };
      const cmd = dirCommand[direction] || 'scroll_down';
      await runCuaCommandWithFallback([
        { command: cmd, args: { clicks } },
        { command: 'scroll_direction', args: { direction, clicks } },
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
        result: `scrolled ${direction} ${clicks} clicks${verificationSuffix(verify)}`,
      };
    }
    case 'screenshot': {
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
      const screenshotBytes = Buffer.from(base64, 'base64');
      fs.writeFileSync(filePath, screenshotBytes);

      const screenshotPath = `/workspace/group/media/${filename}`;
      const imageSize = getImageDimensionsFromBytes(screenshotBytes) ||
        (await getScreenSizeSafe()) || { width: 1024, height: 768 };
      const snapshot = await getAccessibilitySnapshotSafe();
      const analysis = buildScreenshotAnalysis(snapshot, imageSize);
      const metadataFilename = filename.replace(/\.png$/, '.labels.json');
      const metadataPath = `/workspace/group/media/${metadataFilename}`;
      analysis.metadataPath = metadataPath;
      analysis.summary = formatAnalysisSummary(screenshotPath, analysis);
      fs.writeFileSync(
        path.join(mediaDir, metadataFilename),
        JSON.stringify(analysis, null, 2),
      );

      return { status: 'ok', result: screenshotPath, analysis };
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

    case 'perform': {
      const steps = params.steps as
        | Array<Record<string, unknown>>
        | undefined;
      if (!Array.isArray(steps) || steps.length === 0) {
        return {
          status: 'error',
          error: 'perform requires a non-empty steps array',
        };
      }
      if (steps.length > 50) {
        return {
          status: 'error',
          error: 'perform supports a maximum of 50 steps per call',
        };
      }

      const blockedKeys = ['ctrl+alt+delete', 'ctrl+alt+backspace'];
      const results: string[] = [];
      const beforeSnapshot = await getAccessibilitySnapshotSafe();

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const stepAction = String(step.action || '');
        try {
          switch (stepAction) {
            case 'click':
              await runCuaCommand('left_click', {
                x: Number(step.x),
                y: Number(step.y),
              });
              results.push(`click(${step.x},${step.y})`);
              break;
            case 'double_click':
              await runCuaCommand('double_click', {
                x: Number(step.x),
                y: Number(step.y),
              });
              results.push(`double_click(${step.x},${step.y})`);
              break;
            case 'right_click':
              await runCuaCommand('right_click', {
                x: Number(step.x),
                y: Number(step.y),
              });
              results.push(`right_click(${step.x},${step.y})`);
              break;
            case 'key': {
              const key = String(step.key || '')
                .trim()
                .toLowerCase();
              if (!key) {
                results.push('key() SKIPPED: empty key');
                break;
              }
              if (blockedKeys.includes(key)) {
                results.push(`key(${key}) BLOCKED`);
                break;
              }
              await runCuaCommandWithFallback([
                { command: 'press_key', args: { key } },
                { command: 'hotkey', args: { keys: key } },
              ]);
              results.push(`key(${key})`);
              break;
            }
            case 'type': {
              const text = String(step.text || '');
              await runCuaCommandWithFallback([
                { command: 'type', args: { text } },
                { command: 'type_text', args: { text } },
              ]);
              results.push(
                `type("${text.length > 30 ? text.slice(0, 30) + '…' : text}")`,
              );
              break;
            }
            case 'scroll': {
              const scrollClicks = Math.max(
                1,
                Math.round(Number(step.amount || 3)),
              );
              const dir = String(step.direction || 'down');
              const scrollDirCommand: Record<string, string> = {
                up: 'scroll_up',
                down: 'scroll_down',
                left: 'scroll_left',
                right: 'scroll_right',
              };
              const scrollCmd =
                scrollDirCommand[dir] || 'scroll_down';
              await runCuaCommandWithFallback([
                {
                  command: scrollCmd,
                  args: { clicks: scrollClicks },
                },
                {
                  command: 'scroll_direction',
                  args: { direction: dir, clicks: scrollClicks },
                },
              ]);
              results.push(`scroll(${dir},${scrollClicks})`);
              break;
            }
            case 'drag':
              await runCuaCommand('drag_to', {
                x: Number(step.to_x),
                y: Number(step.to_y),
                start_x: Number(step.from_x),
                start_y: Number(step.from_y),
              });
              results.push(
                `drag(${step.from_x},${step.from_y}->${step.to_x},${step.to_y})`,
              );
              break;
            case 'hover':
              await runCuaCommand('move_cursor', {
                x: Number(step.x),
                y: Number(step.y),
              });
              results.push(`hover(${step.x},${step.y})`);
              break;
            case 'wait': {
              const ms = Math.min(Math.max(Number(step.ms || 250), 0), 5000);
              await sleep(ms);
              results.push(`wait(${ms}ms)`);
              break;
            }
            default:
              results.push(`unknown(${stepAction})`);
          }
          // Small delay between steps for UI to settle (skip after explicit waits)
          if (stepAction !== 'wait' && i < steps.length - 1) {
            await sleep(100);
          }
        } catch (err) {
          const msg =
            err instanceof Error ? err.message : String(err);
          results.push(`${stepAction} FAILED: ${msg}`);
          // Continue executing remaining steps so partial sequences still work
        }
      }

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
        result: `performed ${steps.length} steps: ${results.join(' → ')}${verificationSuffix(verify)}`,
      };
    }

    case 'extract_file': {
      const filePath = String(params.path || '').trim();
      if (!filePath) {
        return { status: 'error', error: 'extract_file requires a path' };
      }
      if (filePath.includes('..')) {
        return {
          status: 'error',
          error: 'Path traversal (..) is not allowed',
        };
      }

      const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

      // Check file exists and get size
      let fileSize: number;
      try {
        const statResult = await runCuaCommand('run_command', {
          command: `stat -c '%s' ${shellSingleQuote(filePath)} 2>/dev/null || stat -f '%z' ${shellSingleQuote(filePath)} 2>/dev/null`,
        });
        const sizeStr = String(statResult).trim().replace(/'/g, '');
        fileSize = parseInt(sizeStr, 10);
        if (isNaN(fileSize)) {
          return {
            status: 'error',
            error: `File not found or cannot stat: ${filePath}`,
          };
        }
      } catch (err) {
        return {
          status: 'error',
          error: `File not found: ${filePath} (${err instanceof Error ? err.message : String(err)})`,
        };
      }

      if (fileSize > MAX_FILE_SIZE) {
        return {
          status: 'error',
          error: `File too large: ${(fileSize / 1024 / 1024).toFixed(1)}MB exceeds 100MB limit`,
        };
      }

      // Read file as base64
      let base64Content: string;
      try {
        const result = await runCuaCommand('run_command', {
          command: `base64 -w0 ${shellSingleQuote(filePath)} 2>/dev/null || base64 ${shellSingleQuote(filePath)} 2>/dev/null | tr -d '\\n'`,
        });
        base64Content = String(result).trim();
        if (!base64Content) {
          return {
            status: 'error',
            error: `Failed to read file contents: ${filePath}`,
          };
        }
      } catch (err) {
        return {
          status: 'error',
          error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      // Save to group media directory
      const originalFilename = path.basename(filePath);
      const mediaDir = path.join(GROUPS_DIR, groupFolder, 'media');
      fs.mkdirSync(mediaDir, { recursive: true });

      // Deduplicate filename with timestamp
      const ext = path.extname(originalFilename);
      const stem = path.basename(originalFilename, ext);
      const destFilename = `${stem}-${Date.now()}${ext}`;
      const destPath = path.join(mediaDir, destFilename);

      const fileBuffer = Buffer.from(base64Content, 'base64');
      base64Content = ''; // free base64 string for GC
      fs.writeFileSync(destPath, fileBuffer);

      const containerPath = `/workspace/group/media/${destFilename}`;
      logger.info(
        { filePath, destPath, size: fileBuffer.length, groupFolder },
        'Extracted file from CUA sandbox',
      );
      return { status: 'ok', result: containerPath };
    }

    case 'upload_file': {
      const sourcePath = String(params.source_path || '').trim();
      if (!sourcePath) {
        return {
          status: 'error',
          error: 'upload_file requires a source_path',
        };
      }
      if (sourcePath.includes('..')) {
        return {
          status: 'error',
          error: 'Path traversal (..) is not allowed',
        };
      }

      // Translate container path to host path
      const filename = path.basename(sourcePath);
      let hostPath: string;
      if (sourcePath.startsWith('/workspace/group/')) {
        hostPath = path.join(
          GROUPS_DIR,
          groupFolder,
          sourcePath.slice('/workspace/group/'.length),
        );
      } else if (sourcePath.startsWith('/workspace/global/')) {
        hostPath = path.join(
          GROUPS_DIR,
          'global',
          sourcePath.slice('/workspace/global/'.length),
        );
      } else {
        return {
          status: 'error',
          error: `Source path must start with /workspace/group/ or /workspace/global/: ${sourcePath}`,
        };
      }

      if (!fs.existsSync(hostPath)) {
        return {
          status: 'error',
          error: `Source file not found on host: ${sourcePath}`,
        };
      }

      const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
      const fileStat = fs.statSync(hostPath);
      if (fileStat.size > MAX_FILE_SIZE) {
        return {
          status: 'error',
          error: `File too large: ${(fileStat.size / 1024 / 1024).toFixed(1)}MB exceeds 100MB limit`,
        };
      }

      const destPath = params.destination_path
        ? String(params.destination_path).trim()
        : `~/Downloads/${filename}`;

      if (destPath.includes('..')) {
        return {
          status: 'error',
          error: 'Destination path traversal (..) is not allowed',
        };
      }

      // Ensure destination directory exists
      const destDir = destPath.includes('/')
        ? destPath.substring(0, destPath.lastIndexOf('/'))
        : '~/Downloads';
      try {
        await runCuaCommand('run_command', {
          command: `mkdir -p ${shellSingleQuote(destDir)}`,
        });
      } catch {
        // Best effort — directory may already exist
      }

      // Stream file in chunks to CUA to avoid loading entire file into memory.
      // Chunk size must be a multiple of 3 so base64 encoding produces no
      // padding (except the final chunk), preventing corruption on append.
      const RAW_CHUNK_SIZE = 48 * 1024; // 48KB raw → 64KB base64
      const fd = fs.openSync(hostPath, 'r');
      const chunkBuf = Buffer.alloc(RAW_CHUNK_SIZE);
      let readOffset = 0;
      let chunkIndex = 0;

      try {
        while (true) {
          const bytesRead = fs.readSync(fd, chunkBuf, 0, RAW_CHUNK_SIZE, readOffset);
          if (bytesRead === 0) break;

          const b64Chunk = chunkBuf.subarray(0, bytesRead).toString('base64');
          const redirect = chunkIndex === 0 ? '>' : '>>';
          try {
            await runCuaCommand('run_command', {
              command: `printf '%s' ${shellSingleQuote(b64Chunk)} | base64 -d ${redirect} ${shellSingleQuote(destPath)}`,
            });
          } catch (err) {
            return {
              status: 'error',
              error: `Failed to write file chunk ${chunkIndex + 1} to CUA: ${err instanceof Error ? err.message : String(err)}`,
            };
          }

          readOffset += bytesRead;
          chunkIndex++;
        }
      } finally {
        fs.closeSync(fd);
      }

      logger.info(
        {
          sourcePath,
          destPath,
          size: fileStat.size,
          groupFolder,
        },
        'Uploaded file to CUA sandbox',
      );
      return {
        status: 'ok',
        result: `Uploaded ${filename} (${(fileStat.size / 1024).toFixed(1)}KB) to ${destPath}`,
      };
    }

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
): Promise<BrowseResponse> {
  resetIdleTimer();

  try {
    if (action === 'wait_for_user') {
      const pending = ensurePendingWaitForUser(
        requestId,
        groupFolder,
        params.message,
      );
      return pending.promise;
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

export function ensureWaitForUserRequest(
  requestId: string,
  groupFolder: string,
  message?: unknown,
): PendingWaitForUserView {
  const pending = ensurePendingWaitForUser(requestId, groupFolder, message);
  return toPendingView(pending);
}

export function getWaitForUserRequest(
  requestId: string,
): PendingWaitForUserView | null {
  const pending = waitingForUser.get(requestId);
  if (!pending) return null;
  return toPendingView(pending);
}

export function getOldestWaitForUserRequest(
  groupFolder?: string,
): PendingWaitForUserView | null {
  for (const pending of waitingForUser.values()) {
    if (groupFolder && pending.groupFolder !== groupFolder) continue;
    return toPendingView(pending);
  }
  return null;
}

export function getWaitForUserRequestByToken(
  token: string,
): PendingWaitForUserView | null {
  const requestId = waitingForUserByToken.get(token);
  if (!requestId) return null;
  return getWaitForUserRequest(requestId);
}

export function resolveWaitForUserByToken(token: string): boolean {
  const requestId = waitingForUserByToken.get(token);
  if (!requestId) return false;

  const pending = waitingForUser.get(requestId);
  if (!pending) {
    waitingForUserByToken.delete(token);
    return false;
  }

  completePendingWaitForUser(pending, {
    status: 'ok',
    result: 'User continued',
  });
  return true;
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
    completePendingWaitForUser(pending, {
      status: 'ok',
      result: 'User continued',
    });
    return true;
  }

  // If no specific ID, resolve the oldest waiting request for this group.
  for (const pending of waitingForUser.values()) {
    if (pending.groupFolder !== groupFolder) continue;
    completePendingWaitForUser(pending, {
      status: 'ok',
      result: 'User continued',
    });
    return true;
  }
  return false;
}

export function getAllWaitingRequests(): PendingWaitForUserView[] {
  return [...waitingForUser.values()].map(toPendingView);
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
