/**
 * Tests for OpenAI tool bridge (Zod-to-JSON-Schema conversion and execution routing).
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { buildOpenAITools, executeNanoTool } from './openai-tools.js';
import { NANOCLAW_TOOLS } from '../tool-registry.js';
import type { IpcMcpContext } from '../types.js';

// ─── Shared Fixtures ─────────────────────────────────────────────────────────

function makeMockCtx(overrides: Partial<IpcMcpContext> = {}): IpcMcpContext {
  return {
    chatJid: 'tg:-1001234567890',
    groupFolder: 'test-group',
    isMain: false,
    ...overrides,
  };
}

describe('openai-tools', () => {
  // ─── buildOpenAITools() ──────────────────────────────────────────────────

  describe('buildOpenAITools()', () => {
    const tools = buildOpenAITools();

    test('returns an array', () => {
      expect(Array.isArray(tools)).toBe(true);
    });

    test('each element has type "function" with name, description, and parameters', () => {
      for (const tool of tools) {
        expect(tool.type).toBe('function');
        expect(typeof tool.function.name).toBe('string');
        expect(tool.function.name.length).toBeGreaterThan(0);
        expect(typeof tool.function.description).toBe('string');
        expect(tool.function.description.length).toBeGreaterThan(0);
        expect(typeof tool.function.parameters).toBe('object');
        expect(tool.function.parameters).not.toBeNull();
      }
    });

    test('tool count matches NANOCLAW_TOOLS length', () => {
      expect(tools.length).toBe(NANOCLAW_TOOLS.length);
    });

    test('tool names match NANOCLAW_TOOLS names in order', () => {
      const openaiNames = tools.map((t) => t.function.name);
      const registryNames = NANOCLAW_TOOLS.map((t) => t.name);
      expect(openaiNames).toEqual(registryNames);
    });

    test('each tool parameters has valid JSON Schema shape (type "object" with properties)', () => {
      for (const tool of tools) {
        const params = tool.function.parameters as Record<string, unknown>;
        expect(params.type).toBe('object');
        expect(typeof params.properties).toBe('object');
        expect(params.properties).not.toBeNull();
      }
    });

    test('no tool parameters contain the $schema meta key', () => {
      for (const tool of tools) {
        const params = tool.function.parameters as Record<string, unknown>;
        expect(params).not.toHaveProperty('$schema');
      }
    });
  });

  // ─── send_message schema ───────────────────────────────────────────────

  describe('send_message schema', () => {
    test('has "text" property typed as string', () => {
      const tools = buildOpenAITools();
      const sendMsg = tools.find((t) => t.function.name === 'send_message');

      expect(sendMsg).toBeDefined();

      const params = sendMsg!.function.parameters as Record<string, unknown>;
      const properties = params.properties as Record<string, unknown>;

      expect(properties).toHaveProperty('text');

      const textProp = properties.text as Record<string, unknown>;
      expect(textProp.type).toBe('string');
    });

    test('has "text" listed as required', () => {
      const tools = buildOpenAITools();
      const sendMsg = tools.find((t) => t.function.name === 'send_message');

      const params = sendMsg!.function.parameters as Record<string, unknown>;
      const required = params.required as string[] | undefined;

      // Zod required fields should appear in the "required" array
      expect(required).toBeDefined();
      expect(required).toContain('text');
    });
  });

  // ─── executeNanoTool() ────────────────────────────────────────────────

  describe('executeNanoTool()', () => {
    let tmpDir: string;
    let originalMkdirSync: typeof fs.mkdirSync;
    let originalWriteFileSync: typeof fs.writeFileSync;
    let originalRenameSync: typeof fs.renameSync;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-tools-test-'));

      // Monkey-patch fs so writeIpcFile writes to our temp dir instead of /workspace/ipc
      originalMkdirSync = fs.mkdirSync;
      originalWriteFileSync = fs.writeFileSync;
      originalRenameSync = fs.renameSync;

      const origMkdir = fs.mkdirSync.bind(fs);
      fs.mkdirSync = ((dir: string, opts?: any) => {
        if (typeof dir === 'string' && dir.startsWith('/workspace/ipc')) {
          const redirected = dir.replace('/workspace/ipc', tmpDir);
          return origMkdir(redirected, opts);
        }
        return origMkdir(dir, opts);
      }) as typeof fs.mkdirSync;

      const origWriteFile = fs.writeFileSync.bind(fs);
      fs.writeFileSync = ((filePath: string, ...rest: any[]) => {
        if (typeof filePath === 'string' && filePath.startsWith('/workspace/ipc')) {
          const redirected = filePath.replace('/workspace/ipc', tmpDir);
          return (origWriteFile as any)(redirected, ...rest);
        }
        return (origWriteFile as any)(filePath, ...rest);
      }) as typeof fs.writeFileSync;

      const origRename = fs.renameSync.bind(fs);
      fs.renameSync = ((src: string, dest: string) => {
        const newSrc = typeof src === 'string' && src.startsWith('/workspace/ipc')
          ? src.replace('/workspace/ipc', tmpDir)
          : src;
        const newDest = typeof dest === 'string' && dest.startsWith('/workspace/ipc')
          ? dest.replace('/workspace/ipc', tmpDir)
          : dest;
        return origRename(newSrc, newDest);
      }) as typeof fs.renameSync;
    });

    afterEach(() => {
      // Restore original fs functions
      fs.mkdirSync = originalMkdirSync;
      fs.writeFileSync = originalWriteFileSync;
      fs.renameSync = originalRenameSync;

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('routes send_message and returns a string result', async () => {
      const ctx = makeMockCtx();
      const result = await executeNanoTool(
        'send_message',
        { text: 'Hello from test!' },
        ctx,
      );

      expect(typeof result).toBe('string');
      expect(result).toContain('Message queued for delivery');
    });

    test('send_message writes an IPC file to the messages directory', async () => {
      const ctx = makeMockCtx();
      await executeNanoTool('send_message', { text: 'Test IPC write' }, ctx);

      const messagesDir = path.join(tmpDir, 'messages');
      const files = fs.readdirSync(messagesDir);
      expect(files.length).toBe(1);

      const content = JSON.parse(
        fs.readFileSync(path.join(messagesDir, files[0]), 'utf-8'),
      );
      expect(content.type).toBe('message');
      expect(content.text).toBe('Test IPC write');
      expect(content.chatJid).toBe('tg:-1001234567890');
      expect(content.groupFolder).toBe('test-group');
    });

    test('returns error JSON string for unknown tool', async () => {
      const ctx = makeMockCtx();
      const result = await executeNanoTool(
        'nonexistent_tool',
        {},
        ctx,
      );

      expect(typeof result).toBe('string');

      const parsed = JSON.parse(result);
      expect(parsed).toHaveProperty('error');
      expect(parsed.error).toContain('Unknown tool');
      expect(parsed.error).toContain('nonexistent_tool');
    });

    test('trims whitespace around tool names before lookup', async () => {
      const ctx = makeMockCtx();
      const result = await executeNanoTool(
        '  send_message  ',
        { text: 'Trimmed tool call' },
        ctx,
      );

      expect(typeof result).toBe('string');
      expect(result).toContain('Message queued for delivery');
    });

    test('returns error string when handler throws', async () => {
      // schedule_task with invalid cron should return an isError result,
      // but we want to test the catch path. We can trigger it by calling
      // list_tasks which reads from a file that does not exist in our env.
      // Actually list_tasks handles that gracefully. Instead, let's test
      // with a tool that will have a handler error via bad fs access.
      // The simplest approach: temporarily break mkdirSync to force an error.
      const brokenMkdir = fs.mkdirSync;
      fs.mkdirSync = (() => {
        throw new Error('Simulated disk failure');
      }) as typeof fs.mkdirSync;

      const ctx = makeMockCtx();
      const result = await executeNanoTool(
        'send_message',
        { text: 'Will fail' },
        ctx,
      );

      // Restore before assertions (in case of assertion failure)
      fs.mkdirSync = brokenMkdir;

      expect(typeof result).toBe('string');
      expect(result).toContain('Tool execution error');
      expect(result).toContain('Simulated disk failure');
    });
  });
});
