/**
 * Shared utilities for tool handlers.
 */

import { Effect } from 'effect';
import fs from 'fs';
import path from 'path';
import { ToolError } from '../errors/index.js';

// ─── IPC Constants ──────────────────────────────────────────────────────────

export const IPC_DIR = '/workspace/ipc';
export const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
export const TASKS_DIR = path.join(IPC_DIR, 'tasks');
export const BROWSE_DIR = path.join(IPC_DIR, 'browse');

export const SUPERMEMORY_KEY_ENV_VARS = [
  'SUPERMEMORY_API_KEY',
  'SUPERMEMORY_OPENCLAW_API_KEY',
  'SUPERMEMORY_CC_API_KEY',
] as const;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Spawn a command with Bun.spawn(), capture stdout/stderr, respect timeout. */
export function runCommand(
  cmd: string[],
  timeoutMs = 120000,
): Effect.Effect<{ stdout: string; stderr: string; exitCode: number }, ToolError> {
  return Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(cmd, {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: timeoutMs,
      });

      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      return { stdout, stderr, exitCode: exitCode ?? 1 };
    },
    catch: (err) =>
      new ToolError({
        toolName: 'runCommand',
        message: `Command failed: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      }),
  });
}

/** Atomic JSON file write (temp + rename) to IPC directory. Returns filename. */
export function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

/** Resolve Supermemory API key from environment variables. */
export function resolveSupermemoryApiKey(): {
  key: string;
  envVar: (typeof SUPERMEMORY_KEY_ENV_VARS)[number];
} | null {
  for (const envVar of SUPERMEMORY_KEY_ENV_VARS) {
    const raw = process.env[envVar];
    if (typeof raw !== 'string') continue;
    const key = raw.trim();
    if (!key) continue;
    return { key, envVar };
  }
  return null;
}

// ─── RPC Helper ─────────────────────────────────────────────────────────────

import type { HostBridgeService } from '../services/HostBridge.js';
import { HostBridge } from '../services/HostBridge.js';

/**
 * Request the host via HostBridge, mapping RpcError to ToolError.
 * Returns null if RPC is unavailable (caller should fall back to file IPC).
 */
export function requestHost(
  method: string,
  params?: unknown,
): Effect.Effect<unknown, ToolError, HostBridge> {
  return Effect.gen(function* () {
    const bridge = yield* HostBridge;
    return yield* bridge.request(method, params).pipe(
      Effect.mapError(
        (rpcErr) =>
          new ToolError({
            toolName: method,
            message: rpcErr.message,
            cause: rpcErr,
          }),
      ),
    );
  });
}

// ─── Browse IPC Types ───────────────────────────────────────────────────────

export type HostBrowseResult = {
  status: string;
  result?: unknown;
  error?: string;
  analysis?: { summary?: string; metadataPath?: string };
  screenshot?: {
    path?: string;
    mimeType?: string;
    base64?: string;
    analysisSource?: 'omniparser' | 'accessibility';
    metadataPath?: string;
  };
};
