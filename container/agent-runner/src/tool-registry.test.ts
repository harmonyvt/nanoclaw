/**
 * Tests for the provider-agnostic tool registry.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { z } from 'zod';
import {
  NANOCLAW_TOOLS,
  writeIpcFile,
  IPC_DIR,
  MESSAGES_DIR,
  TASKS_DIR,
  resolveSupermemoryApiKey,
  SUPERMEMORY_KEY_ENV_VARS,
} from './tool-registry.js';
import type { IpcMcpContext, NanoTool } from './types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findTool(name: string): NanoTool {
  const tool = NANOCLAW_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found in NANOCLAW_TOOLS`);
  return tool;
}

function makeCtx(overrides: Partial<IpcMcpContext> = {}): IpcMcpContext {
  return {
    chatJid: 'tg:-1001234567890',
    groupFolder: 'test-group',
    isMain: false,
    ...overrides,
  };
}

// ─── 1. Tool Definitions Completeness ─────────────────────────────────────────

describe('Tool definitions completeness', () => {
  test('every tool has name, description, schema, and handler', () => {
    for (const tool of NANOCLAW_TOOLS) {
      expect(typeof tool.name).toBe('string');
      expect(tool.name.length).toBeGreaterThan(0);

      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);

      // schema should be a Zod object
      expect(tool.schema).toBeDefined();
      expect(typeof tool.schema.parse).toBe('function');

      expect(typeof tool.handler).toBe('function');
    }
  });

  test('no duplicate tool names', () => {
    const names = NANOCLAW_TOOLS.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });
});

// ─── 2. All 22 Tools Present ──────────────────────────────────────────────────

describe('All tools present', () => {
  const EXPECTED_TOOLS = [
    'send_message',
    'schedule_task',
    'list_tasks',
    'pause_task',
    'resume_task',
    'cancel_task',
    'register_group',
    'firecrawl_scrape',
    'firecrawl_crawl',
    'firecrawl_map',
    'memory_save',
    'memory_search',
    'browse_navigate',
    'browse_snapshot',
    'browse_click',
    'browse_fill',
    'browse_scroll',
    'browse_screenshot',
    'browse_wait_for_user',
    'browse_go_back',
    'browse_evaluate',
    'browse_close',
  ] as const;

  test('NANOCLAW_TOOLS contains exactly 22 tools', () => {
    expect(NANOCLAW_TOOLS.length).toBe(22);
  });

  test.each(EXPECTED_TOOLS)('tool "%s" exists', (name) => {
    const tool = NANOCLAW_TOOLS.find((t) => t.name === name);
    expect(tool).toBeDefined();
  });
});

// ─── 3. Zod Schema Validation ─────────────────────────────────────────────────

describe('Zod schema validation', () => {
  describe('send_message schema', () => {
    const tool = findTool('send_message');

    test('valid text parses', () => {
      const result = tool.schema.safeParse({ text: 'Hello world' });
      expect(result.success).toBe(true);
    });

    test('missing text fails', () => {
      const result = tool.schema.safeParse({});
      expect(result.success).toBe(false);
    });

    test('non-string text fails', () => {
      const result = tool.schema.safeParse({ text: 123 });
      expect(result.success).toBe(false);
    });
  });

  describe('schedule_task schema', () => {
    const tool = findTool('schedule_task');

    test('valid args parse', () => {
      const result = tool.schema.safeParse({
        prompt: 'Check weather',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
      });
      expect(result.success).toBe(true);
    });

    test('context_mode defaults to group', () => {
      const result = tool.schema.safeParse({
        prompt: 'Check weather',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.context_mode).toBe('group');
      }
    });

    test('invalid schedule_type fails', () => {
      const result = tool.schema.safeParse({
        prompt: 'Check weather',
        schedule_type: 'invalid_type',
        schedule_value: '0 9 * * *',
      });
      expect(result.success).toBe(false);
    });

    test('missing prompt fails', () => {
      const result = tool.schema.safeParse({
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
      });
      expect(result.success).toBe(false);
    });

    test('optional target_group is accepted', () => {
      const result = tool.schema.safeParse({
        prompt: 'Do something',
        schedule_type: 'once',
        schedule_value: '2026-02-01T15:30:00',
        target_group: 'other-group',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('register_group schema', () => {
    const tool = findTool('register_group');

    test('valid args parse', () => {
      const result = tool.schema.safeParse({
        jid: 'tg:-1001234567890',
        name: 'Family Chat',
        folder: 'family-chat',
        trigger: '@Andy',
      });
      expect(result.success).toBe(true);
    });

    test('optional provider/model accepted', () => {
      const result = tool.schema.safeParse({
        jid: 'tg:-1001234567890',
        name: 'Family Chat',
        folder: 'family-chat',
        trigger: '@Andy',
        provider: 'openai',
        model: 'gpt-4o',
      });
      expect(result.success).toBe(true);
    });

    test('missing required field fails', () => {
      const result = tool.schema.safeParse({
        jid: 'tg:-1001234567890',
        name: 'Family Chat',
        // folder is missing
        trigger: '@Andy',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('browse_scroll schema', () => {
    const tool = findTool('browse_scroll');

    test('valid dy parses', () => {
      const result = tool.schema.safeParse({ dy: 300 });
      expect(result.success).toBe(true);
    });

    test('optional dx accepted', () => {
      const result = tool.schema.safeParse({ dy: 300, dx: -100 });
      expect(result.success).toBe(true);
    });

    test('missing dy fails', () => {
      const result = tool.schema.safeParse({});
      expect(result.success).toBe(false);
    });
  });
});

// ─── 4. send_message handler ──────────────────────────────────────────────────

describe('send_message handler', () => {
  let tmpDir: string;
  let origMkdirSync: typeof fs.mkdirSync;
  let origWriteFileSync: typeof fs.writeFileSync;
  let origRenameSync: typeof fs.renameSync;

  // We test the handler by temporarily patching writeIpcFile's target.
  // Since writeIpcFile uses MESSAGES_DIR (which is /workspace/ipc/messages),
  // we redirect by monkey-patching fs to capture writes to a temp dir.
  let capturedFiles: Array<{ path: string; data: string }> = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-'));
    capturedFiles = [];

    origMkdirSync = fs.mkdirSync;
    origWriteFileSync = fs.writeFileSync;
    origRenameSync = fs.renameSync;

    // Intercept mkdirSync for IPC paths
    (fs as any).mkdirSync = (p: string, opts?: any) => {
      if (typeof p === 'string' && p.startsWith('/workspace/ipc')) {
        const redirected = p.replace('/workspace/ipc', tmpDir);
        return origMkdirSync(redirected, opts);
      }
      return origMkdirSync(p, opts);
    };

    // Intercept writeFileSync for IPC paths
    (fs as any).writeFileSync = (p: string, data: any, opts?: any) => {
      if (typeof p === 'string' && p.startsWith('/workspace/ipc')) {
        const redirected = p.replace('/workspace/ipc', tmpDir);
        origMkdirSync(path.dirname(redirected), { recursive: true });
        capturedFiles.push({ path: redirected, data: typeof data === 'string' ? data : data.toString() });
        return origWriteFileSync(redirected, data, opts);
      }
      return origWriteFileSync(p, data, opts);
    };

    // Intercept renameSync for IPC paths
    (fs as any).renameSync = (src: string, dest: string) => {
      if (typeof src === 'string' && src.startsWith('/workspace/ipc')) {
        const redirectedSrc = src.replace('/workspace/ipc', tmpDir);
        const redirectedDest = dest.replace('/workspace/ipc', tmpDir);
        return origRenameSync(redirectedSrc, redirectedDest);
      }
      return origRenameSync(src, dest);
    };
  });

  afterEach(() => {
    // Restore original fs methods
    (fs as any).mkdirSync = origMkdirSync;
    (fs as any).writeFileSync = origWriteFileSync;
    (fs as any).renameSync = origRenameSync;

    // Clean up temp dir
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('writes JSON file with correct structure', async () => {
    const tool = findTool('send_message');
    const ctx = makeCtx({ chatJid: 'tg:-100999', groupFolder: 'my-group' });

    const result = await tool.handler({ text: 'Hello from test' }, ctx);

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('Message queued for delivery');

    // Read the written file from the redirected messages dir
    const messagesDir = path.join(tmpDir, 'messages');
    const files = fs.readdirSync(messagesDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBe(1);

    const written = JSON.parse(fs.readFileSync(path.join(messagesDir, files[0]), 'utf-8'));
    expect(written.type).toBe('message');
    expect(written.chatJid).toBe('tg:-100999');
    expect(written.text).toBe('Hello from test');
    expect(written.groupFolder).toBe('my-group');
    expect(typeof written.timestamp).toBe('string');
    // Verify it's a valid ISO timestamp
    expect(new Date(written.timestamp).toISOString()).toBe(written.timestamp);
  });
});

// ─── 5. schedule_task validation ──────────────────────────────────────────────

describe('schedule_task handler validation', () => {
  let tmpDir: string;
  let origMkdirSync: typeof fs.mkdirSync;
  let origWriteFileSync: typeof fs.writeFileSync;
  let origRenameSync: typeof fs.renameSync;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-'));

    origMkdirSync = fs.mkdirSync;
    origWriteFileSync = fs.writeFileSync;
    origRenameSync = fs.renameSync;

    (fs as any).mkdirSync = (p: string, opts?: any) => {
      if (typeof p === 'string' && p.startsWith('/workspace/ipc')) {
        const redirected = p.replace('/workspace/ipc', tmpDir);
        return origMkdirSync(redirected, opts);
      }
      return origMkdirSync(p, opts);
    };

    (fs as any).writeFileSync = (p: string, data: any, opts?: any) => {
      if (typeof p === 'string' && p.startsWith('/workspace/ipc')) {
        const redirected = p.replace('/workspace/ipc', tmpDir);
        origMkdirSync(path.dirname(redirected), { recursive: true });
        return origWriteFileSync(redirected, data, opts);
      }
      return origWriteFileSync(p, data, opts);
    };

    (fs as any).renameSync = (src: string, dest: string) => {
      if (typeof src === 'string' && src.startsWith('/workspace/ipc')) {
        const redirectedSrc = src.replace('/workspace/ipc', tmpDir);
        const redirectedDest = dest.replace('/workspace/ipc', tmpDir);
        return origRenameSync(redirectedSrc, redirectedDest);
      }
      return origRenameSync(src, dest);
    };
  });

  afterEach(() => {
    (fs as any).mkdirSync = origMkdirSync;
    (fs as any).writeFileSync = origWriteFileSync;
    (fs as any).renameSync = origRenameSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('invalid cron expression returns isError: true', async () => {
    const tool = findTool('schedule_task');
    const ctx = makeCtx();

    const result = await tool.handler(
      {
        prompt: 'Do something',
        schedule_type: 'cron',
        schedule_value: 'not a cron',
        context_mode: 'group',
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid cron');
  });

  test('valid cron expression succeeds', async () => {
    const tool = findTool('schedule_task');
    const ctx = makeCtx();

    const result = await tool.handler(
      {
        prompt: 'Check weather',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        context_mode: 'group',
      },
      ctx,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('Task scheduled');
    expect(result.content).toContain('cron');
  });

  test('invalid interval returns isError: true', async () => {
    const tool = findTool('schedule_task');
    const ctx = makeCtx();

    const result = await tool.handler(
      {
        prompt: 'Do something',
        schedule_type: 'interval',
        schedule_value: '-100',
        context_mode: 'group',
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid interval');
  });

  test('valid interval succeeds', async () => {
    const tool = findTool('schedule_task');
    const ctx = makeCtx();

    const result = await tool.handler(
      {
        prompt: 'Poll something',
        schedule_type: 'interval',
        schedule_value: '300000',
        context_mode: 'isolated',
      },
      ctx,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('Task scheduled');
  });

  test('invalid once timestamp returns isError: true', async () => {
    const tool = findTool('schedule_task');
    const ctx = makeCtx();

    const result = await tool.handler(
      {
        prompt: 'Do something',
        schedule_type: 'once',
        schedule_value: 'not-a-date',
        context_mode: 'group',
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid timestamp');
  });

  test('valid once timestamp succeeds', async () => {
    const tool = findTool('schedule_task');
    const ctx = makeCtx();

    const result = await tool.handler(
      {
        prompt: 'Remind me',
        schedule_type: 'once',
        schedule_value: '2026-06-01T15:30:00',
        context_mode: 'group',
      },
      ctx,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('Task scheduled');
  });

  test('non-main group cannot use target_group', async () => {
    const tool = findTool('schedule_task');
    const ctx = makeCtx({ isMain: false, groupFolder: 'my-group' });

    const result = await tool.handler(
      {
        prompt: 'Do something',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        context_mode: 'group',
        target_group: 'other-group',
      },
      ctx,
    );

    // Should succeed but target_group should be ignored (forced to own group)
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('Task scheduled');

    // Verify the IPC file was written with the agent's own groupFolder, not the target
    const tasksDir = path.join(tmpDir, 'tasks');
    const files = fs.readdirSync(tasksDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBe(1);

    const written = JSON.parse(fs.readFileSync(path.join(tasksDir, files[0]), 'utf-8'));
    expect(written.groupFolder).toBe('my-group');
  });

  test('main group can use target_group', async () => {
    const tool = findTool('schedule_task');
    const ctx = makeCtx({ isMain: true, groupFolder: 'main' });

    const result = await tool.handler(
      {
        prompt: 'Do something for other group',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        context_mode: 'group',
        target_group: 'other-group',
      },
      ctx,
    );

    expect(result.isError).toBeUndefined();

    const tasksDir = path.join(tmpDir, 'tasks');
    const files = fs.readdirSync(tasksDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBe(1);

    const written = JSON.parse(fs.readFileSync(path.join(tasksDir, files[0]), 'utf-8'));
    expect(written.groupFolder).toBe('other-group');
  });
});

// ─── 6. register_group restrictions ──────────────────────────────────────────

describe('register_group handler', () => {
  let tmpDir: string;
  let origMkdirSync: typeof fs.mkdirSync;
  let origWriteFileSync: typeof fs.writeFileSync;
  let origRenameSync: typeof fs.renameSync;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-'));

    origMkdirSync = fs.mkdirSync;
    origWriteFileSync = fs.writeFileSync;
    origRenameSync = fs.renameSync;

    (fs as any).mkdirSync = (p: string, opts?: any) => {
      if (typeof p === 'string' && p.startsWith('/workspace/ipc')) {
        return origMkdirSync(p.replace('/workspace/ipc', tmpDir), opts);
      }
      return origMkdirSync(p, opts);
    };

    (fs as any).writeFileSync = (p: string, data: any, opts?: any) => {
      if (typeof p === 'string' && p.startsWith('/workspace/ipc')) {
        const redirected = p.replace('/workspace/ipc', tmpDir);
        origMkdirSync(path.dirname(redirected), { recursive: true });
        return origWriteFileSync(redirected, data, opts);
      }
      return origWriteFileSync(p, data, opts);
    };

    (fs as any).renameSync = (src: string, dest: string) => {
      if (typeof src === 'string' && src.startsWith('/workspace/ipc')) {
        return origRenameSync(
          src.replace('/workspace/ipc', tmpDir),
          dest.replace('/workspace/ipc', tmpDir),
        );
      }
      return origRenameSync(src, dest);
    };
  });

  afterEach(() => {
    (fs as any).mkdirSync = origMkdirSync;
    (fs as any).writeFileSync = origWriteFileSync;
    (fs as any).renameSync = origRenameSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('non-main context returns isError', async () => {
    const tool = findTool('register_group');
    const ctx = makeCtx({ isMain: false });

    const result = await tool.handler(
      {
        jid: 'tg:-100555',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Bot',
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Only the main group');
  });

  test('main context succeeds', async () => {
    const tool = findTool('register_group');
    const ctx = makeCtx({ isMain: true });

    const result = await tool.handler(
      {
        jid: 'tg:-100555',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Bot',
      },
      ctx,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('registered');
  });

  test('with provider/model includes providerConfig in IPC data', async () => {
    const tool = findTool('register_group');
    const ctx = makeCtx({ isMain: true });

    const result = await tool.handler(
      {
        jid: 'tg:-100555',
        name: 'OpenAI Group',
        folder: 'openai-group',
        trigger: '@Bot',
        provider: 'openai',
        model: 'gpt-4o',
      },
      ctx,
    );

    expect(result.isError).toBeUndefined();

    // Read the IPC file to verify providerConfig
    const tasksDir = path.join(tmpDir, 'tasks');
    const files = fs.readdirSync(tasksDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBe(1);

    const written = JSON.parse(fs.readFileSync(path.join(tasksDir, files[0]), 'utf-8'));
    expect(written.providerConfig).toBeDefined();
    expect(written.providerConfig.provider).toBe('openai');
    expect(written.providerConfig.model).toBe('gpt-4o');
  });

  test('without provider/model omits providerConfig', async () => {
    const tool = findTool('register_group');
    const ctx = makeCtx({ isMain: true });

    const result = await tool.handler(
      {
        jid: 'tg:-100555',
        name: 'Default Group',
        folder: 'default-group',
        trigger: '@Bot',
      },
      ctx,
    );

    expect(result.isError).toBeUndefined();

    const tasksDir = path.join(tmpDir, 'tasks');
    const files = fs.readdirSync(tasksDir).filter((f) => f.endsWith('.json'));
    const written = JSON.parse(fs.readFileSync(path.join(tasksDir, files[0]), 'utf-8'));
    expect(written.providerConfig).toBeUndefined();
  });
});

// ─── 7. list_tasks handler ───────────────────────────────────────────────────

describe('list_tasks handler', () => {
  let tmpDir: string;
  let origExistsSync: typeof fs.existsSync;
  let origReadFileSync: typeof fs.readFileSync;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-'));
    origExistsSync = fs.existsSync;
    origReadFileSync = fs.readFileSync;
  });

  afterEach(() => {
    (fs as any).existsSync = origExistsSync;
    (fs as any).readFileSync = origReadFileSync;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns "No scheduled tasks found" when no tasks file exists', async () => {
    // Redirect existsSync for the tasks file
    (fs as any).existsSync = (p: string) => {
      if (typeof p === 'string' && p.includes('current_tasks.json')) {
        return false;
      }
      return origExistsSync(p);
    };

    const tool = findTool('list_tasks');
    const ctx = makeCtx();

    const result = await tool.handler({}, ctx);

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('No scheduled tasks found.');
  });

  test('returns "No scheduled tasks found" when file exists but array is empty', async () => {
    const tasksFilePath = path.join(tmpDir, 'current_tasks.json');
    fs.writeFileSync(tasksFilePath, JSON.stringify([]));

    (fs as any).existsSync = (p: string) => {
      if (typeof p === 'string' && p.includes('current_tasks.json')) {
        return origExistsSync(tasksFilePath);
      }
      return origExistsSync(p);
    };

    (fs as any).readFileSync = (p: string, opts?: any) => {
      if (typeof p === 'string' && p.includes('current_tasks.json')) {
        return origReadFileSync(tasksFilePath, opts);
      }
      return origReadFileSync(p, opts);
    };

    const tool = findTool('list_tasks');
    const ctx = makeCtx({ isMain: true });

    const result = await tool.handler({}, ctx);

    expect(result.content).toBe('No scheduled tasks found.');
  });

  test('non-main group only sees own tasks', async () => {
    const tasks = [
      {
        id: 'task-1',
        prompt: 'Check weather for main group daily morning',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        status: 'active',
        next_run: '2026-02-08T09:00:00',
        groupFolder: 'main',
      },
      {
        id: 'task-2',
        prompt: 'Send weekly report for test-group on Monday',
        schedule_type: 'cron',
        schedule_value: '0 10 * * 1',
        status: 'active',
        next_run: '2026-02-10T10:00:00',
        groupFolder: 'test-group',
      },
    ];

    const tasksFilePath = path.join(tmpDir, 'current_tasks.json');
    fs.writeFileSync(tasksFilePath, JSON.stringify(tasks));

    (fs as any).existsSync = (p: string) => {
      if (typeof p === 'string' && p.includes('current_tasks.json')) {
        return true;
      }
      return origExistsSync(p);
    };

    (fs as any).readFileSync = (p: string, opts?: any) => {
      if (typeof p === 'string' && p.includes('current_tasks.json')) {
        return origReadFileSync(tasksFilePath, opts);
      }
      return origReadFileSync(p, opts);
    };

    const tool = findTool('list_tasks');
    const ctx = makeCtx({ isMain: false, groupFolder: 'test-group' });

    const result = await tool.handler({}, ctx);

    expect(result.content).toContain('task-2');
    expect(result.content).not.toContain('task-1');
  });

  test('main group sees all tasks', async () => {
    const tasks = [
      {
        id: 'task-1',
        prompt: 'Check weather for main group daily morning',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        status: 'active',
        next_run: '2026-02-08T09:00:00',
        groupFolder: 'main',
      },
      {
        id: 'task-2',
        prompt: 'Send weekly report for test-group on Monday',
        schedule_type: 'cron',
        schedule_value: '0 10 * * 1',
        status: 'active',
        next_run: '2026-02-10T10:00:00',
        groupFolder: 'test-group',
      },
    ];

    const tasksFilePath = path.join(tmpDir, 'current_tasks.json');
    fs.writeFileSync(tasksFilePath, JSON.stringify(tasks));

    (fs as any).existsSync = (p: string) => {
      if (typeof p === 'string' && p.includes('current_tasks.json')) {
        return true;
      }
      return origExistsSync(p);
    };

    (fs as any).readFileSync = (p: string, opts?: any) => {
      if (typeof p === 'string' && p.includes('current_tasks.json')) {
        return origReadFileSync(tasksFilePath, opts);
      }
      return origReadFileSync(p, opts);
    };

    const tool = findTool('list_tasks');
    const ctx = makeCtx({ isMain: true, groupFolder: 'main' });

    const result = await tool.handler({}, ctx);

    expect(result.content).toContain('task-1');
    expect(result.content).toContain('task-2');
    expect(result.content).toContain('Scheduled tasks:');
  });
});

// ─── Bonus: writeIpcFile helper ──────────────────────────────────────────────

describe('writeIpcFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ipc-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('creates directory and writes JSON atomically', () => {
    const subDir = path.join(tmpDir, 'nested', 'dir');
    const data = { foo: 'bar', count: 42 };

    const filename = writeIpcFile(subDir, data);

    expect(typeof filename).toBe('string');
    expect(filename.endsWith('.json')).toBe(true);

    const filepath = path.join(subDir, filename);
    expect(fs.existsSync(filepath)).toBe(true);

    const written = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    expect(written.foo).toBe('bar');
    expect(written.count).toBe(42);
  });

  test('no .tmp file remains after write', () => {
    const data = { test: true };
    const filename = writeIpcFile(tmpDir, data);

    const files = fs.readdirSync(tmpDir);
    const tmpFiles = files.filter((f) => f.endsWith('.tmp'));
    expect(tmpFiles.length).toBe(0);
    expect(files.length).toBe(1);
    expect(files[0]).toBe(filename);
  });
});

// ─── Bonus: resolveSupermemoryApiKey ─────────────────────────────────────────

describe('resolveSupermemoryApiKey', () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save and clear all supermemory env vars
    for (const key of SUPERMEMORY_KEY_ENV_VARS) {
      envBackup[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    // Restore
    for (const key of SUPERMEMORY_KEY_ENV_VARS) {
      if (envBackup[key] !== undefined) {
        process.env[key] = envBackup[key];
      } else {
        delete process.env[key];
      }
    }
  });

  test('returns null when no keys are set', () => {
    expect(resolveSupermemoryApiKey()).toBeNull();
  });

  test('returns first available key in priority order', () => {
    process.env.SUPERMEMORY_CC_API_KEY = 'cc-key';
    process.env.SUPERMEMORY_API_KEY = 'primary-key';

    const result = resolveSupermemoryApiKey();
    expect(result).not.toBeNull();
    expect(result!.key).toBe('primary-key');
    expect(result!.envVar).toBe('SUPERMEMORY_API_KEY');
  });

  test('falls back to second key when first is empty', () => {
    process.env.SUPERMEMORY_API_KEY = '';
    process.env.SUPERMEMORY_OPENCLAW_API_KEY = 'openclaw-key';

    const result = resolveSupermemoryApiKey();
    expect(result).not.toBeNull();
    expect(result!.key).toBe('openclaw-key');
    expect(result!.envVar).toBe('SUPERMEMORY_OPENCLAW_API_KEY');
  });

  test('trims whitespace from keys', () => {
    process.env.SUPERMEMORY_API_KEY = '  my-key  ';

    const result = resolveSupermemoryApiKey();
    expect(result).not.toBeNull();
    expect(result!.key).toBe('my-key');
  });
});
