import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

import { STORE_DIR } from './config.js';
import { NewMessage, ScheduledTask, TaskRunLog } from './types.js';

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
  `);

  // Model swap menu tables
  db.exec(`
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
): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msgId,
    chatJid,
    sender,
    senderName,
    content,
    timestamp,
    isFromMe ? 1 : 0,
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
): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, media_type, media_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  );
}

/**
 * Store an assistant (bot) response message.
 * Uses is_from_me=1 to distinguish from user messages.
 */
export function storeAssistantMessage(
  chatJid: string,
  content: string,
  timestamp: string,
  senderName: string,
): void {
  const msgId = `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(msgId, chatJid, 'assistant', senderName, content, timestamp, 1);
}

/** Conversation reset marker content — used by /new to boundary conversation history */
export const CONVERSATION_RESET_MARKER = '[conversation reset]';

/**
 * Insert a conversation reset marker. getConversationHistory() only returns
 * messages after the most recent reset marker for a chat.
 */
export function insertConversationReset(chatJid: string): void {
  const msgId = `reset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const timestamp = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(msgId, chatJid, 'system', 'system', CONVERSATION_RESET_MARKER, timestamp, 0);
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  sender_name: string;
  content: string;
  timestamp: string;
  media_type?: string;
  media_path?: string;
}

/**
 * Get conversation history for a chat (both user and assistant messages).
 * Returns the last `limit` messages, respecting conversation reset markers
 * (only returns messages after the most recent reset).
 */
export function getConversationHistory(
  chatJid: string,
  limit: number,
): ConversationMessage[] {
  // First, find the most recent reset marker timestamp (if any)
  const resetRow = db
    .prepare(
      `SELECT timestamp FROM messages
       WHERE chat_jid = ? AND content = ? AND sender = 'system'
       ORDER BY timestamp DESC LIMIT 1`,
    )
    .get(chatJid, CONVERSATION_RESET_MARKER) as { timestamp: string } | undefined;

  const sinceTimestamp = resetRow?.timestamp || '';

  // Get last N messages (both user and assistant) after the reset boundary
  const sql = `
    SELECT sender_name, content, timestamp, is_from_me, media_type, media_path
    FROM messages
    WHERE chat_jid = ? AND timestamp > ? AND content != ? AND sender != 'system'
    ORDER BY timestamp DESC
    LIMIT ?
  `;

  const rows = db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, CONVERSATION_RESET_MARKER, limit) as Array<{
    sender_name: string;
    content: string;
    timestamp: string;
    is_from_me: number;
    media_type: string | null;
    media_path: string | null;
  }>;

  // Reverse to chronological order (query was DESC for LIMIT, we want ASC)
  return rows.reverse().map((row) => ({
    role: row.is_from_me ? 'assistant' as const : 'user' as const,
    sender_name: row.sender_name,
    content: row.content,
    timestamp: row.timestamp,
    media_type: row.media_type || undefined,
    media_path: row.media_path || undefined,
  }));
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
    SELECT id, chat_jid, sender, sender_name, content, timestamp, media_type, media_path
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
): NewMessage[] {
  // Filter out bot's own messages by checking content prefix
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, media_type, media_path
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

export interface ConversationStatus {
  totalMessageCount: number;
  threadMessageCount: number;
  resetAt?: string;
  threadStartedAt?: string;
  threadLatestAt?: string;
}

/**
 * Get debug-friendly conversation status for a chat.
 * Thread metrics are scoped to messages after the latest /new reset marker.
 */
export function getConversationStatus(chatJid: string): ConversationStatus {
  const totalMessageCount = getMessageCount(chatJid);

  const resetRow = db
    .prepare(
      `SELECT timestamp FROM messages
       WHERE chat_jid = ? AND content = ? AND sender = 'system'
       ORDER BY timestamp DESC LIMIT 1`,
    )
    .get(chatJid, CONVERSATION_RESET_MARKER) as { timestamp: string } | undefined;

  const sinceTimestamp = resetRow?.timestamp || '';

  const threadAgg = db
    .prepare(
      `
      SELECT
        COUNT(*) as count,
        MIN(timestamp) as first_timestamp,
        MAX(timestamp) as last_timestamp
      FROM messages
      WHERE chat_jid = ?
        AND timestamp > ?
        AND sender != 'system'
        AND content != ?
    `,
    )
    .get(
      chatJid,
      sinceTimestamp,
      CONVERSATION_RESET_MARKER,
    ) as {
    count: number;
    first_timestamp: string | null;
    last_timestamp: string | null;
  } | undefined;

  return {
    totalMessageCount,
    threadMessageCount: threadAgg?.count ?? 0,
    resetAt: resetRow?.timestamp,
    threadStartedAt: threadAgg?.first_timestamp || undefined,
    threadLatestAt: threadAgg?.last_timestamp || undefined,
  };
}

// ── Dashboard chat/thread functions ──────────────────────────────────────

export interface ChatWithCount extends ChatInfo {
  message_count: number;
}

/**
 * Get all chats with message counts, ordered by most recent activity.
 */
export function getChatsWithCounts(): ChatWithCount[] {
  return db
    .prepare(
      `
      SELECT c.jid, c.name, c.last_message_time,
             COUNT(m.id) as message_count
      FROM chats c
      LEFT JOIN messages m ON m.chat_jid = c.jid
      GROUP BY c.jid
      ORDER BY c.last_message_time DESC
    `,
    )
    .all() as ChatWithCount[];
}

export interface ChatMessage {
  id: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: number;
  media_type: string | null;
  media_path: string | null;
  is_reset: boolean;
}

/**
 * Get all messages for a chat (including reset markers), chronological order.
 * Reset markers are tagged with is_reset: true so the UI can render thread dividers.
 */
export function getChatMessages(
  chatJid: string,
  limit = 200,
): ChatMessage[] {
  const rows = db
    .prepare(
      `
      SELECT id, sender, sender_name, content, timestamp, is_from_me,
             media_type, media_path
      FROM messages
      WHERE chat_jid = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `,
    )
    .all(chatJid, limit) as Array<{
    id: string;
    sender: string;
    sender_name: string;
    content: string;
    timestamp: string;
    is_from_me: number;
    media_type: string | null;
    media_path: string | null;
  }>;

  return rows.reverse().map((row) => ({
    ...row,
    is_reset:
      row.content === CONVERSATION_RESET_MARKER && row.sender === 'system',
  }));
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

// ── Debug event functions ──────────────────────────────────────────────

export interface DebugEventEntry {
  id: number;
  timestamp: number;
  category: string;
  event_type: string;
  group_folder: string | null;
  metadata: string;
}

export function insertDebugEvent(
  category: string,
  eventType: string,
  groupFolder: string | null,
  metadata: Record<string, unknown>,
): void {
  db.prepare(`
    INSERT INTO debug_events (timestamp, category, event_type, group_folder, metadata)
    VALUES (?, ?, ?, ?, ?)
  `).run(Date.now(), category, eventType, groupFolder, JSON.stringify(metadata));
}

export function exportDebugEvents(opts: {
  since?: number;
  group?: string;
  limit?: number;
}): DebugEventEntry[] {
  const conditions: string[] = [];
  const values: (string | number)[] = [];

  if (opts.since !== undefined) {
    conditions.push('timestamp >= ?');
    values.push(opts.since);
  }
  if (opts.group) {
    conditions.push('group_folder = ?');
    values.push(opts.group);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts.limit || 10000;

  return db
    .prepare(
      `SELECT id, timestamp, category, event_type, group_folder, metadata
       FROM debug_events ${where}
       ORDER BY timestamp ASC
       LIMIT ?`,
    )
    .all(...values, limit) as DebugEventEntry[];
}

export function pruneDebugEvents(retentionMs: number): number {
  const cutoff = Date.now() - retentionMs;
  const result = db
    .prepare('DELETE FROM debug_events WHERE timestamp < ?')
    .run(cutoff);
  return result.changes;
}

export function getDebugEventStats(): {
  total: number;
  byCategory: Record<string, number>;
  oldestTimestamp: number | null;
  newestTimestamp: number | null;
} {
  const total = (
    db.prepare('SELECT COUNT(*) as count FROM debug_events').get() as {
      count: number;
    }
  ).count;

  const cats = db
    .prepare(
      'SELECT category, COUNT(*) as count FROM debug_events GROUP BY category',
    )
    .all() as { category: string; count: number }[];

  const byCategory: Record<string, number> = {};
  for (const row of cats) byCategory[row.category] = row.count;

  const times = db
    .prepare(
      'SELECT MIN(timestamp) as oldest, MAX(timestamp) as newest FROM debug_events',
    )
    .get() as { oldest: number | null; newest: number | null };

  return {
    total,
    byCategory,
    oldestTimestamp: times.oldest,
    newestTimestamp: times.newest,
  };
}

// ── Model swap menu functions ────────────────────────────────────────────

export interface ModelMenuItem {
  id: number;
  label: string;
  model: string;
  is_active: boolean;
}

/**
 * Add a model to the per-chat model menu.
 * Returns the new row ID.
 */
export function addModelToMenu(
  chatJid: string,
  label: string,
  model: string,
): number {
  const result = db
    .prepare(
      `INSERT INTO model_menu (chat_jid, label, model, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run(chatJid, label, model, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

/**
 * Remove a model from the menu. Also clears the active override
 * if it was pointing at the deleted entry.
 */
export function removeModelFromMenu(chatJid: string, id: number): void {
  db.prepare(
    `DELETE FROM active_model_override WHERE chat_jid = ? AND model_menu_id = ?`,
  ).run(chatJid, id);
  db.prepare(`DELETE FROM model_menu WHERE id = ? AND chat_jid = ?`).run(
    id,
    chatJid,
  );
}

/**
 * Get the full model menu for a chat, with is_active flag.
 */
export function getModelMenu(chatJid: string): ModelMenuItem[] {
  return db
    .prepare(
      `
      SELECT mm.id, mm.label, mm.model,
             CASE WHEN amo.model_menu_id IS NOT NULL THEN 1 ELSE 0 END as is_active
      FROM model_menu mm
      LEFT JOIN active_model_override amo
        ON amo.chat_jid = mm.chat_jid AND amo.model_menu_id = mm.id
      WHERE mm.chat_jid = ?
      ORDER BY mm.sort_order, mm.id
    `,
    )
    .all(chatJid)
    .map((row: any) => ({
      id: row.id as number,
      label: row.label as string,
      model: row.model as string,
      is_active: row.is_active === 1,
    }));
}

/**
 * Set the active model override for a chat.
 * Uses INSERT OR REPLACE (chat_jid is PK).
 */
export function setActiveModelOverride(
  chatJid: string,
  modelMenuId: number,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO active_model_override (chat_jid, model_menu_id, activated_at) VALUES (?, ?, ?)`,
  ).run(chatJid, modelMenuId, new Date().toISOString());
}

/**
 * Clear the active model override, reverting to the group default.
 */
export function clearActiveModelOverride(chatJid: string): void {
  db.prepare(`DELETE FROM active_model_override WHERE chat_jid = ?`).run(
    chatJid,
  );
}

/**
 * Get the active model override for a chat, if any.
 * Returns null if no override is set.
 */
export function getActiveModelOverride(
  chatJid: string,
): { model: string; label: string } | null {
  const row = db
    .prepare(
      `
      SELECT mm.model, mm.label
      FROM active_model_override amo
      JOIN model_menu mm ON mm.id = amo.model_menu_id
      WHERE amo.chat_jid = ?
    `,
    )
    .get(chatJid) as { model: string; label: string } | undefined;
  return row || null;
}
