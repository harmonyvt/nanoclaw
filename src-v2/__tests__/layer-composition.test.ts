/**
 * Verify that the TestLayer composes without missing dependencies.
 *
 * This catches the most common Layer bug: a service that requires a
 * dependency not provided in the composed layer.
 */

import { describe, it, expect } from 'bun:test';
import { Effect, Layer } from 'effect';

import { TestLayer } from '../layers/Test.js';
import { AppConfig } from '../config.js';
import { Database } from '../services/Database.js';
import { Docker } from '../services/Docker.js';
import { Credentials } from '../services/Credentials.js';
import { Telegram } from '../services/Telegram.js';
import { ContainerRunner } from '../services/ContainerRunner.js';
import { GroupRegistry } from '../state/GroupRegistry.js';
import { Scheduler } from '../services/Scheduler.js';
import { Sandbox } from '../services/Sandbox.js';
import { BrowseHost } from '../services/BrowseHost.js';
import { TTS } from '../services/TTS.js';
import { Supermemory } from '../services/Supermemory.js';
import { Media } from '../services/Media.js';
import { AgentSemaphore } from '../coordinators/AgentSemaphore.js';

describe('Layer Composition', () => {
  it('TestLayer provides all services without errors', async () => {
    const program = Effect.gen(function* () {
      // Access every service tag to ensure they resolve
      const config = yield* AppConfig;
      expect(config.assistantName).toBe('TestBot');

      const db = yield* Database;
      expect(db).toBeDefined();

      const docker = yield* Docker;
      expect(docker).toBeDefined();

      const creds = yield* Credentials;
      expect(creds).toBeDefined();

      const telegram = yield* Telegram;
      expect(telegram).toBeDefined();

      const runner = yield* ContainerRunner;
      expect(runner).toBeDefined();

      const registry = yield* GroupRegistry;
      expect(registry).toBeDefined();

      const scheduler = yield* Scheduler;
      expect(scheduler).toBeDefined();

      const sandbox = yield* Sandbox;
      expect(sandbox).toBeDefined();

      const browseHost = yield* BrowseHost;
      expect(browseHost).toBeDefined();

      const tts = yield* TTS;
      expect(tts).toBeDefined();

      const memory = yield* Supermemory;
      expect(memory).toBeDefined();

      const media = yield* Media;
      expect(media).toBeDefined();

      const semaphore = yield* AgentSemaphore;
      expect(semaphore).toBeDefined();
    });

    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)));
  });

  it('Database service stores and retrieves messages', async () => {
    const program = Effect.gen(function* () {
      const db = yield* Database;

      yield* db.storeTextMessage({
        id: 'msg-1',
        chatJid: 'chat-1',
        sender: 'user',
        senderName: 'Test User',
        content: 'Hello world',
        timestamp: new Date().toISOString(),
        isFromMe: false,
      });

      const history = yield* db.getConversationHistory('chat-1', 10);
      expect(history.length).toBe(1);
      expect(history[0].content).toBe('Hello world');
      expect(history[0].sender_name).toBe('Test User');
    });

    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)));
  });

  it('GroupRegistry stores and retrieves groups', async () => {
    const program = Effect.gen(function* () {
      const registry = yield* GroupRegistry;

      yield* registry.register('chat-100', {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@TestBot',
        added_at: new Date().toISOString(),
      });

      const group = yield* registry.get('chat-100');
      expect(group).toBeDefined();
      expect(group!.name).toBe('Test Group');
      expect(group!.folder).toBe('test-group');

      const folder = yield* registry.folderForChatJid('chat-100');
      expect(folder).toBe('test-group');

      const chatJid = yield* registry.chatJidForFolder('test-group');
      expect(chatJid).toBe('chat-100');
    });

    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)));
  });

  it('Docker service reports as running', async () => {
    const program = Effect.gen(function* () {
      const docker = yield* Docker;
      const running = yield* docker.isRunning;
      expect(running).toBe(true);
    });

    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)));
  });

  it('Credentials resolves test credentials', async () => {
    const program = Effect.gen(function* () {
      const creds = yield* Credentials;
      const result = yield* creds.resolve;
      expect(result.source).toBe('dotenv');
      expect(result.authType).toBe('api-key');
      expect(result.envVars.ANTHROPIC_API_KEY).toBe('test-api-key');
    });

    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)));
  });

  it('ContainerRunner runAgent returns test output', async () => {
    const program = Effect.gen(function* () {
      const runner = yield* ContainerRunner;
      const output = yield* Effect.scoped(
        runner.runAgent(
          {
            prompt: 'test',
            groupFolder: 'main',
            chatJid: 'chat-1',
            isMain: true,
          },
          {},
        ),
      );
      expect(output.status).toBe('success');
      expect(output.result).toBe('Test agent response');
    });

    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)));
  });

  it('AgentSemaphore allows concurrent access', async () => {
    const program = Effect.gen(function* () {
      const sem = yield* AgentSemaphore;
      // Should be able to acquire many permits (100 available)
      const result = yield* sem.withPermits(4)(Effect.succeed('ok'));
      expect(result).toBe('ok');
    });

    await Effect.runPromise(program.pipe(Effect.provide(TestLayer)));
  });
});
