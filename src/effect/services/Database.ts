/**
 * Effect service: Database
 *
 * Wraps bun:sqlite operations from db.ts into an Effect service.
 * Provides scoped resource management for the database connection.
 */
import { Context, Effect, Layer } from 'effect';

import {
  initDatabase,
  getConversationHistory,
  getNewMessages,
  storeAssistantMessage,
  getAllChats,
  getAllTasks,
  getDueTasks,
  getTaskById,
  logTaskRun,
  updateTaskAfterRun,
  getActiveModelOverride,
} from '../../db.js';
import type { NewMessage, ScheduledTask, TaskRunLog } from '../../types.js';

export interface DatabaseService {
  readonly init: () => Effect.Effect<void>;
  readonly getConversationHistory: (
    chatJid: string,
    limit: number,
  ) => { role: string; sender_name: string; content: string; timestamp: string; media_type?: string; media_path?: string }[];
  readonly getNewMessages: (
    jids: string[],
    lastTimestamp: string,
    botPrefix: string,
  ) => { messages: NewMessage[]; newTimestamp: string };
  readonly storeAssistantMessage: (
    chatJid: string,
    content: string,
    timestamp: string,
    senderName: string,
  ) => void;
  readonly getAllChats: () => { jid: string; name: string; last_message_time: string }[];
  readonly getAllTasks: () => ScheduledTask[];
  readonly getDueTasks: () => ScheduledTask[];
  readonly getTaskById: (id: string) => ScheduledTask | undefined;
  readonly logTaskRun: (log: TaskRunLog) => void;
  readonly updateTaskAfterRun: (taskId: string, nextRun: string | null, resultSummary: string) => void;
  readonly getActiveModelOverride: (chatJid: string) => { model: string; label: string } | null;
}

export class Database extends Context.Tag('nanoclaw/Database')<
  Database,
  DatabaseService
>() {}

export const DatabaseLive = Layer.scoped(
  Database,
  Effect.acquireRelease(
    Effect.sync(() => {
      initDatabase();
      return {
        init: () => Effect.sync(() => {}),
        getConversationHistory,
        getNewMessages,
        storeAssistantMessage,
        getAllChats,
        getAllTasks,
        getDueTasks,
        getTaskById,
        logTaskRun,
        updateTaskAfterRun,
        getActiveModelOverride,
      } satisfies DatabaseService;
    }),
    () =>
      Effect.sync(() => {
        // Database cleanup on scope close (bun:sqlite auto-closes on GC)
      }),
  ),
);
