/**
 * Tests for adapter dispatch (createAdapter) and preparePrompt().
 *
 * preparePrompt reads /workspace/group/SOUL.md which does not exist in the
 * test environment, so we monkey-patch fs.existsSync / fs.readFileSync to
 * simulate its presence or absence.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import type { ContainerInput, ProviderAdapter } from './types.js';
import { preparePrompt } from './index.js';
import { createAdapter } from './adapters/index.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<ContainerInput> = {}): ContainerInput {
  return {
    prompt: 'Hello, world!',
    groupFolder: 'test-group',
    chatJid: 'tg:-1001234567890',
    isMain: false,
    ...overrides,
  };
}

// ─── 1. preparePrompt — injects SOUL.md when present ─────────────────────────

describe('preparePrompt with SOUL.md present', () => {
  let origExistsSync: typeof fs.existsSync;
  let origReadFileSync: typeof fs.readFileSync;

  beforeEach(() => {
    origExistsSync = fs.existsSync;
    origReadFileSync = fs.readFileSync;

    (fs as any).existsSync = (p: string) => {
      if (typeof p === 'string' && p === '/workspace/group/SOUL.md') {
        return true;
      }
      return origExistsSync(p);
    };

    (fs as any).readFileSync = (p: string, opts?: any) => {
      if (typeof p === 'string' && p === '/workspace/group/SOUL.md') {
        return 'You are a pirate assistant. Always say "Arrr!".';
      }
      return origReadFileSync(p, opts);
    };
  });

  afterEach(() => {
    (fs as any).existsSync = origExistsSync;
    (fs as any).readFileSync = origReadFileSync;
  });

  test('wraps prompt with <soul> block containing SOUL.md content', () => {
    const input = makeInput({ prompt: 'What is the weather?' });
    const result = preparePrompt(input);

    expect(result).toContain('<soul>');
    expect(result).toContain('You are a pirate assistant');
    expect(result).toContain('</soul>');
    expect(result).toContain('What is the weather?');
  });

  test('does not include <soul_setup> when SOUL.md exists', () => {
    const input = makeInput({ isScheduledTask: false });
    const result = preparePrompt(input);

    expect(result).not.toContain('<soul_setup>');
  });

  test('soul block appears before the original prompt', () => {
    const input = makeInput({ prompt: 'Tell me a joke' });
    const result = preparePrompt(input);

    const soulIndex = result.indexOf('<soul>');
    const promptIndex = result.indexOf('Tell me a joke');
    expect(soulIndex).toBeLessThan(promptIndex);
  });
});

// ─── 2. preparePrompt — injects soul_setup when no SOUL.md and not scheduled ─

describe('preparePrompt without SOUL.md (non-scheduled)', () => {
  let origExistsSync: typeof fs.existsSync;

  beforeEach(() => {
    origExistsSync = fs.existsSync;

    (fs as any).existsSync = (p: string) => {
      if (typeof p === 'string' && p === '/workspace/group/SOUL.md') {
        return false;
      }
      return origExistsSync(p);
    };
  });

  afterEach(() => {
    (fs as any).existsSync = origExistsSync;
  });

  test('includes <soul_setup> block for non-scheduled tasks', () => {
    const input = makeInput({ isScheduledTask: false });
    const result = preparePrompt(input);

    expect(result).toContain('<soul_setup>');
    expect(result).toContain("You don't have a personality defined yet");
    expect(result).toContain('</soul_setup>');
  });

  test('soul_setup appears before the original prompt', () => {
    const input = makeInput({ prompt: 'Hi there', isScheduledTask: false });
    const result = preparePrompt(input);

    const setupIndex = result.indexOf('<soul_setup>');
    const promptIndex = result.indexOf('Hi there');
    expect(setupIndex).toBeLessThan(promptIndex);
  });
});

// ─── 3. preparePrompt — no soul_setup for scheduled tasks ────────────────────

describe('preparePrompt without SOUL.md (scheduled task)', () => {
  let origExistsSync: typeof fs.existsSync;

  beforeEach(() => {
    origExistsSync = fs.existsSync;

    (fs as any).existsSync = (p: string) => {
      if (typeof p === 'string' && p === '/workspace/group/SOUL.md') {
        return false;
      }
      return origExistsSync(p);
    };
  });

  afterEach(() => {
    (fs as any).existsSync = origExistsSync;
  });

  test('does NOT include <soul_setup> for scheduled tasks', () => {
    const input = makeInput({ isScheduledTask: true });
    const result = preparePrompt(input);

    expect(result).not.toContain('<soul_setup>');
  });
});

// ─── 4. preparePrompt — adds scheduled task prefix ───────────────────────────

describe('preparePrompt scheduled task prefix', () => {
  let origExistsSync: typeof fs.existsSync;

  beforeEach(() => {
    origExistsSync = fs.existsSync;

    (fs as any).existsSync = (p: string) => {
      if (typeof p === 'string' && p === '/workspace/group/SOUL.md') {
        return false;
      }
      return origExistsSync(p);
    };
  });

  afterEach(() => {
    (fs as any).existsSync = origExistsSync;
  });

  test('includes [SCHEDULED TASK prefix when isScheduledTask is true', () => {
    const input = makeInput({ isScheduledTask: true, prompt: 'Check weather' });
    const result = preparePrompt(input);

    expect(result).toContain('[SCHEDULED TASK');
    expect(result).toContain('running automatically');
    expect(result).toContain('mcp__nanoclaw__send_message');
  });

  test('scheduled task prefix appears before the original prompt content', () => {
    const input = makeInput({ isScheduledTask: true, prompt: 'Check weather' });
    const result = preparePrompt(input);

    const prefixIndex = result.indexOf('[SCHEDULED TASK');
    const promptIndex = result.indexOf('Check weather');
    expect(prefixIndex).toBeLessThan(promptIndex);
  });

  test('does NOT include [SCHEDULED TASK prefix when isScheduledTask is false', () => {
    const input = makeInput({ isScheduledTask: false, prompt: 'Hello' });
    const result = preparePrompt(input);

    expect(result).not.toContain('[SCHEDULED TASK');
  });

  test('does NOT include [SCHEDULED TASK prefix when isScheduledTask is undefined', () => {
    const input = makeInput({ prompt: 'Hello' });
    const result = preparePrompt(input);

    expect(result).not.toContain('[SCHEDULED TASK');
  });
});

// ─── 5-7. createAdapter dispatch ─────────────────────────────────────────────

describe('createAdapter dispatch', () => {
  test("createAdapter('anthropic') returns an adapter with a run method", () => {
    const adapter = createAdapter('anthropic');

    expect(adapter).toBeDefined();
    expect(typeof adapter.run).toBe('function');
  });

  test("createAdapter('openai') returns an adapter with a run method", () => {
    const adapter = createAdapter('openai');

    expect(adapter).toBeDefined();
    expect(typeof adapter.run).toBe('function');
  });

  test('default case (unknown provider) returns an adapter with a run method', () => {
    const adapter = createAdapter('some-unknown-provider');

    expect(adapter).toBeDefined();
    expect(typeof adapter.run).toBe('function');
  });

  test("'anthropic' and 'openai' return different adapter types", () => {
    const anthropicAdapter = createAdapter('anthropic');
    const openaiAdapter = createAdapter('openai');

    expect(anthropicAdapter.constructor.name).not.toBe(openaiAdapter.constructor.name);
  });

  test("'anthropic' adapter is ClaudeAdapter", () => {
    const adapter = createAdapter('anthropic');
    expect(adapter.constructor.name).toBe('ClaudeAdapter');
  });

  test("'openai' adapter is OpenAIAdapter", () => {
    const adapter = createAdapter('openai');
    expect(adapter.constructor.name).toBe('OpenAIAdapter');
  });

  test('default fallback is ClaudeAdapter', () => {
    const adapter = createAdapter('anything-else');
    expect(adapter.constructor.name).toBe('ClaudeAdapter');
  });
});

// ─── 8. ContainerInput with provider field ───────────────────────────────────

describe('ContainerInput type with provider/model', () => {
  test('ContainerInput accepts provider and model fields', () => {
    const input: ContainerInput = {
      prompt: 'Hello',
      groupFolder: 'test',
      chatJid: 'tg:-100',
      isMain: false,
      provider: 'openai',
      model: 'gpt-4o',
    };

    expect(input.provider).toBe('openai');
    expect(input.model).toBe('gpt-4o');
  });

  test('ContainerInput works without provider and model (optional fields)', () => {
    const input: ContainerInput = {
      prompt: 'Hello',
      groupFolder: 'test',
      chatJid: 'tg:-100',
      isMain: false,
    };

    expect(input.provider).toBeUndefined();
    expect(input.model).toBeUndefined();
  });

  test('ContainerInput with all fields populated', () => {
    const input: ContainerInput = {
      prompt: 'Run task',
      sessionId: 'session-abc-123',
      groupFolder: 'main',
      chatJid: 'tg:-100999',
      isMain: true,
      isScheduledTask: true,
      assistantName: 'Andy',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
    };

    expect(input.prompt).toBe('Run task');
    expect(input.sessionId).toBe('session-abc-123');
    expect(input.groupFolder).toBe('main');
    expect(input.chatJid).toBe('tg:-100999');
    expect(input.isMain).toBe(true);
    expect(input.isScheduledTask).toBe(true);
    expect(input.assistantName).toBe('Andy');
    expect(input.provider).toBe('anthropic');
    expect(input.model).toBe('claude-sonnet-4-20250514');
  });
});
