/**
 * BrowseHostLive — bridges container browse requests to CUA sandbox.
 *
 * Port of src/browse-host.ts (v1).
 * Simplified: delegates CUA command execution to Sandbox service.
 */

import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { Effect, Layer, Ref } from 'effect';

import { AppConfig } from '../config.js';
import { Sandbox } from './Sandbox.js';
import { Telegram } from './Telegram.js';
import { BrowseError, BrowseWaitTimeoutError } from '../errors.js';
import { BrowseHost } from './BrowseHost.js';
import type { BrowseHostService, BrowseResult } from './BrowseHost.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const WAIT_FOR_USER_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// ─── Types ──────────────────────────────────────────────────────────────────

interface PendingWait {
  requestId: string;
  groupFolder: string;
  token: string;
  createdAt: string;
  message: string | null;
  resolve: (result: BrowseResult) => void;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function createWaitToken(): string {
  return randomBytes(18).toString('base64url');
}

function getTailscaleIp(): string {
  try {
    const { execSync } = require('child_process');
    return execSync('tailscale ip -4', { stdio: 'pipe' })
      .toString()
      .trim();
  } catch {
    return '127.0.0.1';
  }
}

// ─── Live Layer ─────────────────────────────────────────────────────────────

export const BrowseHostLive: Layer.Layer<
  BrowseHost,
  never,
  Sandbox | Telegram | AppConfig
> = Layer.effect(
  BrowseHost,
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;
    const telegram = yield* Telegram;
    const config = yield* AppConfig;

    // Pending wait-for-user requests
    const waitingRef = yield* Ref.make<Map<string, PendingWait>>(new Map());
    const tokenMapRef = yield* Ref.make<Map<string, string>>(new Map());

    // Helper: execute a CUA command via sandbox
    const cuaCommand = (
      command: string,
      args: Record<string, unknown> = {},
    ) =>
      Effect.gen(function* () {
        const conn = yield* sandbox.ensure;
        yield* sandbox.resetIdle;

        return yield* Effect.tryPromise({
          try: async () => {
            const res = await fetch(conn.commandUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ command, ...args }),
            });
            if (!res.ok) {
              const body = await res.text();
              throw new Error(`CUA ${command} HTTP ${res.status}: ${body.slice(0, 500)}`);
            }
            return (await res.json()) as unknown;
          },
          catch: (err) =>
            new BrowseError({
              message: `CUA command failed: ${err instanceof Error ? err.message : String(err)}`,
              action: command,
              cause: err,
            }),
        });
      });

    const service: BrowseHostService = {
      processAction: (sourceGroup, action, params) =>
        Effect.gen(function* () {
          yield* sandbox.resetIdle;

          switch (action) {
            case 'navigate': {
              const url = String(params.url || '').trim();
              if (!url) {
                return {
                  success: false,
                  error: 'navigate requires a URL',
                };
              }
              yield* cuaCommand('open', { url });
              yield* Effect.sleep('2 seconds');
              return { success: true, data: `Navigated to ${url}` };
            }

            case 'snapshot': {
              const result = yield* cuaCommand('get_accessibility_tree');
              return {
                success: true,
                data:
                  typeof result === 'string'
                    ? result
                    : JSON.stringify(result),
              };
            }

            case 'click': {
              const selector = String(params.selector || '');
              // Simplified: try coordinate click via find_element
              const result = yield* cuaCommand('find_element', {
                title: selector,
              }).pipe(
                Effect.catchAll(() => Effect.succeed(null)),
              );

              if (
                result &&
                typeof result === 'object' &&
                'x' in (result as Record<string, unknown>)
              ) {
                const r = result as Record<string, unknown>;
                yield* cuaCommand('left_click', {
                  x: r.x || r.center_x,
                  y: r.y || r.center_y,
                });
                return { success: true, data: 'clicked' };
              }

              return {
                success: false,
                error: `Element not found: ${selector}`,
              };
            }

            case 'click_xy': {
              const x = Number(params.x);
              const y = Number(params.y);
              yield* cuaCommand('left_click', { x, y });
              return { success: true, data: `clicked (${x}, ${y})` };
            }

            case 'screenshot': {
              const result = yield* cuaCommand('screenshot');
              // Save screenshot to group media
              const base64 = extractBase64(result);
              if (base64) {
                const mediaDir = path.join(
                  config.groupsDir,
                  sourceGroup,
                  'media',
                );
                fs.mkdirSync(mediaDir, { recursive: true });
                const filename = `screenshot-${Date.now()}.png`;
                const filePath = path.join(mediaDir, filename);
                fs.writeFileSync(
                  filePath,
                  Buffer.from(base64, 'base64'),
                );
                const containerPath = `/workspace/group/media/${filename}`;

                // Send screenshot to Telegram
                const chatJid = String(params.chatJid || '');
                if (chatJid) {
                  yield* telegram
                    .sendPhoto(chatJid, filePath, 'Screenshot')
                    .pipe(Effect.ignore);
                }

                return { success: true, data: containerPath };
              }
              return {
                success: false,
                error: 'Screenshot format not supported',
              };
            }

            case 'fill': {
              const selector = String(params.selector || '');
              const value = String(params.value || '');
              // Find element, click, type
              const el = yield* cuaCommand('find_element', {
                title: selector,
              }).pipe(Effect.catchAll(() => Effect.succeed(null)));

              if (
                el &&
                typeof el === 'object' &&
                'x' in (el as Record<string, unknown>)
              ) {
                const r = el as Record<string, unknown>;
                yield* cuaCommand('left_click', {
                  x: r.x || r.center_x,
                  y: r.y || r.center_y,
                });
                yield* cuaCommand('type', { text: value });
                return { success: true, data: 'filled' };
              }
              return {
                success: false,
                error: `Input not found: ${selector}`,
              };
            }

            case 'go_back': {
              yield* cuaCommand('press_key', { key: 'alt+left' });
              return { success: true, data: 'navigated back' };
            }

            case 'close': {
              yield* cuaCommand('press_key', { key: 'ctrl+w' });
              return { success: true, data: 'closed' };
            }

            case 'perform': {
              const steps = params.steps as
                | Array<Record<string, unknown>>
                | undefined;
              if (!Array.isArray(steps) || steps.length === 0) {
                return {
                  success: false,
                  error: 'perform requires a non-empty steps array',
                };
              }
              for (const step of steps) {
                const stepAction = String(step.action || '');
                switch (stepAction) {
                  case 'click':
                    yield* cuaCommand('left_click', {
                      x: Number(step.x),
                      y: Number(step.y),
                    });
                    break;
                  case 'double_click':
                    yield* cuaCommand('double_click', {
                      x: Number(step.x),
                      y: Number(step.y),
                    });
                    break;
                  case 'key':
                    yield* cuaCommand('press_key', { key: step.key });
                    break;
                  case 'type':
                    yield* cuaCommand('type', { text: step.text });
                    break;
                  case 'wait':
                    yield* Effect.sleep(
                      `${Math.min(Number(step.ms || 250), 5000)} millis`,
                    );
                    break;
                  case 'scroll':
                    yield* cuaCommand(
                      `scroll_${step.direction || 'down'}`,
                      { clicks: Number(step.amount || 3) },
                    );
                    break;
                }
                // Small delay between steps
                if (stepAction !== 'wait') {
                  yield* Effect.sleep('100 millis');
                }
              }
              return {
                success: true,
                data: `performed ${steps.length} steps`,
              };
            }

            default:
              return {
                success: false,
                error: `Unknown action: ${action}`,
              };
          }
        }).pipe(
          Effect.catchAll((err) =>
            Effect.succeed({
              success: false,
              error: err instanceof BrowseError
                ? err.message
                : String(err),
            } satisfies BrowseResult),
          ),
        ),

      waitForUser: (requestId, groupFolder, message, chatJid) =>
        Effect.gen(function* () {
          const token = createWaitToken();
          const targetChatJid = chatJid || groupFolder;

          // Register token mapping
          yield* Ref.update(tokenMapRef, (m) => {
            const next = new Map(m);
            next.set(token, requestId);
            return next;
          });

          // Rotate VNC password for this session (async-safe here)
          yield* sandbox.rotateVncPassword.pipe(Effect.ignore);

          // Build takeover URL and send to chat
          const host = config.sandboxTailscaleEnabled
            ? getTailscaleIp()
            : '127.0.0.1';
          const takeoverUrl = `http://${host}:${config.cuaTakeoverWebPort}/cua/takeover/${token}`;

          yield* telegram
            .sendMessage(
              targetChatJid,
              `Take control: ${takeoverUrl}${message ? `\n${message}` : ''}`,
            )
            .pipe(Effect.ignore);

          // Now block until user returns control (or timeout)
          const result = yield* Effect.async<BrowseResult, BrowseError | BrowseWaitTimeoutError>(
            (resume) => {
              const pending: PendingWait = {
                requestId,
                groupFolder,
                token,
                createdAt: new Date().toISOString(),
                message: message || null,
                resolve: (r) => resume(Effect.succeed(r)),
                timeoutTimer: null,
              };

              // Timeout
              pending.timeoutTimer = setTimeout(() => {
                Ref.update(waitingRef, (m) => {
                  m.delete(requestId);
                  return new Map(m);
                }).pipe(Effect.runSync);
                Ref.update(tokenMapRef, (m) => {
                  m.delete(token);
                  return new Map(m);
                }).pipe(Effect.runSync);
                resume(
                  Effect.fail(
                    new BrowseWaitTimeoutError({ requestId, groupFolder }),
                  ),
                );
              }, WAIT_FOR_USER_TIMEOUT_MS);

              // Register the pending entry with resolve callback
              Ref.update(waitingRef, (m) => {
                m.set(requestId, pending);
                return new Map(m);
              }).pipe(Effect.runSync);
            },
          );

          return result;
        }),

      resolveWait: (groupFolder, requestId) =>
        Effect.gen(function* () {
          const waiting = yield* Ref.get(waitingRef);

          if (requestId) {
            const pending = waiting.get(requestId);
            if (!pending || pending.groupFolder !== groupFolder) return false;
            completePending(pending, { success: true, data: 'User continued' });
            yield* Ref.update(waitingRef, (m) => {
              m.delete(requestId);
              return new Map(m);
            });
            yield* Ref.update(tokenMapRef, (m) => {
              m.delete(pending.token);
              return new Map(m);
            });
            return true;
          }

          // Resolve oldest for this group
          for (const pending of waiting.values()) {
            if (pending.groupFolder !== groupFolder) continue;
            completePending(pending, { success: true, data: 'User continued' });
            yield* Ref.update(waitingRef, (m) => {
              m.delete(pending.requestId);
              return new Map(m);
            });
            yield* Ref.update(tokenMapRef, (m) => {
              m.delete(pending.token);
              return new Map(m);
            });
            return true;
          }
          return false;
        }),

      cancelWaiting: (groupFolder, reason) =>
        Effect.gen(function* () {
          const waiting = yield* Ref.get(waitingRef);
          let count = 0;
          const errorMsg = reason || 'Cancelled by user interrupt';

          for (const pending of [...waiting.values()]) {
            if (pending.groupFolder !== groupFolder) continue;
            completePending(pending, {
              success: false,
              error: errorMsg,
            });
            yield* Ref.update(waitingRef, (m) => {
              m.delete(pending.requestId);
              return new Map(m);
            });
            yield* Ref.update(tokenMapRef, (m) => {
              m.delete(pending.token);
              return new Map(m);
            });
            count++;
          }
          return count;
        }),

      hasWaitingRequests: (groupFolder) =>
        Ref.get(waitingRef).pipe(
          Effect.map((m) => {
            for (const pending of m.values()) {
              if (pending.groupFolder === groupFolder) return true;
            }
            return false;
          }),
        ),
    };

    return service;
  }),
);

// ─── Utilities ──────────────────────────────────────────────────────────────

function completePending(pending: PendingWait, result: BrowseResult): void {
  if (pending.timeoutTimer) {
    clearTimeout(pending.timeoutTimer);
    pending.timeoutTimer = null;
  }
  pending.resolve(result);
}

function extractBase64(input: unknown): string | null {
  if (typeof input === 'string') {
    const match = input.match(/^data:image\/[^;]+;base64,(.+)$/s);
    if (match) return match[1];
    // Could be raw base64
    if (input.length > 256 && /^[A-Za-z0-9+/=]+$/.test(input)) {
      return input;
    }
  }
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    for (const key of ['screenshot', 'image', 'content', 'data', 'base64', 'result']) {
      if (record[key]) {
        const extracted = extractBase64(record[key]);
        if (extracted) return extracted;
      }
    }
  }
  return null;
}
