/**
 * BrowseHostLive — bridges container browse requests to CUA sandbox.
 */

import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { Buffer } from 'buffer';
import { Effect, Layer } from 'effect';

import { AppConfig } from '../config.js';
import { Sandbox } from './Sandbox.js';
import { Telegram } from './Telegram.js';
import { BrowseError, BrowseWaitTimeoutError } from '../errors.js';
import { BrowseHost } from './BrowseHost.js';
import type {
  BrowseHostService,
  BrowseResult,
  ScreenshotAnalysis,
  ScreenshotAnalysisElement,
  ScreenshotGrid,
} from './BrowseHost.js';
import { CuaControl } from './CuaControl.js';
import { DashboardSession } from './DashboardSession.js';
import { TakeoverWeb } from './TakeoverWeb.js';
import type { PendingTakeoverRequest } from './TakeoverWeb.js';

const WAIT_FOR_USER_TIMEOUT_MS = 10 * 60 * 1000;
const WAIT_FOR_USER_POST_CONTINUE_SCREENSHOT_TIMEOUT_MS = 2_000;
const SCREENSHOT_GRID_ROWS = 8;
const SCREENSHOT_GRID_COLS = 12;
const SCREENSHOT_MAX_ELEMENTS = 40;
const SCREENSHOT_SUMMARY_LIMIT = 20;

interface PendingWait {
  requestId: string;
  groupFolder: string;
  token: string;
  createdAt: string;
  message: string | null;
  vncPassword: string | null;
  resolve: (result: BrowseResult) => void;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
}

type LocatedElement = {
  coords: { x: number; y: number };
  matchedQuery: string;
};

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

function createWaitToken(): string {
  return randomBytes(18).toString('base64url');
}

function normalizeWaitMessage(message: unknown): string | null {
  if (typeof message !== 'string') return null;
  const trimmed = message.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeForSearch(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
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

function buildElementSearchQueries(selector: string): string[] {
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
  return toSnapshotComparableString(before) !== toSnapshotComparableString(after);
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

function nodeIsInteractive(node: Record<string, unknown>, role: string): boolean {
  if (typeof node.interactive === 'boolean') return node.interactive;
  if (typeof node.enabled === 'boolean' && node.enabled) return true;
  const lowered = role.toLowerCase();
  if (!lowered) return false;
  return (
    lowered.includes('button') ||
    lowered.includes('link') ||
    lowered.includes('input') ||
    lowered.includes('entry') ||
    lowered.includes('checkbox') ||
    lowered.includes('radio') ||
    lowered.includes('menu') ||
    lowered.includes('tab')
  );
}

function firstNonEmptyString(
  node: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): string {
  for (const key of keys) {
    const value = node[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function resolveAccessibilityRoot(snapshot: unknown): Record<string, unknown> | null {
  if (!snapshot || typeof snapshot !== 'object') {
    if (typeof snapshot === 'string') {
      try {
        const parsed = JSON.parse(snapshot) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const record = parsed as Record<string, unknown>;
          if (record.tree && typeof record.tree === 'object' && !Array.isArray(record.tree)) {
            return record.tree as Record<string, unknown>;
          }
          return record;
        }
      } catch {
        return null;
      }
    }
    return null;
  }

  const record = snapshot as Record<string, unknown>;
  if (record.tree && typeof record.tree === 'object' && !Array.isArray(record.tree)) {
    return record.tree as Record<string, unknown>;
  }
  return record;
}

function collectAccessibilityNodes(
  node: Record<string, unknown>,
  target: Array<Record<string, unknown>>,
): void {
  target.push(node);

  const childCandidates = ['children', 'nodes', 'items'];
  for (const key of childCandidates) {
    const raw = node[key];
    if (!Array.isArray(raw)) continue;
    for (const child of raw) {
      if (child && typeof child === 'object' && !Array.isArray(child)) {
        collectAccessibilityNodes(child as Record<string, unknown>, target);
      }
    }
  }
}

function extractBoundsFromNode(node: Record<string, unknown>): {
  x: number;
  y: number;
  width: number;
  height: number;
} | null {
  const candidates = ['bounds', 'bbox', 'box', 'rect'];
  for (const key of candidates) {
    const raw = node[key];
    if (!raw || typeof raw !== 'object') continue;
    const rec = raw as Record<string, unknown>;

    const x = Number(rec.x ?? rec.left ?? rec.x1 ?? 0);
    const y = Number(rec.y ?? rec.top ?? rec.y1 ?? 0);
    const width = Number(
      rec.width ??
        ((typeof rec.right === 'number' && typeof rec.left === 'number')
          ? rec.right - rec.left
          : (typeof rec.x2 === 'number' && typeof rec.x1 === 'number')
            ? rec.x2 - rec.x1
            : 0),
    );
    const height = Number(
      rec.height ??
        ((typeof rec.bottom === 'number' && typeof rec.top === 'number')
          ? rec.bottom - rec.top
          : (typeof rec.y2 === 'number' && typeof rec.y1 === 'number')
            ? rec.y2 - rec.y1
            : 0),
    );

    if (
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      Number.isFinite(width) &&
      Number.isFinite(height) &&
      width > 0 &&
      height > 0
    ) {
      return { x, y, width, height };
    }
  }

  if (
    typeof node.x === 'number' &&
    typeof node.y === 'number' &&
    typeof node.width === 'number' &&
    typeof node.height === 'number' &&
    node.width > 0 &&
    node.height > 0
  ) {
    return {
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
    };
  }

  return null;
}

function resolvePixelBounds(
  bounds: { x: number; y: number; width: number; height: number },
  screenWidth: number,
  screenHeight: number,
): { x: number; y: number; width: number; height: number } | null {
  let { x, y, width, height } = bounds;

  if (
    x >= 0 && x <= 1 &&
    y >= 0 && y <= 1 &&
    width > 0 && width <= 1 &&
    height > 0 && height <= 1
  ) {
    x = Math.round(x * screenWidth);
    y = Math.round(y * screenHeight);
    width = Math.round(width * screenWidth);
    height = Math.round(height * screenHeight);
  }

  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }

  if (width <= 0 || height <= 0) return null;

  return {
    x: Math.max(0, Math.round(x)),
    y: Math.max(0, Math.round(y)),
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
  };
}

function matchElementInSnapshot(
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

      const exact = normalizedLabels.some((label) => label === normalizedQuery);
      const partial = !exact && normalizedLabels.some((label) => label.includes(normalizedQuery));
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

      break;
    }
  }

  if (candidates.length === 0) return null;

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

function detectImageMimeFromBytes(bytes: Buffer): string | null {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  ) return 'image/png';
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) return 'image/jpeg';
  return null;
}

function getImageDimensionsFromBytes(
  bytes: Buffer,
): { width: number; height: number } | null {
  if (bytes.length >= 24 && detectImageMimeFromBytes(bytes) === 'image/png') {
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width > 0 && height > 0) {
      return { width, height };
    }
  }
  return null;
}

function toGridCell(x: number, y: number, grid: ScreenshotGrid): {
  row: number;
  col: number;
  key: string;
} {
  const colWidth = grid.width / grid.cols;
  const rowHeight = grid.height / grid.rows;
  const col = Math.min(grid.cols, Math.max(1, Math.floor(x / colWidth) + 1));
  const row = Math.min(grid.rows, Math.max(1, Math.floor(y / rowHeight) + 1));
  return { row, col, key: `R${row}C${col}` };
}

function extractBase64Image(input: unknown): string | null {
  const visited = new WeakSet<object>();

  const extractFromString = (value: string): string | null => {
    const trimmed = value.trim();

    const dataUrlMatch = value.match(/^data:image\/[A-Za-z0-9.+-]+;base64,(.+)$/s);
    if (dataUrlMatch) return dataUrlMatch[1].replace(/\s/g, '');

    let normalized = value.replace(/\s/g, '');
    if (normalized.startsWith('base64,')) normalized = normalized.slice(7);
    if (normalized.startsWith('data:image/')) {
      const idx = normalized.indexOf(';base64,');
      if (idx >= 0) normalized = normalized.slice(idx + ';base64,'.length);
    }

    const normalizedUrlSafe = normalized.replace(/-/g, '+').replace(/_/g, '/');
    const padding = normalizedUrlSafe.length % 4;
    const padded =
      padding === 0
        ? normalizedUrlSafe
        : normalizedUrlSafe + '='.repeat(4 - padding);

    if (padded.length >= 256 && /^[A-Za-z0-9+/=]+$/.test(padded)) {
      const decoded = Buffer.from(padded, 'base64');
      if (decoded.length >= 128 && detectImageMimeFromBytes(decoded)) {
        return decoded.toString('base64');
      }
    }

    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        return visit(parsed);
      } catch {
        return null;
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

    if (visited.has(value)) return null;
    visited.add(value);

    const record = value as Record<string, unknown>;
    const prioritizedKeys = [
      'screenshot',
      'image',
      'content',
      'data',
      'base64',
      'result',
      'image_url',
      'url',
    ];

    for (const key of prioritizedKeys) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      const extracted = visit(record[key]);
      if (extracted) return extracted;
    }

    for (const nested of Object.values(record)) {
      const extracted = visit(nested);
      if (extracted) return extracted;
    }

    return null;
  };

  return visit(input);
}

function buildScreenshotAnalysis(
  snapshot: unknown,
  imageSize: { width: number; height: number },
  screenshotPath: string,
): ScreenshotAnalysis {
  const grid: ScreenshotGrid = {
    rows: SCREENSHOT_GRID_ROWS,
    cols: SCREENSHOT_GRID_COLS,
    width: imageSize.width,
    height: imageSize.height,
  };

  const root = resolveAccessibilityRoot(snapshot);
  if (!root) {
    return {
      capturedAt: new Date().toISOString(),
      grid,
      elementCount: 0,
      truncated: false,
      elements: [],
      summary: `Screenshot captured: ${screenshotPath}\nNo accessibility tree available for element labels.`,
    };
  }

  const nodes: Record<string, unknown>[] = [];
  collectAccessibilityNodes(root, nodes);

  const elements: ScreenshotAnalysisElement[] = [];
  for (const node of nodes) {
    const label = firstNonEmptyString(node, LABEL_FIELDS);
    if (!label) continue;

    const role = firstNonEmptyString(node, [
      'role',
      'class',
      'type',
      'controlType',
      'control_type',
    ]) || null;

    const bounds = extractBoundsFromNode(node) || {
      x: 0,
      y: 0,
      width: Math.max(1, Math.round(imageSize.width * 0.1)),
      height: Math.max(1, Math.round(imageSize.height * 0.05)),
    };

    const resolved = resolvePixelBounds(bounds, imageSize.width, imageSize.height);
    if (!resolved) continue;

    const center = {
      x: Math.round(resolved.x + resolved.width / 2),
      y: Math.round(resolved.y + resolved.height / 2),
    };

    elements.push({
      id: elements.length + 1,
      label,
      role,
      interactive: nodeIsInteractive(node, role || ''),
      center,
      bounds: {
        x: resolved.x,
        y: resolved.y,
        width: resolved.width,
        height: resolved.height,
      },
      grid: toGridCell(center.x, center.y, grid),
    });

    if (elements.length >= SCREENSHOT_MAX_ELEMENTS) break;
  }

  const summaryItems = elements.slice(0, SCREENSHOT_SUMMARY_LIMIT).map((el) => {
    const rolePart = el.role ? ` (${el.role})` : '';
    const interactivePart = el.interactive ? ' interactive' : '';
    return `- [${el.id}] ${el.label}${rolePart}${interactivePart} @ ${el.grid.key}`;
  });

  const summaryHeader =
    `Screenshot saved: ${screenshotPath}\n` +
    `Detected ${elements.length} labeled elements.`;

  const summary =
    summaryItems.length > 0
      ? `${summaryHeader}\n${summaryItems.join('\n')}`
      : `${summaryHeader}\nNo labeled elements found in accessibility tree.`;

  return {
    capturedAt: new Date().toISOString(),
    grid,
    elementCount: elements.length,
    truncated: false,
    elements,
    summary,
  };
}

function cuaStdout(result: unknown): string {
  if (result && typeof result === 'object' && 'stdout' in result) {
    return String((result as Record<string, unknown>).stdout || '');
  }
  return String(result ?? '');
}

export const BrowseHostLive: Layer.Layer<
  BrowseHost,
  never,
  Sandbox | Telegram | AppConfig | CuaControl | DashboardSession | TakeoverWeb
> = Layer.effect(
  BrowseHost,
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;
    const telegram = yield* Telegram;
    const config = yield* AppConfig;
    const cua = yield* CuaControl;
    const dashboardSession = yield* DashboardSession;
    const takeoverWeb = yield* TakeoverWeb;

    const waiting = new Map<string, PendingWait>();
    const waitingByToken = new Map<string, string>();

    const sleep = (ms: number) => Effect.sleep(`${ms} millis`);

    const getAccessibilitySnapshotSafe = Effect.tryPromise({
      try: () => Effect.runPromise(cua.command('get_accessibility_tree')),
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => null));

    const getScreenSizeSafe = Effect.tryPromise({
      try: async () => {
        const result = await Effect.runPromise(
          cua.command('run_command', {
            command:
              "xrandr --current 2>/dev/null | awk '/\\*/ {print $1; exit}' || echo 1024x768",
          }),
        );
        const stdout = cuaStdout(result).trim();
        const match = stdout.match(/(\d+)x(\d+)/);
        if (!match) return null;
        const width = parseInt(match[1], 10);
        const height = parseInt(match[2], 10);
        if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
        return { width, height };
      },
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => null));

    const findElementInAccessibilityTree = (
      queries: string[],
    ): Effect.Effect<LocatedElement | null> =>
      Effect.gen(function* () {
        if (queries.length === 0) return null;
        const snapshot = yield* getAccessibilitySnapshotSafe;
        if (!snapshot) return null;

        const screenSize =
          (yield* getScreenSizeSafe) || { width: 1024, height: 768 };

        return matchElementInSnapshot(snapshot, queries, screenSize);
      });

    const findElementCoordinates = (
      queries: string[],
    ): Effect.Effect<LocatedElement | null> =>
      Effect.gen(function* () {
        if (queries.length === 0) return null;

        const retryDelaysMs = [0, 500, 1200];
        for (const delay of retryDelaysMs) {
          if (delay > 0) {
            yield* sleep(delay);
          }

          for (const query of queries) {
            const found = yield* cua
              .commandWithFallback([
                { command: 'find_element', args: { title: query } },
                { command: 'find_element', args: { role: 'entry', title: query } },
              ])
              .pipe(Effect.catchAll(() => Effect.succeed(null)));

            const coords = extractCoordinates(found);
            if (coords) {
              return { coords, matchedQuery: query };
            }
          }
        }

        return yield* findElementInAccessibilityTree(queries);
      });

    const buildOpenUrlAttempts = (url: string) => {
      const quotedUrl = cua.shellSingleQuote(url);
      return [
        { command: 'open', args: { uri: url } },
        { command: 'open', args: { url } },
        { command: 'open_url', args: { url } },
        { command: 'navigate', args: { url } },
        { command: 'run_command', args: { cmd: `xdg-open ${quotedUrl}` } },
        { command: 'run_command', args: { command: `xdg-open ${quotedUrl}` } },
      ];
    };

    const processActionInternal = (
      sourceGroup: string,
      action: string,
      params: Record<string, unknown>,
    ): Effect.Effect<BrowseResult, BrowseError> =>
      Effect.gen(function* () {
        yield* sandbox.resetIdle;

        switch (action) {
          case 'navigate': {
            const url = String(params.url || '').trim();
            if (!url) {
              return { status: 'error', error: 'navigate requires a URL' };
            }

            let openedViaDirectCommand = false;
            const opened = yield* cua
              .commandWithFallback(buildOpenUrlAttempts(url))
              .pipe(Effect.either);
            if (opened._tag === 'Right') {
              openedViaDirectCommand = true;
            }

            if (!openedViaDirectCommand) {
              yield* cua.commandWithFallback([
                { command: 'press_key', args: { key: 'ctrl+l' } },
                { command: 'hotkey', args: { keys: 'ctrl+l' } },
              ]);
              yield* cua.commandWithFallback([
                { command: 'type', args: { text: url } },
                { command: 'type_text', args: { text: url } },
              ]);
              yield* cua.commandWithFallback([
                { command: 'press_key', args: { key: 'enter' } },
                { command: 'key', args: { key: 'enter' } },
              ]);
            }

            yield* sleep(openedViaDirectCommand ? 2200 : 1500);
            return { status: 'ok', result: `Navigated to ${url}` };
          }

          case 'snapshot': {
            const snapshot = yield* cua.command('get_accessibility_tree');
            return {
              status: 'ok',
              result:
                typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot),
            };
          }

          case 'click': {
            const selector = String(params.selector || '');
            const queries = buildElementSearchQueries(selector);
            const beforeSnapshot = yield* getAccessibilitySnapshotSafe;
            const located = yield* findElementCoordinates(queries);
            if (!located) {
              return {
                status: 'error',
                error: `CUA could not locate element for selector/description: ${selector}; attempted queries: ${formatAttemptedQueries(queries)}`,
              };
            }

            yield* cua.command('left_click', {
              x: located.coords.x,
              y: located.coords.y,
            });
            yield* sleep(250);

            const afterSnapshot = yield* getAccessibilitySnapshotSafe;
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

            const beforeSnapshot = yield* getAccessibilitySnapshotSafe;
            yield* cua.command('left_click', { x, y });
            yield* sleep(250);
            const afterSnapshot = yield* getAccessibilitySnapshotSafe;
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

            const beforeSnapshot = yield* getAccessibilitySnapshotSafe;
            yield* cua.command('left_click', { x, y });

            if (params.clear_first) {
              yield* cua.commandWithFallback([
                { command: 'press_key', args: { key: 'ctrl+a' } },
                { command: 'hotkey', args: { keys: 'ctrl+a' } },
              ]);
              yield* sleep(100);
            }

            yield* cua.commandWithFallback([
              { command: 'type', args: { text: value } },
              { command: 'type_text', args: { text: value } },
            ]);
            yield* sleep(250);

            const afterSnapshot = yield* getAccessibilitySnapshotSafe;
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

            const beforeSnapshot = yield* getAccessibilitySnapshotSafe;
            const located = yield* findElementCoordinates(queries);
            if (!located) {
              return {
                status: 'error',
                error: `CUA could not locate input for selector/description: ${selector}; attempted queries: ${formatAttemptedQueries(queries)}`,
              };
            }

            yield* cua.command('left_click', {
              x: located.coords.x,
              y: located.coords.y,
            });
            yield* cua.commandWithFallback([
              { command: 'type', args: { text: value } },
              { command: 'type_text', args: { text: value } },
            ]);
            yield* sleep(250);

            const afterSnapshot = yield* getAccessibilitySnapshotSafe;
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

            const beforeSnapshot = yield* getAccessibilitySnapshotSafe;
            const dirCommand: Record<string, string> = {
              up: 'scroll_up',
              down: 'scroll_down',
              left: 'scroll_left',
              right: 'scroll_right',
            };
            const cmd = dirCommand[direction] || 'scroll_down';
            yield* cua.commandWithFallback([
              { command: cmd, args: { clicks } },
              { command: 'scroll_direction', args: { direction, clicks } },
            ]);

            yield* sleep(250);
            const afterSnapshot = yield* getAccessibilitySnapshotSafe;
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
            const screenshotContent = yield* cua.command('screenshot');
            const base64 = extractBase64Image(screenshotContent);
            if (!base64) {
              return {
                status: 'error',
                error: 'CUA screenshot returned an unsupported payload format',
              };
            }

            const mediaDir = path.join(config.groupsDir, sourceGroup, 'media');
            fs.mkdirSync(mediaDir, { recursive: true });

            const filename = `screenshot-${Date.now()}.png`;
            const filePath = path.join(mediaDir, filename);
            const screenshotBytes = Buffer.from(base64, 'base64');

            const screenshotPath = `/workspace/group/media/${filename}`;
            const imageSize =
              getImageDimensionsFromBytes(screenshotBytes) ||
              (yield* getScreenSizeSafe) ||
              { width: 1024, height: 768 };

            const snapshot = yield* getAccessibilitySnapshotSafe;
            const analysis = buildScreenshotAnalysis(snapshot, imageSize, screenshotPath);

            const metadataFilename = filename.replace(/\.png$/, '.labels.json');
            const metadataPath = `/workspace/group/media/${metadataFilename}`;
            analysis.metadataPath = metadataPath;

            fs.writeFileSync(filePath, screenshotBytes);
            fs.writeFileSync(
              path.join(mediaDir, metadataFilename),
              JSON.stringify(analysis, null, 2),
            );

            if (typeof params.chatJid === 'string' && params.chatJid) {
              yield* telegram.sendPhoto(params.chatJid, filePath, 'Screenshot').pipe(
                Effect.ignore,
              );
            }

            return {
              status: 'ok',
              result: screenshotPath,
              analysis,
              screenshot: {
                path: screenshotPath,
                mimeType: 'image/png',
                base64,
                analysisSource: 'accessibility',
                metadataPath,
              },
            };
          }

          case 'go_back': {
            yield* cua.commandWithFallback([
              { command: 'press_key', args: { key: 'alt+left' } },
              { command: 'hotkey', args: { keys: 'alt+left' } },
            ]);
            return { status: 'ok', result: 'navigated back' };
          }

          case 'evaluate': {
            return {
              status: 'error',
              error:
                'browse_evaluate is not supported in CUA sandbox mode. Use browse_snapshot + follow-up actions instead.',
            };
          }

          case 'close': {
            yield* cua.commandWithFallback([
              { command: 'press_key', args: { key: 'ctrl+w' } },
              { command: 'hotkey', args: { keys: 'ctrl+w' } },
            ]);
            return { status: 'ok', result: 'closed' };
          }

          case 'perform': {
            const steps = params.steps as Array<Record<string, unknown>> | undefined;
            if (!Array.isArray(steps) || steps.length === 0) {
              return {
                status: 'error',
                error: 'perform requires a non-empty steps array',
              };
            }

            const blockedKeys = ['ctrl+alt+delete', 'ctrl+alt+backspace'];
            const results: string[] = [];
            const beforeSnapshot = yield* getAccessibilitySnapshotSafe;

            for (let i = 0; i < steps.length; i++) {
              const step = steps[i];
              const stepAction = String(step.action || '');

              try {
                switch (stepAction) {
                  case 'click':
                    yield* cua.command('left_click', {
                      x: Number(step.x),
                      y: Number(step.y),
                    });
                    results.push(`click(${step.x},${step.y})`);
                    break;
                  case 'double_click':
                    yield* cua.command('double_click', {
                      x: Number(step.x),
                      y: Number(step.y),
                    });
                    results.push(`double_click(${step.x},${step.y})`);
                    break;
                  case 'right_click':
                    yield* cua.command('right_click', {
                      x: Number(step.x),
                      y: Number(step.y),
                    });
                    results.push(`right_click(${step.x},${step.y})`);
                    break;
                  case 'key': {
                    const key = String(step.key || '').trim().toLowerCase();
                    if (!key) {
                      results.push('key() SKIPPED: empty key');
                      break;
                    }
                    if (blockedKeys.includes(key)) {
                      results.push(`key(${key}) BLOCKED`);
                      break;
                    }
                    yield* cua.commandWithFallback([
                      { command: 'press_key', args: { key } },
                      { command: 'hotkey', args: { keys: key } },
                    ]);
                    results.push(`key(${key})`);
                    break;
                  }
                  case 'type': {
                    const text = String(step.text || '');
                    yield* cua.commandWithFallback([
                      { command: 'type', args: { text } },
                      { command: 'type_text', args: { text } },
                    ]);
                    results.push(
                      `type("${text.length > 30 ? text.slice(0, 30) + '…' : text}")`,
                    );
                    break;
                  }
                  case 'scroll': {
                    const scrollClicks = Math.max(1, Math.round(Number(step.amount || 3)));
                    const dir = String(step.direction || 'down');
                    const scrollDirCommand: Record<string, string> = {
                      up: 'scroll_up',
                      down: 'scroll_down',
                      left: 'scroll_left',
                      right: 'scroll_right',
                    };
                    const scrollCmd = scrollDirCommand[dir] || 'scroll_down';
                    yield* cua.commandWithFallback([
                      { command: scrollCmd, args: { clicks: scrollClicks } },
                      {
                        command: 'scroll_direction',
                        args: { direction: dir, clicks: scrollClicks },
                      },
                    ]);
                    results.push(`scroll(${dir},${scrollClicks})`);
                    break;
                  }
                  case 'drag':
                    yield* cua.command('drag_to', {
                      x: Number(step.to_x),
                      y: Number(step.to_y),
                      start_x: Number(step.from_x),
                      start_y: Number(step.from_y),
                    });
                    results.push(`drag(${step.from_x},${step.from_y}->${step.to_x},${step.to_y})`);
                    break;
                  case 'hover':
                    yield* cua.command('move_cursor', {
                      x: Number(step.x),
                      y: Number(step.y),
                    });
                    results.push(`hover(${step.x},${step.y})`);
                    break;
                  case 'wait': {
                    const ms = Math.min(Math.max(Number(step.ms || 250), 0), 5000);
                    yield* sleep(ms);
                    results.push(`wait(${ms}ms)`);
                    break;
                  }
                  default:
                    results.push(`unknown(${stepAction})`);
                    break;
                }

                if (stepAction !== 'wait' && i < steps.length - 1) {
                  yield* sleep(100);
                }
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                results.push(`${stepAction} FAILED: ${message}`);
              }
            }

            yield* sleep(250);
            const afterSnapshot = yield* getAccessibilitySnapshotSafe;
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

            const maxFileSize = 100 * 1024 * 1024;

            let fileSize: number;
            try {
              const statResult = yield* cua.command('run_command', {
                command: `stat -c '%s' ${cua.shellSingleQuote(filePath)} 2>/dev/null || stat -f '%z' ${cua.shellSingleQuote(filePath)} 2>/dev/null`,
              });
              const sizeStr = cuaStdout(statResult).trim().replace(/'/g, '');
              fileSize = parseInt(sizeStr, 10);
              if (Number.isNaN(fileSize)) {
                return {
                  status: 'error',
                  error: `File not found or cannot stat: ${filePath}`,
                };
              }
            } catch (error) {
              return {
                status: 'error',
                error: `File not found: ${filePath} (${error instanceof Error ? error.message : String(error)})`,
              };
            }

            if (fileSize > maxFileSize) {
              return {
                status: 'error',
                error: `File too large: ${(fileSize / 1024 / 1024).toFixed(1)}MB exceeds 100MB limit`,
              };
            }

            let base64Content = '';
            try {
              const result = yield* cua.command('run_command', {
                command: `base64 -w0 ${cua.shellSingleQuote(filePath)} 2>/dev/null || base64 ${cua.shellSingleQuote(filePath)} 2>/dev/null | tr -d '\\n'`,
              });
              base64Content = cuaStdout(result).trim();
              if (!base64Content) {
                return {
                  status: 'error',
                  error: `Failed to read file contents: ${filePath}`,
                };
              }
            } catch (error) {
              return {
                status: 'error',
                error: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
              };
            }

            const originalFilename = path.basename(filePath);
            const mediaDir = path.join(config.groupsDir, sourceGroup, 'media');
            fs.mkdirSync(mediaDir, { recursive: true });

            const ext = path.extname(originalFilename);
            const stem = path.basename(originalFilename, ext);
            const destFilename = `${stem}-${Date.now()}${ext}`;
            const destPath = path.join(mediaDir, destFilename);

            const fileBuffer = Buffer.from(base64Content, 'base64');
            base64Content = '';
            fs.writeFileSync(destPath, fileBuffer);

            const containerPath = `/workspace/group/media/${destFilename}`;
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

            const filename = path.basename(sourcePath);
            let hostPath: string;
            if (sourcePath.startsWith('/workspace/group/')) {
              hostPath = path.join(
                config.groupsDir,
                sourceGroup,
                sourcePath.slice('/workspace/group/'.length),
              );
            } else if (sourcePath.startsWith('/workspace/global/')) {
              hostPath = path.join(
                config.groupsDir,
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

            const maxFileSize = 100 * 1024 * 1024;
            const fileStat = fs.statSync(hostPath);
            if (fileStat.size > maxFileSize) {
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

            const destDir = destPath.includes('/')
              ? destPath.substring(0, destPath.lastIndexOf('/'))
              : '~/Downloads';

            yield* cua.command('run_command', {
              command: `mkdir -p ${cua.shellSingleQuote(destDir)}`,
            }).pipe(Effect.catchAll(() => Effect.succeed(null)));

            const rawChunkSize = 48 * 1024;
            const fd = fs.openSync(hostPath, 'r');
            const chunkBuf = Buffer.alloc(rawChunkSize);
            let readOffset = 0;
            let chunkIndex = 0;

            try {
              while (true) {
                const bytesRead = fs.readSync(fd, chunkBuf, 0, rawChunkSize, readOffset);
                if (bytesRead === 0) break;

                const b64Chunk = chunkBuf.subarray(0, bytesRead).toString('base64');
                const redirect = chunkIndex === 0 ? '>' : '>>';

                const writeResult = yield* cua
                  .command('run_command', {
                    command: `printf '%s' ${cua.shellSingleQuote(b64Chunk)} | base64 -d ${redirect} ${cua.shellSingleQuote(destPath)}`,
                  })
                  .pipe(Effect.either);

                if (writeResult._tag === 'Left') {
                  return {
                    status: 'error',
                    error: `Failed to write file chunk ${chunkIndex + 1} to CUA: ${writeResult.left.message}`,
                  };
                }

                readOffset += bytesRead;
                chunkIndex++;
              }
            } finally {
              fs.closeSync(fd);
            }

            return {
              status: 'ok',
              result: `Uploaded ${filename} (${(fileStat.size / 1024).toFixed(1)}KB) to ${destPath}`,
            };
          }

          default:
            return { status: 'error', error: `Unknown action: ${action}` };
        }
      });

    const completePending = (
      pending: PendingWait,
      result: BrowseResult,
    ): void => {
      if (pending.timeoutTimer) {
        clearTimeout(pending.timeoutTimer);
        pending.timeoutTimer = null;
      }

      waiting.delete(pending.requestId);
      waitingByToken.delete(pending.token);
      pending.resolve(result);

      void Effect.runPromise(sandbox.rotateVncPassword.pipe(Effect.ignore));
    };

    yield* takeoverWeb.setWaitHandlers({
      getByToken: (token: string): PendingTakeoverRequest | null => {
        const requestId = waitingByToken.get(token);
        if (!requestId) return null;
        const pending = waiting.get(requestId);
        if (!pending) return null;

        return {
          requestId: pending.requestId,
          groupFolder: pending.groupFolder,
          token: pending.token,
          createdAt: pending.createdAt,
          message: pending.message,
          vncPassword: pending.vncPassword,
        };
      },
      resolveByToken: (token: string): boolean => {
        const requestId = waitingByToken.get(token);
        if (!requestId) return false;
        const pending = waiting.get(requestId);
        if (!pending) {
          waitingByToken.delete(token);
          return false;
        }
        completePending(pending, {
          status: 'ok',
          result: 'User continued',
        });
        return true;
      },
      touch: () => Effect.runPromise(sandbox.resetIdle),
    });

    const service: BrowseHostService = {
      processAction: (sourceGroup, action, params) =>
        processActionInternal(sourceGroup, action, params).pipe(
          Effect.catchAll((error) =>
            Effect.succeed({
              status: 'error',
              error: error instanceof BrowseError ? error.message : String(error),
            } satisfies BrowseResult),
          ),
        ),

      waitForUser: (requestId, groupFolder, message, chatJid) =>
        Effect.gen(function* () {
          const existing = waiting.get(requestId);
          if (existing) {
            return yield* Effect.async<BrowseResult, BrowseError | BrowseWaitTimeoutError>((resume) => {
              existing.resolve = (result) => resume(Effect.succeed(result));
            });
          }

          let token = createWaitToken();
          while (waitingByToken.has(token)) {
            token = createWaitToken();
          }

          const normalizedMessage = normalizeWaitMessage(message);
          const targetChatJid = chatJid || groupFolder;

          const ownerSession = yield* dashboardSession.createSessionForOwner(groupFolder);
          const takeoverUrl = yield* takeoverWeb.getTakeoverUrl(
            token,
            ownerSession?.token,
          );

          const pendingFiber = yield* Effect.fork(
            Effect.async<BrowseResult, BrowseError | BrowseWaitTimeoutError>(
              (resume) => {
                const entry: PendingWait = {
                  requestId,
                  groupFolder,
                  token,
                  createdAt: new Date().toISOString(),
                  message: normalizedMessage,
                  vncPassword: null,
                  resolve: (result) => resume(Effect.succeed(result)),
                  timeoutTimer: null,
                };

                entry.timeoutTimer = setTimeout(() => {
                  waiting.delete(requestId);
                  waitingByToken.delete(token);
                  resume(
                    Effect.fail(
                      new BrowseWaitTimeoutError({
                        requestId,
                        groupFolder,
                      }),
                    ),
                  );
                }, WAIT_FOR_USER_TIMEOUT_MS);

                waiting.set(requestId, entry);
                waitingByToken.set(token, requestId);
              },
            ),
          );

          const vncPassword = yield* sandbox.rotateVncPassword.pipe(
            Effect.orElseSucceed(() => null),
          );
          const stored = waiting.get(requestId);
          if (stored) {
            stored.vncPassword = vncPassword;
          }

          const takeoverLine = takeoverUrl
            ? `Take over CUA: ${takeoverUrl}`
            : 'Takeover URL unavailable (takeover web UI may be disabled).';
          const userMessage = [
            normalizedMessage || 'Please take over the CUA browser session, then return control when done.',
            '',
            takeoverLine,
            `Request ID: ${requestId}`,
            '',
            `When done, click "Return Control To Agent" in takeover page.`,
            `Fallback: reply "continue ${requestId}".`,
          ].join('\n');

          yield* telegram.sendMessage(targetChatJid, userMessage).pipe(Effect.ignore);

          const result = yield* Effect.fromFiber(pendingFiber);

          if (result.status === 'ok') {
            const screenshotResult = yield* processActionInternal(groupFolder, 'screenshot', {}).pipe(
              Effect.timeoutFail({
                duration: `${WAIT_FOR_USER_POST_CONTINUE_SCREENSHOT_TIMEOUT_MS} millis`,
                onTimeout: () =>
                  new Error(
                    `Post-continue screenshot timed out after ${WAIT_FOR_USER_POST_CONTINUE_SCREENSHOT_TIMEOUT_MS}ms`,
                  ),
              }),
              Effect.catchAllCause(() => Effect.succeed(null)),
            );
            if (screenshotResult && screenshotResult.status === 'ok' && screenshotResult.analysis) {
              return {
                status: 'ok',
                result: `User has returned control.\n\n${screenshotResult.analysis.summary}`,
                analysis: screenshotResult.analysis,
                screenshot: screenshotResult.screenshot,
              };
            }
          }

          return result;
        }),

      resolveWait: (groupFolder, requestId) =>
        Effect.sync(() => {
          if (requestId) {
            const pending = waiting.get(requestId);
            if (!pending || pending.groupFolder !== groupFolder) return false;
            completePending(pending, {
              status: 'ok',
              result: 'User continued',
            });
            return true;
          }

          for (const pending of waiting.values()) {
            if (pending.groupFolder !== groupFolder) continue;
            completePending(pending, {
              status: 'ok',
              result: 'User continued',
            });
            return true;
          }

          return false;
        }),

      resolveWaitByToken: (token: string) =>
        Effect.sync(() => {
          const requestId = waitingByToken.get(token);
          if (!requestId) return false;
          const pending = waiting.get(requestId);
          if (!pending) {
            waitingByToken.delete(token);
            return false;
          }
          completePending(pending, {
            status: 'ok',
            result: 'User continued',
          });
          return true;
        }),

      getWaitByToken: (token: string) =>
        Effect.sync(() => {
          const requestId = waitingByToken.get(token);
          if (!requestId) return null;
          const pending = waiting.get(requestId);
          if (!pending) return null;
          return {
            requestId: pending.requestId,
            groupFolder: pending.groupFolder,
            token: pending.token,
            createdAt: pending.createdAt,
            message: pending.message,
            vncPassword: pending.vncPassword,
          };
        }),

      cancelWaiting: (groupFolder, reason) =>
        Effect.sync(() => {
          let count = 0;
          const errorMessage = reason || 'Cancelled by user interrupt';

          for (const pending of [...waiting.values()]) {
            if (pending.groupFolder !== groupFolder) continue;
            completePending(pending, {
              status: 'error',
              error: errorMessage,
            });
            count++;
          }

          return count;
        }),

      hasWaitingRequests: (groupFolder) =>
        Effect.sync(() => {
          for (const pending of waiting.values()) {
            if (pending.groupFolder === groupFolder) return true;
          }
          return false;
        }),
    };

    return service;
  }),
);
