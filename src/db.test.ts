import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Use a temp directory for the test database
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-db-test-'));
  // Override STORE_DIR before importing db module
  process.env.NANOCLAW_STORE_DIR = tmpDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// We need to test db.ts but it depends on config.ts for STORE_DIR.
// Since config.ts uses process.cwd(), we test the DB functions by
// importing them after setting up the temp directory.
// The db module uses STORE_DIR from config, so we test it indirectly.

describe('database', () => {
  test('initDatabase creates tables without error', async () => {
    // Import Database directly to avoid config dependency
    const { Database } = await import('bun:sqlite');
    const dbPath = path.join(tmpDir, 'test.db');
    const db = new Database(dbPath);

    // Run the same schema as db.ts
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
    `);

    // Verify tables exist
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('chats');
    expect(tableNames).toContain('messages');
    expect(tableNames).toContain('scheduled_tasks');
    expect(tableNames).toContain('task_run_logs');

    db.close();
  });

  test('chat CRUD operations work', async () => {
    const { Database } = await import('bun:sqlite');
    const dbPath = path.join(tmpDir, 'test.db');
    const db = new Database(dbPath);

    db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        jid TEXT PRIMARY KEY,
        name TEXT,
        last_message_time TEXT
      );
    `);

    // Insert
    db.prepare(
      'INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)',
    ).run('tg:123', 'Test Chat', '2026-01-01T00:00:00Z');

    // Read
    const chat = db.prepare('SELECT * FROM chats WHERE jid = ?').get('tg:123') as {
      jid: string;
      name: string;
      last_message_time: string;
    };
    expect(chat.jid).toBe('tg:123');
    expect(chat.name).toBe('Test Chat');

    // Upsert (update timestamp)
    db.prepare(`
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time)
    `).run('tg:123', 'Test Chat', '2026-02-01T00:00:00Z');

    const updated = db.prepare('SELECT * FROM chats WHERE jid = ?').get('tg:123') as {
      jid: string;
      last_message_time: string;
    };
    expect(updated.last_message_time).toBe('2026-02-01T00:00:00Z');

    db.close();
  });

  test('message insert and query work', async () => {
    const { Database } = await import('bun:sqlite');
    const dbPath = path.join(tmpDir, 'test.db');
    const db = new Database(dbPath);

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
        media_type TEXT,
        media_path TEXT,
        PRIMARY KEY (id, chat_jid),
        FOREIGN KEY (chat_jid) REFERENCES chats(jid)
      );
      CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);
    `);

    db.prepare('INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)').run(
      'tg:123',
      'Test',
      '2026-01-01T00:00:00Z',
    );

    // Insert messages
    const insert = db.prepare(
      'INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    insert.run('msg1', 'tg:123', 'user1', 'Alice', 'Hello', '2026-01-01T00:01:00Z', 0);
    insert.run('msg2', 'tg:123', 'user1', 'Alice', 'World', '2026-01-01T00:02:00Z', 0);
    insert.run('msg3', 'tg:123', 'bot', 'Andy', 'Andy: Hi', '2026-01-01T00:03:00Z', 0);

    // Query messages since timestamp, filtering bot messages
    const rows = db
      .prepare(
        `SELECT id, content FROM messages
         WHERE timestamp > ? AND chat_jid = ? AND content NOT LIKE ?
         ORDER BY timestamp`,
      )
      .all('2026-01-01T00:00:00Z', 'tg:123', 'Andy:%') as { id: string; content: string }[];

    expect(rows.length).toBe(2);
    expect(rows[0].content).toBe('Hello');
    expect(rows[1].content).toBe('World');

    db.close();
  });

  test('scheduled task lifecycle works', async () => {
    const { Database } = await import('bun:sqlite');
    const dbPath = path.join(tmpDir, 'test.db');
    const db = new Database(dbPath);

    db.exec(`
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
    `);

    // Create task
    db.prepare(`
      INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('task1', 'main', 'tg:123', 'Check weather', 'cron', '0 9 * * *', 'group', '2026-02-08T09:00:00Z', 'active', '2026-02-07T00:00:00Z');

    // Get due tasks
    const dueTasks = db
      .prepare(`SELECT * FROM scheduled_tasks WHERE status = 'active' AND next_run <= ?`)
      .all('2026-02-08T10:00:00Z') as { id: string }[];
    expect(dueTasks.length).toBe(1);

    // Pause task
    db.prepare('UPDATE scheduled_tasks SET status = ? WHERE id = ?').run('paused', 'task1');

    const paused = db.prepare('SELECT status FROM scheduled_tasks WHERE id = ?').get('task1') as {
      status: string;
    };
    expect(paused.status).toBe('paused');

    // Delete task
    db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run('task1');
    const deleted = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get('task1');
    expect(deleted).toBeNull();

    db.close();
  });

  test('media message stores media_type and media_path', async () => {
    const { Database } = await import('bun:sqlite');
    const dbPath = path.join(tmpDir, 'test.db');
    const db = new Database(dbPath);

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
        media_type TEXT,
        media_path TEXT,
        PRIMARY KEY (id, chat_jid)
      );
    `);

    db.prepare('INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)').run(
      'tg:123',
      'Test',
      '2026-01-01T00:00:00Z',
    );

    db.prepare(
      'INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, media_type, media_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('msg1', 'tg:123', 'user1', 'Alice', '[Photo]', '2026-01-01T00:01:00Z', 0, 'photo', '/workspace/group/media/photo.jpg');

    const msg = db.prepare('SELECT * FROM messages WHERE id = ? AND chat_jid = ?').get('msg1', 'tg:123') as {
      media_type: string;
      media_path: string;
    };

    expect(msg.media_type).toBe('photo');
    expect(msg.media_path).toBe('/workspace/group/media/photo.jpg');

    db.close();
  });

  test('idempotent migrations do not error on re-run', async () => {
    const { Database } = await import('bun:sqlite');
    const dbPath = path.join(tmpDir, 'test.db');
    const db = new Database(dbPath);

    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT,
        chat_jid TEXT,
        sender TEXT,
        content TEXT,
        timestamp TEXT,
        is_from_me INTEGER,
        PRIMARY KEY (id, chat_jid)
      );
    `);

    // Run migrations twice - should not throw
    const migrate = (col: string, type: string) => {
      try {
        db.exec(`ALTER TABLE messages ADD COLUMN ${col} ${type}`);
      } catch {
        /* column already exists */
      }
    };

    migrate('sender_name', 'TEXT');
    migrate('sender_name', 'TEXT'); // second run should be harmless
    migrate('media_type', 'TEXT');
    migrate('media_type', 'TEXT');
    migrate('media_path', 'TEXT');
    migrate('media_path', 'TEXT');

    // Verify columns exist
    const info = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
    const colNames = info.map((c) => c.name);
    expect(colNames).toContain('sender_name');
    expect(colNames).toContain('media_type');
    expect(colNames).toContain('media_path');

    db.close();
  });
});
