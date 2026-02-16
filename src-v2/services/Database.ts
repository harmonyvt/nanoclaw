/**
 * Database service — wraps bun:sqlite as an Effect Service.
 */

import { Context, Effect } from 'effect';
import type {
  DatabaseError,
  DatabaseConnectionError,
  DatabaseMigrationError,
} from '../errors.js';
import type { ScheduledTask, TaskRunLog } from '../schemas/Tasks.js';

// ─── Row Types ─────────────────────────────────────────────────────────────

export interface MessageRow {
  readonly id: string;
  readonly chat_jid: string;
  readonly sender: string;
  readonly sender_name: string;
  readonly content: string;
  readonly timestamp: string;
  readonly is_from_me: boolean;
  readonly media_type?: string;
  readonly media_path?: string;
}

export interface ChatRow {
  readonly chat_jid: string;
  readonly last_activity: string;
}

export interface NewMessage {
  readonly id: string;
  readonly chat_jid: string;
  readonly sender: string;
  readonly sender_name: string;
  readonly content: string;
  readonly timestamp: string;
  readonly media_type?: string;
  readonly media_path?: string;
}

// ─── Service Interface ─────────────────────────────────────────────────────

export interface DatabaseService {
  readonly initDatabase: Effect.Effect<
    void,
    DatabaseConnectionError | DatabaseMigrationError
  >;

  readonly storeTextMessage: (msg: {
    id: string;
    chatJid: string;
    sender: string;
    senderName: string;
    content: string;
    timestamp: string;
    isFromMe: boolean;
  }) => Effect.Effect<void, DatabaseError>;

  readonly storeMediaMessage: (msg: {
    id: string;
    chatJid: string;
    sender: string;
    senderName: string;
    content: string;
    timestamp: string;
    isFromMe: boolean;
    mediaType: string;
    mediaPath: string;
  }) => Effect.Effect<void, DatabaseError>;

  readonly storeAssistantMessage: (
    chatJid: string,
    content: string,
    timestamp: string,
    senderName: string,
  ) => Effect.Effect<void, DatabaseError>;

  readonly getConversationHistory: (
    chatJid: string,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<MessageRow>, DatabaseError>;

  readonly getAllChats: Effect.Effect<ReadonlyArray<ChatRow>, DatabaseError>;

  readonly getAllTasks: Effect.Effect<
    ReadonlyArray<ScheduledTask>,
    DatabaseError
  >;

  readonly getDueTasks: Effect.Effect<
    ReadonlyArray<ScheduledTask>,
    DatabaseError
  >;

  readonly getTaskById: (
    id: string,
  ) => Effect.Effect<ScheduledTask | null, DatabaseError>;

  readonly updateTaskAfterRun: (
    id: string,
    nextRun: string | null,
    result: string,
  ) => Effect.Effect<void, DatabaseError>;

  readonly logTaskRun: (log: TaskRunLog) => Effect.Effect<void, DatabaseError>;

  readonly clearMessages: (chatJid: string) => Effect.Effect<void, DatabaseError>;

  readonly storeChatMetadata: (
    chatJid: string,
    lastActivity: string,
    displayName: string,
  ) => Effect.Effect<void, DatabaseError>;
}

export class Database extends Context.Tag('Database')<
  Database,
  DatabaseService
>() {}
