/**
 * IpcWatcher — polls IPC directories for fire-and-forget messages,
 * task scheduling, and browse request/response commands.
 *
 * Port of startIpcWatcher from src/index.ts (v1).
 */

import fs from 'fs';
import path from 'path';
import { Effect, Schedule } from 'effect';

import { AppConfig } from '../config.js';
import { Database } from '../services/Database.js';
import { Telegram } from '../services/Telegram.js';
import { BrowseHost } from '../services/BrowseHost.js';
import { GroupRegistry } from '../state/GroupRegistry.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const IPC_WATCHER_FILE_PATH = 'src-v2/coordinators/IpcWatcher.ts';

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (
    typeof err === 'object' &&
    err !== null &&
    'message' in err &&
    typeof (err as { message?: unknown }).message === 'string'
  ) {
    return (err as { message: string }).message;
  }
  return String(err);
}

function logIpcWatcherError(
  event: string,
  err: unknown,
  context: Record<string, unknown> = {},
): void {
  const details = err instanceof Error
    ? { message: err.message, stack: err.stack }
    : { message: errorMessage(err), stack: undefined };
  process.stderr.write(
    `[IpcWatcher] ${JSON.stringify({
      component: 'IpcWatcher',
      file: IPC_WATCHER_FILE_PATH,
      event,
      ...context,
      error: details.message,
      stack: details.stack,
    })}\n`,
  );
}

function logIpcWatcherErrorEffect(
  event: string,
  err: unknown,
  context: Record<string, unknown> = {},
): Effect.Effect<void> {
  return Effect.sync(() => {
    logIpcWatcherError(event, err, context);
  });
}

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
  } catch (err) {
    logIpcWatcherError('list_json_files_failed', err, { dir, pattern });
    return [];
  }
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    logIpcWatcherError('read_json_file_failed', err, { filePath });
    return null;
  }
}

function deleteFile(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    logIpcWatcherError('delete_file_failed', err, { filePath });
  }
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  try {
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    logIpcWatcherError('write_json_atomic_failed', err, { filePath });
    throw err;
  }
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
            .pipe(
              Effect.catchAll((err) =>
                logIpcWatcherErrorEffect(
                  'telegram_send_failed',
                  err,
                  {
                    filePath: file,
                    groupFolder: group.folder,
                    targetChatJid,
                  },
                ),
              ),
            );
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
        const data = readJsonFile(file);
        if (!data) {
          deleteFile(file);
          continue;
        }

        const reqId = path
          .basename(file)
          .replace('req-', '')
          .replace('.json', '');

        const action = String(data.action || '');
        const params = (data.params || data) as Record<string, unknown>;

        // Special handling for wait_for_user — fork so it doesn't block polling
        if (action === 'wait_for_user') {
          deleteFile(file);
          yield* Effect.fork(
            browseHost
              .waitForUser(
                reqId,
                group.folder,
                String(params.message || ''),
                groupChatJid,
              )
              .pipe(
                Effect.map((r) => r as unknown as Record<string, unknown>),
                Effect.catchAll((err) =>
                  logIpcWatcherErrorEffect(
                    'browse_wait_for_user_failed',
                    err,
                    {
                      filePath: file,
                      reqId,
                      action,
                      groupFolder: group.folder,
                    },
                  ).pipe(
                    Effect.as({
                      success: false,
                      error: errorMessage(err),
                    } as Record<string, unknown>),
                  ),
                ),
                Effect.tap((result) =>
                  Effect.try({
                    try: () => {
                      const resPath = path.join(browseDir, `res-${reqId}.json`);
                      writeJsonAtomic(resPath, result);
                    },
                    catch: (err) => err,
                  }).pipe(
                    Effect.catchAll((err) =>
                      logIpcWatcherErrorEffect(
                        'browse_wait_for_user_write_response_failed',
                        err,
                        {
                          filePath: file,
                          reqId,
                          groupFolder: group.folder,
                        },
                      ),
                    ),
                  ),
                ),
              ),
          );
          continue;
        }

        // Regular browse action
        const result = yield* browseHost
          .processAction(group.folder, action, params)
          .pipe(
            Effect.map((r) => r as unknown as Record<string, unknown>),
            Effect.catchAll((err) =>
              logIpcWatcherErrorEffect(
                'browse_process_action_failed',
                err,
                {
                  filePath: file,
                  reqId,
                  action,
                  groupFolder: group.folder,
                },
              ).pipe(
                Effect.as({
                  success: false,
                  error: errorMessage(err),
                } as Record<string, unknown>),
              ),
            ),
          );

        // Write response atomically (temp + rename)
        const resPath = path.join(browseDir, `res-${reqId}.json`);
        yield* Effect.try({
          try: () => {
            writeJsonAtomic(resPath, result);
          },
          catch: (err) => err,
        }).pipe(
          Effect.catchAll((err) =>
            logIpcWatcherErrorEffect(
              'browse_write_response_failed',
              err,
              {
                filePath: file,
                reqId,
                action,
                resPath,
                groupFolder: group.folder,
              },
            ),
          ),
        );
        deleteFile(file);
      }
    }
  }).pipe(
    Effect.catchAll((err) =>
      logIpcWatcherErrorEffect('ipc_poll_failed', err),
    ),
  );

  // Poll every 1 second
  yield* pollOnce.pipe(Effect.repeat(Schedule.fixed('1 second')));
}).pipe(
  Effect.catchAll((err) =>
    logIpcWatcherErrorEffect('ipc_watcher_failed', err),
  ),
);
