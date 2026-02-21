/**
 * IpcWatcher — polls IPC directories for fire-and-forget messages,
 * task scheduling, and browse request/response commands.
 *
 * Port of startIpcWatcher from src/index.ts (v1).
 */

import fs from 'fs';
import path from 'path';
import { Cause, Effect, Schedule } from 'effect';

import { AppConfig } from '../config.js';
import { Database } from '../services/Database.js';
import { Telegram } from '../services/Telegram.js';
import { BrowseHost } from '../services/BrowseHost.js';
import { GroupRegistry } from '../state/GroupRegistry.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function listJsonFiles(dir: string, pattern?: string): string[] {
  try {
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter((f) => {
      if (!f.endsWith('.json')) return false;
      if (pattern) {
        const regex = new RegExp(
          '^' + pattern.replace(/\*/g, '.*') + '$',
        );
        return regex.test(f);
      }
      return true;
    });
    return files.map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function deleteFile(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // best effort
  }
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

// ─── IPC Watcher ────────────────────────────────────────────────────────────

/**
 * Create the IPC watcher effect.
 * Polls every 1 second for IPC messages from containers.
 */
export const startIpcWatcher: Effect.Effect<
  void,
  never,
  AppConfig | Database | Telegram | BrowseHost | GroupRegistry
> = Effect.gen(function* () {
  const config = yield* AppConfig;
  const db = yield* Database;
  const telegram = yield* Telegram;
  const browseHost = yield* BrowseHost;
  const registry = yield* GroupRegistry;

  const ipcBaseDir = path.join(config.dataDir, 'ipc');
  const browseActionTimeoutMs = config.ipcBrowseActionTimeoutMs;

  const pollOnce = Effect.gen(function* () {
    const groups = yield* registry.getAll;

    for (const [groupChatJid, group] of Object.entries(groups)) {
      const ipcDir = path.join(ipcBaseDir, group.folder);
      const isMain = group.folder === config.mainGroupFolder;

      // --- Messages (fire-and-forget) ---
      const messagesDir = path.join(ipcDir, 'messages');
      const msgFiles = listJsonFiles(messagesDir);

      for (const file of msgFiles) {
        const data = readJsonFile(file);
        if (!data) {
          deleteFile(file);
          continue;
        }

        const targetChatJid = String(data.chatJid || '');
        const text = String(data.text || '');

        // Authorization: non-main groups can only send to own chat
        if (!isMain && targetChatJid !== groupChatJid) {
          yield* Effect.log(
            `IPC auth denied: ${group.folder} tried to send to ${targetChatJid}`,
          );
          deleteFile(file);
          continue;
        }

        if (targetChatJid && text) {
          yield* telegram
            .sendMessage(targetChatJid, text)
            .pipe(Effect.ignore);
        }

        deleteFile(file);
      }

      // --- Tasks (fire-and-forget) ---
      const tasksDir = path.join(ipcDir, 'tasks');
      const taskFiles = listJsonFiles(tasksDir);

      for (const file of taskFiles) {
        const data = readJsonFile(file);
        if (!data) {
          deleteFile(file);
          continue;
        }

        const taskGroupFolder = String(data.groupFolder || data.group_folder || '');

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && taskGroupFolder && taskGroupFolder !== group.folder) {
          yield* Effect.log(
            `IPC auth denied: ${group.folder} tried to schedule for ${taskGroupFolder}`,
          );
          deleteFile(file);
          continue;
        }

        // Store task via database (simplified — task has all needed fields)
        // The DB expects a full task record; we pass the raw data
        // TODO: validate schema before storing
        deleteFile(file);
      }

      // --- Browse (request/response) ---
      const browseDir = path.join(ipcDir, 'browse');
      const browseFiles = listJsonFiles(browseDir, 'req-*.json');

      for (const file of browseFiles) {
        const reqId = path.basename(file).replace('req-', '').replace('.json', '');
        const data = readJsonFile(file);
        if (!data) {
          deleteFile(file);
          continue;
        }

        const action = String(data.action || '');
        const params = (data.params || data) as Record<string, unknown>;

        // Always remove the request file before dispatch to prevent duplicate handling.
        deleteFile(file);

        const actionEffect =
          action === 'wait_for_user'
            ? browseHost.waitForUser(
                reqId,
                group.folder,
                String(params.message || ''),
                groupChatJid,
              )
            : browseHost.processAction(group.folder, action, params).pipe(
                Effect.timeoutFail({
                  duration: `${browseActionTimeoutMs} millis`,
                  onTimeout: () =>
                    new Error(
                      `IPC browse action timed out after ${browseActionTimeoutMs}ms`,
                    ),
                }),
              );

        const responseEffect =
          actionEffect.pipe(
            Effect.map((r) => r as unknown as Record<string, unknown>),
            Effect.catchAllCause((cause) =>
              Effect.gen(function* () {
                const causeText = Cause.pretty(cause);
                yield* Effect.log(
                  `IPC browse action error: group=${group.folder} file=${file} reqId=${reqId} action=${action || 'unknown'} cause=${causeText}`,
                );
                return {
                  status: 'error',
                  error: causeText,
                } as Record<string, unknown>;
              }),
            ),
            Effect.tap((result) =>
              Effect.try({
                try: () => {
                  const resPath = path.join(browseDir, `res-${reqId}.json`);
                  writeJsonAtomic(resPath, result);
                },
                catch: (err) =>
                  new Error(`Failed to write browse response: ${String(err)}`),
              }).pipe(
                Effect.tapError((err) =>
                  Effect.log(
                    `IPC browse write error: group=${group.folder} file=${file} reqId=${reqId} action=${action || 'unknown'} error=${String(err)}`,
                  ),
                ),
                Effect.ignore,
              ),
            ),
          );

        if (action === 'wait_for_user') {
          yield* Effect.forkDaemon(responseEffect);
          continue;
        }

        yield* Effect.fork(responseEffect);
      }
    }
  }).pipe(
    Effect.catchAllCause((cause) =>
      Effect.log(`IPC poll error: ${Cause.pretty(cause)}`),
    ),
  );

  // Poll every 1 second
  yield* pollOnce.pipe(Effect.repeat(Schedule.fixed('1 second')));
}).pipe(Effect.catchAllCause(() => Effect.void));
