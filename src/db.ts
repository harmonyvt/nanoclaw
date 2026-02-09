import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

import { STORE_DIR } from './config.js';
import { NewMessage, ScheduledTask, TaskRunLog, Thread } from './types.js';

let db: Database;

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.exec(`
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
  `);

  // Add sender_name column if it doesn't exist (migration for existing DBs)
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN sender_name TEXT`);
  } catch {
    /* column already exists */
  }

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    db.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add media columns if they don't exist (migration for existing DBs)
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN media_type TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN media_path TEXT`);
  } catch {
    /* column already exists */
  }

  // Thread_id column on messages (migration for existing DBs)
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN thread_id TEXT`);
  } catch {
    /* column already exists */
  }

  // Threads tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      session_id TEXT,
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_threads_chat ON threads(chat_jid);

    CREATE TABLE IF NOT EXISTS active_threads (
      chat_jid TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      FOREIGN KEY (thread_id) REFERENCES threads(id)
    );
  `);

  // Dashboard log tables
  db.exec(`
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
  `);
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
): void {
  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time)
    `,
    ).run(chatJid, name, timestamp);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time)
    `,
    ).run(chatJid, chatJid, timestamp);
  }
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Store a text message (channel-agnostic).
 * Used by all transports to insert messages into the DB.
 */
export function storeTextMessage(
  msgId: string,
  chatJid: string,
  sender: string,
  senderName: string,
  content: string,
  timestamp: string,
  isFromMe: boolean,
  threadId?: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, thread_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msgId,
    chatJid,
    sender,
    senderName,
    content,
    timestamp,
    isFromMe ? 1 : 0,
    threadId ?? null,
  );
}

/**
 * Store a media message (channel-agnostic).
 * Extends storeTextMessage with media_type and media_path columns.
 */
export function storeMediaMessage(
  msgId: string,
  chatJid: string,
  sender: string,
  senderName: string,
  content: string,
  timestamp: string,
  isFromMe: boolean,
  mediaType: string,
  mediaPath: string,
  threadId?: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, media_type, media_path, thread_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msgId,
    chatJid,
    sender,
    senderName,
    content,
    timestamp,
    isFromMe ? 1 : 0,
    mediaType,
    mediaPath,
    threadId ?? null,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter out bot's own messages by checking content prefix (not is_from_me, since user shares the account)
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, media_type, media_path, thread_id
    FROM messages
    WHERE timestamp > ? AND chat_jid IN (${placeholders}) AND content NOT LIKE ?
    ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  threadId?: string,
): NewMessage[] {
  // Filter out bot's own messages by checking content prefix
  if (threadId) {
    const sql = `
      SELECT id, chat_jid, sender, sender_name, content, timestamp, media_type, media_path, thread_id
      FROM messages
      WHERE chat_jid = ? AND timestamp > ? AND content NOT LIKE ? AND (thread_id = ? OR thread_id IS NULL)
      ORDER BY timestamp
    `;
    return db
      .prepare(sql)
      .all(chatJid, sinceTimestamp, `${botPrefix}:%`, threadId) as NewMessage[];
  }
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, media_type, media_path, thread_id
    FROM messages
    WHERE chat_jid = ? AND timestamp > ? AND content NOT LIKE ?
    ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`) as NewMessage[];
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

/**
 * Find a task by a suffix/partial ID match (for inline keyboard short IDs).
 * Used when callback data is limited to 64 bytes and we only store the last 8 chars.
 */
export function getTaskByShortId(shortId: string): ScheduledTask | undefined {
  return db
    .prepare("SELECT * FROM scheduled_tasks WHERE id LIKE '%' || ?")
    .get(shortId) as ScheduledTask | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

export function getTaskRunLogs(taskId: string, limit = 10): TaskRunLog[] {
  return db
    .prepare(
      `
    SELECT task_id, run_at, duration_ms, status, result, error
    FROM task_run_logs
    WHERE task_id = ?
    ORDER BY run_at DESC
    LIMIT ?
  `,
    )
    .all(taskId, limit) as TaskRunLog[];
}

/**
 * Delete all messages for a given chat.
 */
export function clearMessages(chatJid: string): number {
  const result = db
    .prepare('DELETE FROM messages WHERE chat_jid = ?')
    .run(chatJid);
  return result.changes;
}

/**
 * Get the total message count for a given chat.
 */
export function getMessageCount(chatJid: string): number {
  const row = db
    .prepare('SELECT COUNT(*) as count FROM messages WHERE chat_jid = ?')
    .get(chatJid) as { count: number } | undefined;
  return row?.count ?? 0;
}

// ── Dashboard log functions ──────────────────────────────────────────────

export interface LogEntry {
  id: number;
  level: number;
  time: number;
  msg: string;
  module: string | null;
  group_folder: string | null;
  raw: string;
}

export interface LogQueryParams {
  level?: number;
  search?: string;
  group?: string;
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
}

export interface ContainerLogEntry {
  id: number;
  group_folder: string;
  filename: string;
  timestamp: string | null;
  duration_ms: number | null;
  exit_code: number | null;
  mode: string | null;
  is_main: number | null;
  status: string | null;
  file_size: number | null;
  indexed_at: string;
}

export function insertLog(log: Omit<LogEntry, 'id'>): number {
  const stmt = db.prepare(`
    INSERT INTO logs (level, time, msg, module, group_folder, raw)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    log.level,
    log.time,
    log.msg,
    log.module,
    log.group_folder,
    log.raw,
  );
  return Number(result.lastInsertRowid);
}

export function getLogById(id: number): LogEntry | null {
  return (
    (db
      .prepare(
        'SELECT id, level, time, msg, module, group_folder, raw FROM logs WHERE id = ?',
      )
      .get(id) as LogEntry | undefined) ?? null
  );
}

export function queryLogs(params: LogQueryParams): LogEntry[] {
  const conditions: string[] = [];
  const values: (string | number)[] = [];

  if (params.level !== undefined) {
    conditions.push('level = ?');
    values.push(params.level);
  }
  if (params.search) {
    conditions.push('msg LIKE ?');
    values.push(`%${params.search}%`);
  }
  if (params.group) {
    conditions.push('group_folder = ?');
    values.push(params.group);
  }
  if (params.since !== undefined) {
    conditions.push('time >= ?');
    values.push(params.since);
  }
  if (params.until !== undefined) {
    conditions.push('time <= ?');
    values.push(params.until);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = params.limit || 200;
  const offset = params.offset || 0;

  return db
    .prepare(
      `SELECT id, level, time, msg, module, group_folder, raw FROM logs ${where} ORDER BY time DESC LIMIT ? OFFSET ?`,
    )
    .all(...values, limit, offset) as LogEntry[];
}

export function getLogStats(): {
  total: number;
  byLevel: Record<number, number>;
  oldestTime: number | null;
  newestTime: number | null;
} {
  const total = (
    db.prepare('SELECT COUNT(*) as count FROM logs').get() as { count: number }
  ).count;

  const levels = db
    .prepare('SELECT level, COUNT(*) as count FROM logs GROUP BY level')
    .all() as { level: number; count: number }[];

  const byLevel: Record<number, number> = {};
  for (const row of levels) byLevel[row.level] = row.count;

  const times = db
    .prepare('SELECT MIN(time) as oldest, MAX(time) as newest FROM logs')
    .get() as { oldest: number | null; newest: number | null };

  return {
    total,
    byLevel,
    oldestTime: times.oldest,
    newestTime: times.newest,
  };
}

export function insertContainerLog(
  entry: Omit<ContainerLogEntry, 'id'>,
): void {
  db.prepare(`
    INSERT OR IGNORE INTO container_logs (group_folder, filename, timestamp, duration_ms, exit_code, mode, is_main, status, file_size, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.group_folder,
    entry.filename,
    entry.timestamp,
    entry.duration_ms,
    entry.exit_code,
    entry.mode,
    entry.is_main,
    entry.status,
    entry.file_size,
    entry.indexed_at,
  );
}

export function queryContainerLogs(params: {
  group?: string;
  since?: string;
  limit?: number;
}): ContainerLogEntry[] {
  const conditions: string[] = [];
  const values: (string | number)[] = [];

  if (params.group) {
    conditions.push('group_folder = ?');
    values.push(params.group);
  }
  if (params.since) {
    conditions.push('timestamp >= ?');
    values.push(params.since);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = params.limit || 50;

  return db
    .prepare(
      `SELECT * FROM container_logs ${where} ORDER BY indexed_at DESC LIMIT ?`,
    )
    .all(...values, limit) as ContainerLogEntry[];
}

export function isContainerLogIndexed(filename: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM container_logs WHERE filename = ?')
    .get(filename);
  return !!row;
}

export function pruneOldLogs(retentionMs: number): number {
  const cutoff = Date.now() - retentionMs;
  const result = db.prepare('DELETE FROM logs WHERE time < ?').run(cutoff);
  return result.changes;
}

export function getAllTaskRunLogs(
  limit = 50,
  offset = 0,
): (TaskRunLog & {
  prompt: string;
  group_folder: string;
  schedule_type: string;
})[] {
  return db
    .prepare(
      `
    SELECT trl.task_id, trl.run_at, trl.duration_ms, trl.status, trl.result, trl.error,
           st.prompt, st.group_folder, st.schedule_type
    FROM task_run_logs trl
    JOIN scheduled_tasks st ON trl.task_id = st.id
    ORDER BY trl.run_at DESC
    LIMIT ? OFFSET ?
  `,
    )
    .all(limit, offset) as (TaskRunLog & {
    prompt: string;
    group_folder: string;
    schedule_type: string;
  })[];
}

// ── Thread functions ────────────────────────────────────────────────────

export function createThread(
  id: string,
  chatJid: string,
  name: string,
  sessionId?: string,
): Thread {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO threads (id, chat_jid, name, created_at, updated_at, session_id) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, chatJid, name, now, now, sessionId ?? null);
  return { id, chat_jid: chatJid, name, created_at: now, updated_at: now, session_id: sessionId ?? null };
}

export function getThread(id: string): Thread | undefined {
  return db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as Thread | undefined;
}

export function getThreadByName(chatJid: string, name: string): Thread | undefined {
  return db
    .prepare('SELECT * FROM threads WHERE chat_jid = ? AND name = ? COLLATE NOCASE')
    .get(chatJid, name) as Thread | undefined;
}

export function getThreadsForChat(chatJid: string): Thread[] {
  return db
    .prepare('SELECT * FROM threads WHERE chat_jid = ? ORDER BY updated_at DESC')
    .all(chatJid) as Thread[];
}

export function getActiveThread(chatJid: string): Thread | undefined {
  const row = db
    .prepare(
      `SELECT t.* FROM threads t
       JOIN active_threads at ON t.id = at.thread_id
       WHERE at.chat_jid = ?`,
    )
    .get(chatJid) as Thread | undefined;
  return row;
}

export function setActiveThread(chatJid: string, threadId: string): void {
  db.prepare(
    `INSERT INTO active_threads (chat_jid, thread_id) VALUES (?, ?)
     ON CONFLICT(chat_jid) DO UPDATE SET thread_id = excluded.thread_id`,
  ).run(chatJid, threadId);
}

export function updateThreadSession(threadId: string, sessionId: string | null): void {
  db.prepare(
    `UPDATE threads SET session_id = ?, updated_at = ? WHERE id = ?`,
  ).run(sessionId, new Date().toISOString(), threadId);
}

export function updateThreadTimestamp(threadId: string): void {
  db.prepare(
    `UPDATE threads SET updated_at = ? WHERE id = ?`,
  ).run(new Date().toISOString(), threadId);
}

export function renameThread(threadId: string, newName: string): void {
  db.prepare(
    `UPDATE threads SET name = ?, updated_at = ? WHERE id = ?`,
  ).run(newName, new Date().toISOString(), threadId);
}

export function deleteThread(threadId: string): void {
  // Remove active_threads reference if this was the active thread
  db.prepare('DELETE FROM active_threads WHERE thread_id = ?').run(threadId);
  // Clear thread_id from messages (don't delete the messages)
  db.prepare('UPDATE messages SET thread_id = NULL WHERE thread_id = ?').run(threadId);
  db.prepare('DELETE FROM threads WHERE id = ?').run(threadId);
}

export function getThreadMessageCount(threadId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) as count FROM messages WHERE thread_id = ?')
    .get(threadId) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function getThreadMessages(
  threadId: string,
  limit = 50,
  offset = 0,
): NewMessage[] {
  return db
    .prepare(
      `SELECT id, chat_jid, sender, sender_name, content, timestamp, media_type, media_path, thread_id
       FROM messages WHERE thread_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
    )
    .all(threadId, limit, offset) as NewMessage[];
}

/**
 * Ensure a default thread exists for a chat. Returns the active thread.
 * If no threads exist, creates a "Default" thread and sets it as active.
 */
export function ensureDefaultThread(chatJid: string): Thread {
  const active = getActiveThread(chatJid);
  if (active) return active;

  // Check if any threads exist
  const threads = getThreadsForChat(chatJid);
  if (threads.length > 0) {
    // Activate the most recently updated thread
    setActiveThread(chatJid, threads[0].id);
    return threads[0];
  }

  // Create default thread
  const id = `thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const thread = createThread(id, chatJid, 'Default');
  setActiveThread(chatJid, thread.id);
  return thread;
}
