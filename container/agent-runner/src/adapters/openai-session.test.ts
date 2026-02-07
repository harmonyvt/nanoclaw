/**
 * Tests for OpenAI session management module.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  generateSessionId,
  loadHistory,
  saveHistory,
  MAX_MESSAGES,
  type SessionMessage,
} from './openai-session.js';

describe('openai-session', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-session-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── generateSessionId ──────────────────────────────────────────────────────

  describe('generateSessionId()', () => {
    test('produces a string starting with "openai-"', () => {
      const id = generateSessionId();
      expect(typeof id).toBe('string');
      expect(id.startsWith('openai-')).toBe(true);
    });

    test('two calls produce different IDs', () => {
      const id1 = generateSessionId();
      const id2 = generateSessionId();
      expect(id1).not.toBe(id2);
    });
  });

  // ─── saveHistory ────────────────────────────────────────────────────────────

  describe('saveHistory()', () => {
    test('creates a file in the sessions directory', () => {
      const sessionId = 'test-save-create';
      const messages: SessionMessage[] = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello' },
      ];

      saveHistory(sessionId, messages, tmpDir);

      const filePath = path.join(tmpDir, `${sessionId}.json`);
      expect(fs.existsSync(filePath)).toBe(true);
    });
  });

  // ─── loadHistory ────────────────────────────────────────────────────────────

  describe('loadHistory()', () => {
    test('reads back saved messages', () => {
      const sessionId = 'test-load-roundtrip';
      const messages: SessionMessage[] = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hi there' },
        { role: 'assistant', content: 'Hello! How can I help?' },
      ];

      saveHistory(sessionId, messages, tmpDir);
      const loaded = loadHistory(sessionId, tmpDir);

      expect(loaded).toEqual(messages);
    });

    test('returns empty array for a non-existent sessionId', () => {
      const loaded = loadHistory('does-not-exist', tmpDir);
      expect(loaded).toEqual([]);
    });

    test('returns empty array for undefined sessionId', () => {
      const loaded = loadHistory(undefined, tmpDir);
      expect(loaded).toEqual([]);
    });
  });

  // ─── History trimming ──────────────────────────────────────────────────────

  describe('history trimming', () => {
    test('trims to MAX_MESSAGES, preserving first (system) message', () => {
      const sessionId = 'test-trimming';
      const overflow = 20;
      const totalMessages = MAX_MESSAGES + overflow;

      // Build a large message array: system + (MAX_MESSAGES + overflow - 1) user/assistant pairs
      const messages: SessionMessage[] = [
        { role: 'system', content: 'System prompt' },
      ];
      for (let i = 1; i < totalMessages; i++) {
        messages.push({
          role: i % 2 === 1 ? 'user' : 'assistant',
          content: `Message ${i}`,
        });
      }

      expect(messages.length).toBe(totalMessages);

      saveHistory(sessionId, messages, tmpDir);
      const loaded = loadHistory(sessionId, tmpDir);

      // Should be trimmed to exactly MAX_MESSAGES
      expect(loaded.length).toBe(MAX_MESSAGES);

      // First message must be the original system message
      expect(loaded[0]).toEqual({ role: 'system', content: 'System prompt' });

      // The remaining messages should be the last (MAX_MESSAGES - 1) from the original
      const expectedTail = messages.slice(-(MAX_MESSAGES - 1));
      expect(loaded.slice(1)).toEqual(expectedTail);
    });
  });

  // ─── Round-trip integrity ──────────────────────────────────────────────────

  describe('round-trip integrity', () => {
    test('preserves messages with various roles and fields exactly', () => {
      const sessionId = 'test-roundtrip-integrity';
      const messages: SessionMessage[] = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Call the weather tool for NYC.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_abc123',
              type: 'function',
              function: {
                name: 'get_weather',
                arguments: '{"location":"NYC"}',
              },
            },
          ],
        },
        {
          role: 'tool',
          content: '{"temperature":72,"condition":"sunny"}',
          tool_call_id: 'call_abc123',
        },
        {
          role: 'assistant',
          content: 'The weather in NYC is 72 degrees and sunny.',
        },
      ];

      saveHistory(sessionId, messages, tmpDir);
      const loaded = loadHistory(sessionId, tmpDir);

      expect(loaded).toEqual(messages);
    });
  });
});
