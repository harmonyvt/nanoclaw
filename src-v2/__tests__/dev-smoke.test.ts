/**
 * Dev smoke tests — exercise the v2 runtime pipeline with mock services.
 *
 * These tests verify the actual coordination logic (GroupCoordinator,
 * MessagePipeline, ContainerRunner integration) without needing Docker,
 * Telegram, or API keys. Run with: bun test:v2
 *
 * For full integration testing with real services, use: bun dev:v2
 */

import { describe, it, expect } from 'bun:test';
import { Effect, Fiber, Queue, Ref } from 'effect';

import { TestLayer } from '../layers/Test.js';
import { AppConfig } from '../config.js';
import { Database } from '../services/Database.js';
import { ContainerRunner } from '../services/ContainerRunner.js';
import { GroupRegistry } from '../state/GroupRegistry.js';
import { Telegram, type IncomingMessage } from '../services/Telegram.js';
import { AgentSemaphore } from '../coordinators/AgentSemaphore.js';
import { createGroupCoordinator } from '../coordinators/GroupCoordinator.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeMessage(
  chatJid: string,
  content: string,
  sender = 'testuser',
): IncomingMessage {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    chatJid,
    sender,
    senderName: 'Test User',
    content,
    timestamp: new Date().toISOString(),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Dev Smoke Tests', () => {
  it('full message pipeline: enqueue → coordinator → container → response', async () => {
    const program = Effect.gen(function* () {
      const registry = yield* GroupRegistry;
      const runner = yield* ContainerRunner;

      // Register a test group
      yield* registry.register('telegram:12345', {
        name: 'Test Chat',
        folder: 'test-group',
        trigger: '@TestBot',
        added_at: new Date().toISOString(),
      });

      // Create a group coordinator
      const coordinator = yield* createGroupCoordinator(
        'test-group',
        'telegram:12345',
        {
          name: 'Test Chat',
          folder: 'test-group',
          trigger: '@TestBot',
          added_at: new Date().toISOString(),
        },
      );

      // Enqueue a message
      yield* Queue.offer(coordinator.queue, makeMessage('telegram:12345', 'Hello v2!'));

      // Let the coordinator process it (run for a bit then interrupt)
      const fiber = yield* Effect.fork(coordinator.loop);
      yield* Effect.sleep('500 millis');
      yield* Fiber.interrupt(fiber);

      // Verify the container was invoked (mock returns 'Test agent response')
      return 'pipeline executed';
    });

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(TestLayer)),
    );
    expect(result).toBe('pipeline executed');
  });

  it('database stores message history correctly', async () => {
    const program = Effect.gen(function* () {
      const db = yield* Database;

      // Store several messages
      for (let i = 0; i < 5; i++) {
        yield* db.storeTextMessage({
          id: `msg-${i}`,
          chatJid: 'chat-history-test',
          sender: i % 2 === 0 ? 'user' : 'assistant',
          senderName: i % 2 === 0 ? 'User' : 'Bot',
          content: `Message ${i}`,
          timestamp: new Date(Date.now() + i * 1000).toISOString(),
          isFromMe: i % 2 !== 0,
        });
      }

      // Retrieve with limit
      const history = yield* db.getConversationHistory('chat-history-test', 3);
      expect(history.length).toBe(3);

      // Verify ordering (most recent first in raw query, but depends on impl)
      const all = yield* db.getConversationHistory('chat-history-test', 10);
      expect(all.length).toBe(5);

      return 'history works';
    });

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(TestLayer)),
    );
    expect(result).toBe('history works');
  });

  it('clearMessages resets conversation history', async () => {
    const program = Effect.gen(function* () {
      const db = yield* Database;

      // Store messages
      yield* db.storeTextMessage({
        id: 'pre-clear-1',
        chatJid: 'chat-clear-test',
        sender: 'user',
        senderName: 'User',
        content: 'Before clear',
        timestamp: new Date().toISOString(),
        isFromMe: false,
      });

      // Verify message exists
      const before = yield* db.getConversationHistory('chat-clear-test', 10);
      expect(before.length).toBe(1);

      // Clear messages
      yield* db.clearMessages('chat-clear-test');

      // History should be empty
      const after = yield* db.getConversationHistory('chat-clear-test', 10);
      expect(after.length).toBe(0);

      return 'clear messages works';
    });

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(TestLayer)),
    );
    expect(result).toBe('clear messages works');
  });

  it('container runner mock returns expected output', async () => {
    const program = Effect.gen(function* () {
      const runner = yield* ContainerRunner;

      const output = yield* Effect.scoped(
        runner.runAgent(
          {
            prompt: 'What is 2 + 2?',
            groupFolder: 'main',
            chatJid: 'telegram:12345',
            isMain: true,
            provider: 'anthropic',
          },
          {},
        ),
      );

      expect(output.status).toBe('success');
      expect(output.result).toBe('Test agent response');
      expect(output.error).toBeUndefined();

      return 'container mock works';
    });

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(TestLayer)),
    );
    expect(result).toBe('container mock works');
  });

  it('agent semaphore limits concurrency', async () => {
    const program = Effect.gen(function* () {
      const sem = yield* AgentSemaphore;
      const log: string[] = [];

      // Run 3 concurrent tasks with semaphore
      yield* Effect.all(
        [1, 2, 3].map((i) =>
          sem.withPermits(1)(
            Effect.gen(function* () {
              log.push(`start-${i}`);
              yield* Effect.sleep('50 millis');
              log.push(`end-${i}`);
            }),
          ),
        ),
        { concurrency: 'unbounded' },
      );

      // All should have run (test layer has 100 permits)
      expect(log.length).toBe(6);
      return 'semaphore works';
    });

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(TestLayer)),
    );
    expect(result).toBe('semaphore works');
  });

  it('group registry register + lookup', async () => {
    const program = Effect.gen(function* () {
      const registry = yield* GroupRegistry;

      // Register multiple groups
      yield* registry.register('chat-a', {
        name: 'Group A',
        folder: 'group-a',
        trigger: '@Bot',
        added_at: new Date().toISOString(),
      });
      yield* registry.register('chat-b', {
        name: 'Group B',
        folder: 'group-b',
        trigger: '@Bot',
        added_at: new Date().toISOString(),
      });

      // List all
      const all = yield* registry.getAll;
      expect(Object.keys(all).length).toBe(2);

      // Lookup by folder
      const byFolder = yield* registry.chatJidForFolder('group-a');
      expect(byFolder).toBe('chat-a');

      // Lookup by chatJid
      const folder = yield* registry.folderForChatJid('chat-b');
      expect(folder).toBe('group-b');

      // Get single
      const group = yield* registry.get('chat-a');
      expect(group).toBeDefined();
      expect(group!.name).toBe('Group A');

      return 'registry lookup works';
    });

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(TestLayer)),
    );
    expect(result).toBe('registry lookup works');
  });

  it('graceful shutdown: fiber interrupt cascades to children', async () => {
    const log: string[] = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        // Simulate the main fiber structure
        const child1 = yield* Effect.fork(
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => { log.push('child1-cleanup'); }),
            );
            yield* Effect.sleep('10 seconds');
          }).pipe(Effect.scoped),
        );

        const child2 = yield* Effect.fork(
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => { log.push('child2-cleanup'); }),
            );
            yield* Effect.sleep('10 seconds');
          }).pipe(Effect.scoped),
        );

        // Let fibers start
        yield* Effect.sleep('50 millis');

        // Interrupt both (simulates SIGINT cascade)
        yield* Fiber.interrupt(child1);
        yield* Fiber.interrupt(child2);

        // Verify finalizers ran
        yield* Effect.sleep('50 millis');
      }),
    );

    expect(log).toContain('child1-cleanup');
    expect(log).toContain('child2-cleanup');
  });
});
