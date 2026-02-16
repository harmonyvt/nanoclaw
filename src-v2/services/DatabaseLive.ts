/**
 * DatabaseLive — wraps bun:sqlite as an Effect Layer.
 * All operations use Effect.try for typed DatabaseError failures.
 *
 * Port of src/db.ts (v1) — 10 tables, same schema.
 */

import { Database as BunDatabase } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';
import { Effect, Layer } from 'effect';

import { AppConfig } from '../config.js';
import {
  DatabaseError,
  DatabaseConnectionError,
  DatabaseMigrationError,
} from '../errors.js';
import { Database } from './Database.js';
import type { MessageRow, ChatRow, DatabaseService } from './Database.js';
import type { ScheduledTask, TaskRunLog } from '../schemas/Tasks.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const CONVERSATION_RESET_MARKER = '[conversation reset]';

// ─── Migration SQL ──────────────────────────────────────────────────────────

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS chats (
    jid TEXT PRIMARY KEY,
    name TEXT,
    last_message_time TEXT
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT,
    chat_jid TEXT,
    sender TEXT,
    sender_name TEXT,
    content TEXT,
    timestamp TEXT,
    is_from_me INTEGER,
    media_type TEXT,
    media_path TEXT,
    PRIMARY KEY (id, chat_jid),
    FOREIGN KEY (chat_jid) REFERENCES chats(jid)
  );
  CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

  CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id TEXT PRIMARY KEY,
    group_folder TEXT NOT NULL,
    chat_jid TEXT NOT NULL,
    prompt TEXT NOT NULL,
    schedule_type TEXT NOT NULL,
    schedule_value TEXT NOT NULL,
    context_mode TEXT DEFAULT 'isolated',
    next_run TEXT,
    last_run TEXT,
    last_result TEXT,
    status TEXT DEFAULT 'active',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
  CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

  CREATE TABLE IF NOT EXISTS task_run_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    run_at TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    status TEXT NOT NULL,
    result TEXT,
    error TEXT,
    FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
  );
  CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level INTEGER NOT NULL,
    time INTEGER NOT NULL,
    msg TEXT NOT NULL,
    module TEXT,
    group_folder TEXT,
    raw TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_logs_time ON logs(time);
  CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);

  CREATE TABLE IF NOT EXISTS container_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_folder TEXT NOT NULL,
    filename TEXT NOT NULL UNIQUE,
    timestamp TEXT,
    duration_ms INTEGER,
    exit_code INTEGER,
    mode TEXT,
    is_main INTEGER,
    status TEXT,
    file_size INTEGER,
    indexed_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_container_logs_group ON container_logs(group_folder);

  CREATE TABLE IF NOT EXISTS debug_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    category TEXT NOT NULL,
    event_type TEXT NOT NULL,
    group_folder TEXT,
    metadata TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_debug_events_ts ON debug_events(timestamp);
  CREATE INDEX IF NOT EXISTS idx_debug_events_cat ON debug_events(category, event_type);
  CREATE INDEX IF NOT EXISTS idx_debug_events_group ON debug_events(group_folder);

  CREATE TABLE IF NOT EXISTS model_menu (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_jid TEXT NOT NULL,
    label TEXT NOT NULL,
    model TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE(chat_jid, model)
  );
  CREATE INDEX IF NOT EXISTS idx_model_menu_chat ON model_menu(chat_jid);

  CREATE TABLE IF NOT EXISTS active_model_override (
    chat_jid TEXT PRIMARY KEY,
    model_menu_id INTEGER NOT NULL,
    activated_at TEXT NOT NULL,
    FOREIGN KEY (model_menu_id) REFERENCES model_menu(id)
  );
`;

// ─── Live Layer ─────────────────────────────────────────────────────────────

export const DatabaseLive: Layer.Layer<
  Database,
  DatabaseConnectionError | DatabaseMigrationError,
  AppConfig
> = Layer.scoped(
  Database,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const dbPath = path.join(config.storeDir, 'messages.db');

    // Ensure directory exists
    yield* Effect.try({
      try: () => fs.mkdirSync(path.dirname(dbPath), { recursive: true }),
      catch: (err) =>
        new DatabaseConnectionError({
          message: `Failed to create store directory: ${err}`,
          path: dbPath,
        }),
    });

    // Open database connection
    const db = yield* Effect.try({
      try: () => {
        const d = new BunDatabase(dbPath);
        d.exec('PRAGMA journal_mode=WAL');
        d.exec('PRAGMA foreign_keys=ON');
        return d;
      },
      catch: (err) =>
        new DatabaseConnectionError({
          message: `Failed to open database: ${err}`,
          path: dbPath,
        }),
    });

    // Run migrations
    yield* Effect.try({
      try: () => db.exec(SCHEMA_SQL),
      catch: (err) =>
        new DatabaseMigrationError({
          message: `Schema creation failed: ${err}`,
          migration: 'initial',
        }),
    });

    // Register scope finalizer
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        db.close();
      }),
    );

    // Helper: wrap all DB operations for typed errors
    const dbTry = <A>(operation: string, op: () => A) =>
      Effect.try({
        try: op,
        catch: (err) =>
          new DatabaseError({
            message: String(err),
            operation,
          }),
      });

    const service: DatabaseService = {
      initDatabase: Effect.void,

      storeTextMessage: (msg) =>
        dbTry('storeTextMessage', () => {
          db.prepare(
            `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            msg.id,
            msg.chatJid,
            msg.sender,
            msg.senderName,
            msg.content,
            msg.timestamp,
            msg.isFromMe ? 1 : 0,
          );
        }),

      storeMediaMessage: (msg) =>
        dbTry('storeMediaMessage', () => {
          db.prepare(
            `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, media_type, media_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            msg.id,
            msg.chatJid,
            msg.sender,
            msg.senderName,
            msg.content,
            msg.timestamp,
            msg.isFromMe ? 1 : 0,
            msg.mediaType,
            msg.mediaPath,
          );
        }),

      storeAssistantMessage: (chatJid, content, timestamp, senderName) =>
        dbTry('storeAssistantMessage', () => {
          const msgId = `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          db.prepare(
            `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).run(msgId, chatJid, 'assistant', senderName, content, timestamp, 1);
        }),

      getConversationHistory: (chatJid, limit) =>
        dbTry('getConversationHistory', () => {
          // Find most recent reset marker
          const resetRow = db
            .prepare(
              `SELECT timestamp FROM messages
               WHERE chat_jid = ? AND content = ? AND sender = 'system'
               ORDER BY timestamp DESC LIMIT 1`,
            )
            .get(chatJid, CONVERSATION_RESET_MARKER) as
            | { timestamp: string }
            | undefined;

          const sinceTimestamp = resetRow?.timestamp || '';

          const rows = db
            .prepare(
              `SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, media_type, media_path
               FROM messages
               WHERE chat_jid = ? AND timestamp > ? AND content != ? AND sender != 'system'
               ORDER BY timestamp DESC
               LIMIT ?`,
            )
            .all(chatJid, sinceTimestamp, CONVERSATION_RESET_MARKER, limit) as Array<{
            id: string;
            chat_jid: string;
            sender: string;
            sender_name: string;
            content: string;
            timestamp: string;
            is_from_me: number;
            media_type: string | null;
            media_path: string | null;
          }>;

          // Reverse to chronological order
          return rows.reverse().map(
            (row): MessageRow => ({
              id: row.id,
              chat_jid: row.chat_jid,
              sender: row.sender,
              sender_name: row.sender_name,
              content: row.content,
              timestamp: row.timestamp,
              is_from_me: row.is_from_me === 1,
              media_type: row.media_type ?? undefined,
              media_path: row.media_path ?? undefined,
            }),
          );
        }),

      getAllChats: dbTry('getAllChats', () => {
        return db
          .prepare(
            `SELECT jid AS chat_jid, last_message_time AS last_activity
             FROM chats ORDER BY last_message_time DESC`,
          )
          .all() as ReadonlyArray<ChatRow>;
      }),

      getAllTasks: dbTry('getAllTasks', () => {
        return db
          .prepare(
            'SELECT * FROM scheduled_tasks ORDER BY created_at DESC',
          )
          .all() as ReadonlyArray<ScheduledTask>;
      }),

      getDueTasks: dbTry('getDueTasks', () => {
        const now = new Date().toISOString();
        return db
          .prepare(
            `SELECT * FROM scheduled_tasks
             WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
             ORDER BY next_run`,
          )
          .all(now) as ReadonlyArray<ScheduledTask>;
      }),

      getTaskById: (id) =>
        dbTry('getTaskById', () => {
          const row = db
            .prepare('SELECT * FROM scheduled_tasks WHERE id = ?')
            .get(id) as ScheduledTask | undefined;
          return row ?? null;
        }),

      updateTaskAfterRun: (id, nextRun, result) =>
        dbTry('updateTaskAfterRun', () => {
          const now = new Date().toISOString();
          db.prepare(
            `UPDATE scheduled_tasks
             SET next_run = ?, last_run = ?, last_result = ?,
                 status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
             WHERE id = ?`,
          ).run(nextRun, now, result, nextRun, id);
        }),

      logTaskRun: (log) =>
        dbTry('logTaskRun', () => {
          db.prepare(
            `INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(
            log.task_id,
            log.run_at,
            log.duration_ms,
            log.status,
            log.result,
            log.error,
          );
        }),

      clearMessages: (chatJid) =>
        dbTry('clearMessages', () => {
          db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(chatJid);
        }),

      storeChatMetadata: (chatJid, lastActivity, displayName) =>
        dbTry('storeChatMetadata', () => {
          db.prepare(
            `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
             ON CONFLICT(jid) DO UPDATE SET
               name = excluded.name,
               last_message_time = MAX(last_message_time, excluded.last_message_time)`,
          ).run(chatJid, displayName, lastActivity);
        }),
    };

    return service;
  }),
);
