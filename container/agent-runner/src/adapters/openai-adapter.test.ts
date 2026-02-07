/**
 * Tests for the OpenAI adapter.
 *
 * Focuses on what is testable without an API key:
 * - buildSystemPrompt() -- fully testable, no API needed
 * - MAX_ITERATIONS constant
 * - OpenAIAdapter instantiation and interface compliance
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { buildSystemPrompt, MAX_ITERATIONS, OpenAIAdapter } from './openai-adapter.js';
import { NANOCLAW_TOOLS } from '../tool-registry.js';
import type { AdapterInput, ProviderAdapter, IpcMcpContext } from '../types.js';

// -- Shared Fixtures --------------------------------------------------------

function makeMockCtx(overrides: Partial<IpcMcpContext> = {}): IpcMcpContext {
  return {
    chatJid: 'tg:-1001234567890',
    groupFolder: 'test-group',
    isMain: false,
    ...overrides,
  };
}

function makeMockInput(overrides: Partial<AdapterInput> = {}): AdapterInput {
  return {
    prompt: 'Hello, test!',
    groupFolder: 'test-group',
    isMain: false,
    ipcContext: makeMockCtx(),
    ...overrides,
  };
}

describe('openai-adapter', () => {
  // -- MAX_ITERATIONS -------------------------------------------------------

  describe('MAX_ITERATIONS', () => {
    test('is 50', () => {
      expect(MAX_ITERATIONS).toBe(50);
    });

    test('is a number', () => {
      expect(typeof MAX_ITERATIONS).toBe('number');
    });
  });

  // -- buildSystemPrompt() --------------------------------------------------

  describe('buildSystemPrompt()', () => {
    // We need to handle the fact that buildSystemPrompt reads from the filesystem
    // at /workspace/group/CLAUDE.md and /workspace/global/CLAUDE.md.
    // On the test machine those paths don't exist, so the fs.existsSync
    // calls return false and those sections are skipped. That's fine -- we
    // can still test the base identity and tool sections.

    test('includes the assistant name when provided', () => {
      const input = makeMockInput({ assistantName: 'TestBot' });
      const prompt = buildSystemPrompt(input);

      expect(prompt).toContain('TestBot');
    });

    test('uses "Andy" as the default assistant name when none provided', () => {
      const input = makeMockInput({ assistantName: undefined });
      const prompt = buildSystemPrompt(input);

      expect(prompt).toContain('You are Andy');
    });

    test('uses "Andy" when assistantName is empty string', () => {
      const input = makeMockInput({ assistantName: '' });
      const prompt = buildSystemPrompt(input);

      // Empty string is falsy, so it should fall back to 'Andy'
      expect(prompt).toContain('You are Andy');
    });

    test('includes "Available Tools" section', () => {
      const input = makeMockInput();
      const prompt = buildSystemPrompt(input);

      expect(prompt).toContain('## Available Tools');
      expect(prompt).toContain('You have access to the following tools');
    });

    test('includes tool descriptions for send_message', () => {
      const input = makeMockInput();
      const prompt = buildSystemPrompt(input);

      expect(prompt).toContain('send_message');
    });

    test('includes tool descriptions for schedule_task', () => {
      const input = makeMockInput();
      const prompt = buildSystemPrompt(input);

      expect(prompt).toContain('schedule_task');
    });

    test('includes tool descriptions for browse_navigate', () => {
      const input = makeMockInput();
      const prompt = buildSystemPrompt(input);

      expect(prompt).toContain('browse_navigate');
    });

    test('lists all NANOCLAW_TOOLS by name', () => {
      const input = makeMockInput();
      const prompt = buildSystemPrompt(input);

      for (const tool of NANOCLAW_TOOLS) {
        expect(prompt).toContain(tool.name);
      }
    });

    test('includes each tool description text', () => {
      const input = makeMockInput();
      const prompt = buildSystemPrompt(input);

      for (const tool of NANOCLAW_TOOLS) {
        // The description is included inline after the tool name
        expect(prompt).toContain(tool.description.slice(0, 40));
      }
    });

    test('returns a non-empty string', () => {
      const input = makeMockInput();
      const prompt = buildSystemPrompt(input);

      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(0);
    });

    test('starts with "You are" identity line', () => {
      const input = makeMockInput({ assistantName: 'Milo' });
      const prompt = buildSystemPrompt(input);

      expect(prompt.startsWith('You are Milo')).toBe(true);
    });

    // -- CLAUDE.md loading (filesystem-dependent) --

    describe('CLAUDE.md loading', () => {
      let tmpGroupDir: string;
      let tmpGlobalDir: string;
      let originalExistsSync: typeof fs.existsSync;
      let originalReadFileSync: typeof fs.readFileSync;

      beforeEach(() => {
        tmpGroupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-test-group-'));
        tmpGlobalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-test-global-'));

        originalExistsSync = fs.existsSync;
        originalReadFileSync = fs.readFileSync;
      });

      afterEach(() => {
        fs.existsSync = originalExistsSync;
        fs.readFileSync = originalReadFileSync;

        fs.rmSync(tmpGroupDir, { recursive: true, force: true });
        fs.rmSync(tmpGlobalDir, { recursive: true, force: true });
      });

      test('includes group CLAUDE.md content when file exists', () => {
        const groupClaudeMd = 'You should always be polite and helpful.';
        const groupFilePath = path.join(tmpGroupDir, 'CLAUDE.md');
        fs.writeFileSync(groupFilePath, groupClaudeMd);

        // Redirect /workspace/group/CLAUDE.md reads to our temp file
        const origExists = originalExistsSync.bind(fs);
        fs.existsSync = ((p: fs.PathLike) => {
          if (String(p) === '/workspace/group/CLAUDE.md') return true;
          return origExists(p);
        }) as typeof fs.existsSync;

        const origRead = originalReadFileSync.bind(fs);
        fs.readFileSync = ((p: fs.PathOrFileDescriptor, ...rest: any[]) => {
          if (String(p) === '/workspace/group/CLAUDE.md') {
            return (origRead as any)(groupFilePath, ...rest);
          }
          return (origRead as any)(p, ...rest);
        }) as typeof fs.readFileSync;

        const input = makeMockInput();
        const prompt = buildSystemPrompt(input);

        expect(prompt).toContain('## Instructions');
        expect(prompt).toContain(groupClaudeMd);
      });

      test('includes global CLAUDE.md for non-main groups when file exists', () => {
        const globalClaudeMd = 'Global rule: respond in English only.';
        const globalFilePath = path.join(tmpGlobalDir, 'CLAUDE.md');
        fs.writeFileSync(globalFilePath, globalClaudeMd);

        const origExists = originalExistsSync.bind(fs);
        fs.existsSync = ((p: fs.PathLike) => {
          if (String(p) === '/workspace/global/CLAUDE.md') return true;
          // Group CLAUDE.md does not exist in this test
          if (String(p) === '/workspace/group/CLAUDE.md') return false;
          return origExists(p);
        }) as typeof fs.existsSync;

        const origRead = originalReadFileSync.bind(fs);
        fs.readFileSync = ((p: fs.PathOrFileDescriptor, ...rest: any[]) => {
          if (String(p) === '/workspace/global/CLAUDE.md') {
            return (origRead as any)(globalFilePath, ...rest);
          }
          return (origRead as any)(p, ...rest);
        }) as typeof fs.readFileSync;

        const input = makeMockInput({ isMain: false });
        const prompt = buildSystemPrompt(input);

        expect(prompt).toContain('## Global Instructions');
        expect(prompt).toContain(globalClaudeMd);
      });

      test('does NOT include global CLAUDE.md for main group', () => {
        const globalClaudeMd = 'Global rule: respond in English only.';
        const globalFilePath = path.join(tmpGlobalDir, 'CLAUDE.md');
        fs.writeFileSync(globalFilePath, globalClaudeMd);

        const origExists = originalExistsSync.bind(fs);
        fs.existsSync = ((p: fs.PathLike) => {
          if (String(p) === '/workspace/global/CLAUDE.md') return true;
          if (String(p) === '/workspace/group/CLAUDE.md') return false;
          return origExists(p);
        }) as typeof fs.existsSync;

        const origRead = originalReadFileSync.bind(fs);
        fs.readFileSync = ((p: fs.PathOrFileDescriptor, ...rest: any[]) => {
          if (String(p) === '/workspace/global/CLAUDE.md') {
            return (origRead as any)(globalFilePath, ...rest);
          }
          return (origRead as any)(p, ...rest);
        }) as typeof fs.readFileSync;

        // isMain = true => global CLAUDE.md should NOT be loaded
        const input = makeMockInput({ isMain: true });
        const prompt = buildSystemPrompt(input);

        expect(prompt).not.toContain('## Global Instructions');
        expect(prompt).not.toContain(globalClaudeMd);
      });

      test('skips empty CLAUDE.md files gracefully', () => {
        const groupFilePath = path.join(tmpGroupDir, 'CLAUDE.md');
        fs.writeFileSync(groupFilePath, '   \n  ');  // whitespace only

        const origExists = originalExistsSync.bind(fs);
        fs.existsSync = ((p: fs.PathLike) => {
          if (String(p) === '/workspace/group/CLAUDE.md') return true;
          return origExists(p);
        }) as typeof fs.existsSync;

        const origRead = originalReadFileSync.bind(fs);
        fs.readFileSync = ((p: fs.PathOrFileDescriptor, ...rest: any[]) => {
          if (String(p) === '/workspace/group/CLAUDE.md') {
            return (origRead as any)(groupFilePath, ...rest);
          }
          return (origRead as any)(p, ...rest);
        }) as typeof fs.readFileSync;

        const input = makeMockInput();
        const prompt = buildSystemPrompt(input);

        // Empty/whitespace CLAUDE.md should not add an Instructions section
        expect(prompt).not.toContain('## Instructions');
      });
    });
  });

  // -- OpenAIAdapter class --------------------------------------------------

  describe('OpenAIAdapter', () => {
    test('can be instantiated', () => {
      const adapter = new OpenAIAdapter();
      expect(adapter).toBeDefined();
      expect(adapter).toBeInstanceOf(OpenAIAdapter);
    });

    test('has a run() method', () => {
      const adapter = new OpenAIAdapter();
      expect(typeof adapter.run).toBe('function');
    });

    test('run() returns an object with Symbol.asyncIterator (async generator)', () => {
      const adapter = new OpenAIAdapter();
      const input = makeMockInput();

      // Calling run() should produce an async generator.
      // We cannot actually iterate it without an API key, but we can verify
      // the returned object has the async iterator protocol.
      const generator = adapter.run(input);

      expect(generator).toBeDefined();
      expect(typeof generator[Symbol.asyncIterator]).toBe('function');
    });

    test('satisfies ProviderAdapter interface shape', () => {
      // TypeScript compile-time check: assign to ProviderAdapter type
      const adapter: ProviderAdapter = new OpenAIAdapter();
      expect(typeof adapter.run).toBe('function');
    });
  });
});
