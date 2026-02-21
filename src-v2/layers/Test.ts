/**
 * Test layer composition — mock services for unit testing.
 *
 * Every service is backed by in-memory state so tests run without
 * Docker, SQLite, Telegram, or any external dependency.
 */

import { Effect, Layer, Queue, Ref, Stream } from 'effect';

import { AppConfig, type AppConfigShape } from '../config.js';
import { Database, type DatabaseService, type MessageRow, type ChatRow, type NewMessage } from '../services/Database.js';
import { Docker, type DockerService, type DockerProcess } from '../services/Docker.js';
import { Credentials, type CredentialsService, type CredentialResult } from '../services/Credentials.js';
import { Telegram, type TelegramService, type IncomingMessage } from '../services/Telegram.js';
import { ContainerRunner, type ContainerRunnerService } from '../services/ContainerRunner.js';
import { GroupRegistry, type GroupRegistryService } from '../state/GroupRegistry.js';
import { Scheduler, type SchedulerService, type TaskRunResult } from '../services/Scheduler.js';
import { Sandbox, type SandboxService, type SandboxConnection } from '../services/Sandbox.js';
import { BrowseHost, type BrowseHostService, type BrowseResult } from '../services/BrowseHost.js';
import { TTS, type TTSService, type TTSResult } from '../services/TTS.js';
import { Supermemory, type SupermemoryService } from '../services/Supermemory.js';
import { Media, type MediaService } from '../services/Media.js';
import { AgentSemaphore } from '../coordinators/AgentSemaphore.js';
import type { ScheduledTask, TaskRunLog } from '../schemas/Tasks.js';
import type { RegisteredGroup } from '../schemas/Groups.js';
import {
  DatabaseError,
  TTSError,
  SchedulerError,
} from '../errors.js';

// ─── Test AppConfig ────────────────────────────────────────────────────────

export const TestAppConfig: AppConfigShape = {
  telegramBotToken: 'test-token',
  telegramOwnerId: '12345',
  defaultProvider: 'openai',
  defaultModel: '',
  assistantName: 'TestBot',
  triggerPattern: /^@TestBot\b/i,
  projectRoot: '/tmp/nanoclaw-test',
  storeDir: '/tmp/nanoclaw-test/store',
  groupsDir: '/tmp/nanoclaw-test/groups',
  dataDir: '/tmp/nanoclaw-test/data',
  serviceLogsDir: '/tmp/nanoclaw-test/logs/services',
  mainGroupFolder: 'main',
  containerImage: 'nanoclaw-agent:test',
  containerAgentVersion: '2',
  containerTimeout: 30_000,
  containerMaxOutputSize: 1_048_576,
  maxConcurrentAgents: 4,
  maxConversationMessages: 50,
  maxAgentRetries: 2,
  agentRetryDelay: 100,
  ipcPollInterval: 1000,
  schedulerPollInterval: 60_000,
  sandboxIdleTimeoutMs: 300_000,
  sandboxTailscaleEnabled: false,
  cuaTakeoverWebEnabled: false,
  cuaTakeoverWebPort: 7788,
  cuaSandboxContainerName: 'test-cua-sandbox',
  cuaSandboxImage: 'test-cua:latest',
  cuaSandboxPlatform: 'linux/amd64',
  cuaSandboxCommandPort: 8000,
  cuaSandboxVncPort: 5901,
  cuaSandboxNovncPort: 6901,
  cuaSandboxScreenWidth: 1024,
  cuaSandboxScreenHeight: 768,
  cuaSandboxScreenDepth: 24,
  cuaSandboxShmSize: '256m',
  cuaSandboxPersist: false,
  cuaSandboxHomeVolume: 'test-cua-home',
  cuaApiKey: '',
  replicateApiToken: '',
  omniparserEnabled: false,
  omniparserBoxThreshold: 0.05,
  omniparserIouThreshold: 0.1,
  omniparserTimeoutMs: 10_000,
  freyaTtsEnabled: false,
  freyaApiKey: '',
  freyaCharacterId: 'Amika2',
  freyaLanguage: 'English',
  freyaRateLimitPerMin: 8,
  qwenTtsEnabled: false,
  qwenTtsUrl: '',
  qwenTtsApiKey: '',
  qwenTtsDefaultLanguage: 'English',
  qwenTtsDefaultSpeaker: 'Vivian',
  qwenTtsRateLimitPerMin: 10,
  replicateTtsEnabled: false,
  replicateTtsRateLimitPerMin: 10,
  replicateTtsTimeoutMs: 120_000,
  replicateTtsDefaultProvider: 'qwen/qwen3-tts',
  replicateTtsDefaultSpeaker: 'Vivian',
  openaiApiKey: '',
  openaiBaseUrl: '',
  anthropicBaseUrl: '',
  firecrawlApiKey: '',
  supermemoryApiKey: '',
  dashboardEnabled: false,
  dashboardPort: 7789,
  dashboardUrl: '',
  dashboardHttpsPort: 7790,
  cuaTakeoverHttpsPort: 7791,
  logRetentionDays: 7,
  timezone: 'UTC',
  logLevel: 'silent',
  maxThinkingTokens: 1000,
  debugThreads: false,
};

export const AppConfigTest: Layer.Layer<AppConfig> = Layer.succeed(
  AppConfig,
  TestAppConfig,
);

// ─── DatabaseTest ──────────────────────────────────────────────────────────

export const DatabaseTest: Layer.Layer<Database> = Layer.effect(
  Database,
  Effect.gen(function* () {
    const messages = yield* Ref.make<MessageRow[]>([]);
    const chats = yield* Ref.make<ChatRow[]>([]);
    const tasks = yield* Ref.make<ScheduledTask[]>([]);
    const taskLogs = yield* Ref.make<TaskRunLog[]>([]);

    const service: DatabaseService = {
      initDatabase: Effect.void,

      storeTextMessage: (msg) =>
        Ref.update(messages, (arr) => [
          ...arr,
          {
            id: msg.id,
            chat_jid: msg.chatJid,
            sender: msg.sender,
            sender_name: msg.senderName,
            content: msg.content,
            timestamp: msg.timestamp,
            is_from_me: msg.isFromMe,
          },
        ]),

      storeMediaMessage: (msg) =>
        Ref.update(messages, (arr) => [
          ...arr,
          {
            id: msg.id,
            chat_jid: msg.chatJid,
            sender: msg.sender,
            sender_name: msg.senderName,
            content: msg.content,
            timestamp: msg.timestamp,
            is_from_me: msg.isFromMe,
            media_type: msg.mediaType,
            media_path: msg.mediaPath,
          },
        ]),

      storeAssistantMessage: (chatJid, content, timestamp, senderName) =>
        Ref.update(messages, (arr) => [
          ...arr,
          {
            id: `asst-${Date.now()}`,
            chat_jid: chatJid,
            sender: senderName,
            sender_name: senderName,
            content,
            timestamp,
            is_from_me: true,
          },
        ]),

      getConversationHistory: (chatJid, limit) =>
        Ref.get(messages).pipe(
          Effect.map((arr) =>
            arr.filter((m) => m.chat_jid === chatJid).slice(-limit),
          ),
        ),

      getAllChats: Ref.get(chats),

      getAllTasks: Ref.get(tasks),

      getDueTasks: Ref.get(tasks).pipe(
        Effect.map((arr) =>
          arr.filter(
            (t) =>
              t.status === 'active' &&
              t.next_run != null &&
              new Date(t.next_run) <= new Date(),
          ),
        ),
      ),

      getTaskById: (id) =>
        Ref.get(tasks).pipe(
          Effect.map((arr) => arr.find((t) => t.id === id) ?? null),
        ),

      updateTaskAfterRun: (id, nextRun, result) =>
        Ref.update(tasks, (arr) =>
          arr.map((t) =>
            t.id === id
              ? { ...t, next_run: nextRun, last_run: new Date().toISOString(), last_result: result }
              : t,
          ),
        ),

      logTaskRun: (log) =>
        Ref.update(taskLogs, (arr) => [...arr, log]),

      clearMessages: (chatJid) =>
        Ref.update(messages, (arr) =>
          arr.filter((m) => m.chat_jid !== chatJid),
        ),

      storeChatMetadata: (chatJid, lastActivity, _displayName) =>
        Ref.update(chats, (arr) => {
          const existing = arr.find((c) => c.chat_jid === chatJid);
          if (existing) {
            return arr.map((c) =>
              c.chat_jid === chatJid ? { ...c, last_activity: lastActivity } : c,
            );
          }
          return [...arr, { chat_jid: chatJid, last_activity: lastActivity }];
        }),
    };

    return service;
  }),
);

// ─── DockerTest ────────────────────────────────────────────────────────────

export const DockerTest: Layer.Layer<Docker> = Layer.succeed(Docker, {
  isRunning: Effect.succeed(true),
  imageExists: (_image) => Effect.succeed(true),
  pullImage: (_image, _platform?) => Effect.void,
  rebuildImage: (_buildScript) => Effect.void,
  run: (_args) =>
    Effect.succeed({
      stdin: { write: () => true, end: () => {} } as unknown as import('stream').Writable,
      stdout: { on: () => {}, destroy: () => {} } as unknown as import('stream').Readable,
      stderr: { on: () => {}, destroy: () => {} } as unknown as import('stream').Readable,
      kill: (_signal?) => Effect.void,
      waitForExit: Effect.succeed(0),
    } satisfies DockerProcess),
  exec: (_container, _command) => Effect.succeed(''),
  stop: (_container) => Effect.void,
  remove: (_container) => Effect.void,
  inspect: (_container, _format?) => Effect.succeed('{}'),
  isContainerRunning: (_name) => Effect.succeed(false),
  killAllWithLabel: (_label) => Effect.void,
});

// ─── CredentialsTest ───────────────────────────────────────────────────────

export const CredentialsTest: Layer.Layer<Credentials> = Layer.succeed(
  Credentials,
  {
    resolve: Effect.succeed({
      source: 'dotenv',
      authType: 'api-key',
      envVars: {
        ANTHROPIC_API_KEY: 'test-api-key',
        OPENAI_API_KEY: 'test-openai-key',
      },
    } satisfies CredentialResult),
    refreshOAuth: Effect.void,
  },
);

// ─── TelegramTest ──────────────────────────────────────────────────────────

export interface TelegramTestState {
  readonly sentMessages: Array<{ chatJid: string; text: string }>;
  readonly sentPhotos: Array<{ chatJid: string; path: string; caption?: string }>;
  readonly sentVoices: Array<{ chatJid: string; path: string }>;
  readonly sentDocs: Array<{ chatJid: string; path: string; caption?: string }>;
}

export const makeTelegramTest = () =>
  Effect.gen(function* () {
    const stateRef = yield* Ref.make<TelegramTestState>({
      sentMessages: [],
      sentPhotos: [],
      sentVoices: [],
      sentDocs: [],
    });
    const messageQueue = yield* Queue.unbounded<IncomingMessage>();
    let nextMsgId = 1;

    const service: TelegramService = {
      connect: Effect.succeed(Stream.fromQueue(messageQueue)),
      sendMessage: (chatJid, text) =>
        Ref.update(stateRef, (s) => ({
          ...s,
          sentMessages: [...s.sentMessages, { chatJid, text }],
        })),
      sendMessageWithId: (chatJid, text) =>
        Ref.update(stateRef, (s) => ({
          ...s,
          sentMessages: [...s.sentMessages, { chatJid, text }],
        })).pipe(Effect.map(() => nextMsgId++)),
      editMessageText: (_chatJid, _messageId, _text) => Effect.succeed(true),
      deleteMessage: (_chatJid, _messageId) => Effect.void,
      sendPhoto: (chatJid, p, caption?) =>
        Ref.update(stateRef, (s) => ({
          ...s,
          sentPhotos: [...s.sentPhotos, { chatJid, path: p, caption }],
        })).pipe(Effect.map(() => nextMsgId++)),
      editPhoto: (_chatJid, _messageId, _path, _caption?) => Effect.succeed(true),
      sendDocument: (chatJid, p, caption?) =>
        Ref.update(stateRef, (s) => ({
          ...s,
          sentDocs: [...s.sentDocs, { chatJid, path: p, caption }],
        })),
      sendVoice: (chatJid, p) =>
        Ref.update(stateRef, (s) => ({
          ...s,
          sentVoices: [...s.sentVoices, { chatJid, path: p }],
        })),
      sendStatusMessage: (_chatJid, _text) => Effect.succeed(nextMsgId++),
      editStatusMessage: (_chatJid, _messageId, _text) => Effect.succeed(true),
      setTyping: (_chatJid) => Effect.void,
      stop: Effect.void,
    };

    return { service, stateRef, messageQueue };
  });

export const TelegramTest: Layer.Layer<Telegram> = Layer.effect(
  Telegram,
  makeTelegramTest().pipe(Effect.map((t) => t.service)),
);

// ─── ContainerRunnerTest ───────────────────────────────────────────────────

export const ContainerRunnerTest: Layer.Layer<ContainerRunner> = Layer.succeed(
  ContainerRunner,
  {
    runAgent: (_input, _handlers) =>
      Effect.succeed({
        status: 'success' as const,
        result: 'Test agent response',
      }),
    interrupt: (_groupFolder) =>
      Effect.succeed({ interrupted: true as const }),
    hasActiveRequest: (_groupFolder) => Effect.succeed(false),
    killAll: Effect.void,
    ensureImage: Effect.void,
    cleanupOrphans: Effect.void,
  } satisfies ContainerRunnerService,
);

// ─── GroupRegistryTest ─────────────────────────────────────────────────────

export const GroupRegistryTest: Layer.Layer<GroupRegistry> = Layer.effect(
  GroupRegistry,
  Effect.gen(function* () {
    const stateRef = yield* Ref.make<Record<string, RegisteredGroup>>({});

    const service: GroupRegistryService = {
      getAll: Ref.get(stateRef),
      get: (chatJid) =>
        Ref.get(stateRef).pipe(Effect.map((g) => g[chatJid])),
      register: (chatJid, group) =>
        Ref.update(stateRef, (g) => ({ ...g, [chatJid]: group })),
      loadState: Effect.void,
      saveState: Effect.void,
      folderForChatJid: (chatJid) =>
        Ref.get(stateRef).pipe(Effect.map((g) => g[chatJid]?.folder)),
      chatJidForFolder: (folder) =>
        Ref.get(stateRef).pipe(
          Effect.map((g) => {
            for (const [jid, group] of Object.entries(g)) {
              if (group.folder === folder) return jid;
            }
            return undefined;
          }),
        ),
    };

    return service;
  }),
);

// ─── SandboxTest ───────────────────────────────────────────────────────────

const TestSandboxConnection: SandboxConnection = {
  containerName: 'test-sandbox',
  commandUrl: 'http://localhost:8000/cmd',
  vncPort: 5901,
  novncPort: 6901,
};

export const SandboxTest: Layer.Layer<Sandbox> = Layer.succeed(Sandbox, {
  acquire: Effect.succeed(TestSandboxConnection),
  ensure: Effect.succeed(TestSandboxConnection),
  resetIdle: Effect.void,
  getVncPassword: Effect.succeed('test-password'),
  rotateVncPassword: Effect.succeed('new-test-password'),
  reset: Effect.void,
  resetFull: Effect.void,
  startIdleWatcher: Effect.void,
} satisfies SandboxService);

// ─── BrowseHostTest ────────────────────────────────────────────────────────

export const BrowseHostTest: Layer.Layer<BrowseHost> = Layer.succeed(
  BrowseHost,
  {
    processAction: (_sourceGroup, action, _params) =>
      Effect.succeed({
        success: true,
        data: `test: ${action}`,
      } satisfies BrowseResult),
    waitForUser: (_requestId, _groupFolder, _message, _chatJid?) =>
      Effect.succeed({
        success: true,
        data: 'User continued (test)',
      } satisfies BrowseResult),
    resolveWait: (_groupFolder, _requestId?) => Effect.succeed(true),
    cancelWaiting: (_groupFolder, _reason?) => Effect.succeed(0),
    hasWaitingRequests: (_groupFolder) => Effect.succeed(false),
  } satisfies BrowseHostService,
);

// ─── TTSTest ───────────────────────────────────────────────────────────────

export const TTSTest: Layer.Layer<TTS> = Layer.succeed(TTS, {
  synthesize: (_params) =>
    Effect.fail(
      new TTSError({ message: 'TTS disabled in test', provider: 'test' }),
    ),
  isEnabled: Effect.succeed(false),
} satisfies TTSService);

// ─── SupermemoryTest ───────────────────────────────────────────────────────

export const SupermemoryTest: Layer.Layer<Supermemory> = Layer.succeed(
  Supermemory,
  {
    search: (_query, _groupFolder) =>
      Effect.succeed({ results: [] }),
    save: (_content, _groupFolder, _metadata?) => Effect.void,
    isEnabled: Effect.succeed(false),
  } satisfies SupermemoryService,
);

// ─── MediaTest ─────────────────────────────────────────────────────────────

export const MediaTest: Layer.Layer<Media> = Layer.succeed(Media, {
  transcribeAudio: (_audioPath) =>
    Effect.succeed('Test transcription result'),
  downloadFile: (_fileId, destDir, filename?) =>
    Effect.succeed(`${destDir}/${filename || 'test-file'}`),
  cleanupOldMedia: (_mediaDir, _retentionDays) => Effect.succeed(0),
} satisfies MediaService);

// ─── SchedulerTest ─────────────────────────────────────────────────────────

export const SchedulerTest: Layer.Layer<Scheduler> = Layer.succeed(Scheduler, {
  start: Effect.void,
  runTaskNow: (_taskId) =>
    Effect.succeed({
      taskId: _taskId,
      status: 'success' as const,
      result: 'Test task result',
      durationMs: 100,
    } satisfies TaskRunResult),
} satisfies SchedulerService);

// ─── AgentSemaphoreTest ────────────────────────────────────────────────────

export const AgentSemaphoreTest: Layer.Layer<AgentSemaphore> = Layer.effect(
  AgentSemaphore,
  Effect.makeSemaphore(100), // effectively unlimited
);

// ─── Composed TestLayer ────────────────────────────────────────────────────

export const TestLayer: Layer.Layer<
  | AppConfig
  | Database
  | Docker
  | Credentials
  | Telegram
  | ContainerRunner
  | GroupRegistry
  | Scheduler
  | Sandbox
  | BrowseHost
  | TTS
  | Supermemory
  | Media
  | AgentSemaphore
> = Layer.mergeAll(
  AppConfigTest,
  DatabaseTest,
  DockerTest,
  CredentialsTest,
  TelegramTest,
  ContainerRunnerTest,
  GroupRegistryTest,
  SchedulerTest,
  SandboxTest,
  BrowseHostTest,
  TTSTest,
  SupermemoryTest,
  MediaTest,
  AgentSemaphoreTest,
);
