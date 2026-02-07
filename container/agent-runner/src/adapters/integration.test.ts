/**
 * Integration tests for the adapter factory system.
 *
 * Validates that createAdapter() returns the correct adapter instances,
 * that both adapters conform to the ProviderAdapter interface, and that
 * ContainerInput maps correctly to AdapterInput.
 */

import { describe, test, expect } from 'bun:test';
import { createAdapter } from './index.js';
import { ClaudeAdapter } from './claude-adapter.js';
import { OpenAIAdapter } from './openai-adapter.js';
import type { AdapterInput, ContainerInput } from '../types.js';

// ─── Shared Fixtures ─────────────────────────────────────────────────────────

function makeMockAdapterInput(overrides: Partial<AdapterInput> = {}): AdapterInput {
  return {
    prompt: 'test',
    groupFolder: 'test',
    isMain: false,
    ipcContext: { chatJid: 'test', groupFolder: 'test', isMain: false },
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('adapter integration', () => {
  // ─── createAdapter() factory ──────────────────────────────────────────────

  describe('createAdapter() factory', () => {
    test('createAdapter("anthropic") returns a ClaudeAdapter instance', () => {
      const adapter = createAdapter('anthropic');
      expect(adapter).toBeInstanceOf(ClaudeAdapter);
    });

    test('createAdapter("openai") returns an OpenAIAdapter instance', () => {
      const adapter = createAdapter('openai');
      expect(adapter).toBeInstanceOf(OpenAIAdapter);
    });

    test('default provider is ClaudeAdapter for unknown provider strings', () => {
      const adapter = createAdapter('anything-unknown');
      expect(adapter).toBeInstanceOf(ClaudeAdapter);
    });

    test('handles all known providers without throwing', () => {
      expect(() => createAdapter('anthropic')).not.toThrow();
      expect(() => createAdapter('openai')).not.toThrow();
    });
  });

  // ─── ProviderAdapter interface conformance ────────────────────────────────

  describe('ProviderAdapter interface conformance', () => {
    test('ClaudeAdapter has a run() method', () => {
      const adapter = createAdapter('anthropic');
      expect(typeof adapter.run).toBe('function');
    });

    test('OpenAIAdapter has a run() method', () => {
      const adapter = createAdapter('openai');
      expect(typeof adapter.run).toBe('function');
    });

    test('OpenAIAdapter.run() returns an AsyncGenerator', () => {
      const adapter = createAdapter('openai');
      const input = makeMockAdapterInput();

      const generator = adapter.run(input);

      // AsyncGenerators expose Symbol.asyncIterator and a next() method
      expect(typeof generator[Symbol.asyncIterator]).toBe('function');
      expect(typeof generator.next).toBe('function');
      expect(typeof generator.return).toBe('function');
      expect(typeof generator.throw).toBe('function');
    });
  });

  // ─── ContainerInput to AdapterInput mapping ───────────────────────────────

  describe('ContainerInput to AdapterInput mapping', () => {
    test('maps ContainerInput fields to AdapterInput correctly', () => {
      const containerInput: ContainerInput = {
        prompt: 'hello',
        groupFolder: 'main',
        chatJid: 'tg:123',
        isMain: true,
        provider: 'openai',
        model: 'gpt-4o',
      };

      const adapterInput: AdapterInput = {
        prompt: containerInput.prompt,
        sessionId: containerInput.sessionId,
        model: containerInput.model,
        groupFolder: containerInput.groupFolder,
        isMain: containerInput.isMain,
        ipcContext: {
          chatJid: containerInput.chatJid,
          groupFolder: containerInput.groupFolder,
          isMain: containerInput.isMain,
        },
      };

      expect(adapterInput.prompt).toBe('hello');
      expect(adapterInput.model).toBe('gpt-4o');
      expect(adapterInput.groupFolder).toBe('main');
      expect(adapterInput.isMain).toBe(true);
      expect(adapterInput.sessionId).toBeUndefined();
      expect(adapterInput.ipcContext.chatJid).toBe('tg:123');
      expect(adapterInput.ipcContext.groupFolder).toBe('main');
      expect(adapterInput.ipcContext.isMain).toBe(true);
    });

    test('maps optional ContainerInput fields when present', () => {
      const containerInput: ContainerInput = {
        prompt: 'scheduled task',
        groupFolder: 'alerts',
        chatJid: 'tg:456',
        isMain: false,
        isScheduledTask: true,
        assistantName: 'Buddy',
        sessionId: 'sess-abc-123',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
      };

      const adapterInput: AdapterInput = {
        prompt: containerInput.prompt,
        sessionId: containerInput.sessionId,
        model: containerInput.model,
        groupFolder: containerInput.groupFolder,
        isMain: containerInput.isMain,
        isScheduledTask: containerInput.isScheduledTask,
        assistantName: containerInput.assistantName,
        ipcContext: {
          chatJid: containerInput.chatJid,
          groupFolder: containerInput.groupFolder,
          isMain: containerInput.isMain,
        },
      };

      expect(adapterInput.sessionId).toBe('sess-abc-123');
      expect(adapterInput.model).toBe('claude-sonnet-4-20250514');
      expect(adapterInput.isScheduledTask).toBe(true);
      expect(adapterInput.assistantName).toBe('Buddy');
      expect(adapterInput.ipcContext.isMain).toBe(false);
    });

    test('provider field from ContainerInput selects the correct adapter', () => {
      const openaiInput: ContainerInput = {
        prompt: 'test',
        groupFolder: 'g',
        chatJid: 'c',
        isMain: false,
        provider: 'openai',
      };

      const claudeInput: ContainerInput = {
        prompt: 'test',
        groupFolder: 'g',
        chatJid: 'c',
        isMain: false,
        provider: 'anthropic',
      };

      const openaiAdapter = createAdapter(openaiInput.provider!);
      const claudeAdapter = createAdapter(claudeInput.provider!);

      expect(openaiAdapter).toBeInstanceOf(OpenAIAdapter);
      expect(claudeAdapter).toBeInstanceOf(ClaudeAdapter);
    });
  });
});
