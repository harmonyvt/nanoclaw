/**
 * Effect program: NanoClaw Main
 *
 * Composes all Effect services into a single program that:
 * 1. Validates prerequisites (env vars, Docker)
 * 2. Initializes all services via layers
 * 3. Starts background loops (scheduler, idle watchers)
 * 4. Connects Telegram bot
 * 5. Handles graceful shutdown via Scope finalizers
 *
 * This replaces the imperative main() in src/index.ts with a
 * structured Effect program using BunRuntime.
 */
import { Effect, Layer } from 'effect';
import fs from 'fs';
import path from 'path';
import { execSync, spawn, type ChildProcess } from 'child_process';

import {
  Config,
  Database,
  AppLoggerService,
  Telegram,
  Container,
  Scheduler,
  Browse,
  Sandbox,
  Memory,
  Auxiliary,
} from './services/index.js';
import type { SchedulerDependencies } from '../task-scheduler.js';
import type {
  OnMessageStored,
  TaskActionHandler,
  InterruptHandler,
} from '../telegram.js';
import type { RegisteredGroup } from '../types.js';
import { loadJson, saveJson } from '../utils.js';
import { agentSemaphore } from '../concurrency.js';

// ─── Mutable App State ──────────────────────────────────────────────────────
// Single-threaded Bun process: plain mutable state is safe and avoids
// unnecessary Effect Ref overhead for callback interop.

let lastTimestamp = '';
let registeredGroups: Record<string, RegisteredGroup> = {};
let ttsProcess: ChildProcess | null = null;

// ─── Docker Prerequisite Check ──────────────────────────────────────────────

const ensureDocker = Effect.gen(function* () {
  const log = yield* AppLoggerService;

  yield* Effect.try({
    try: () => execSync('docker info', { stdio: 'pipe' }),
    catch: () => {
      log.error('index', 'Docker is not running');
      return new Error(
        'Docker is required but not running. Install and start Docker, then retry.',
      );
    },
  });

  log.debug('index', 'Docker is running');
});

// ─── State Persistence ──────────────────────────────────────────────────────

function loadAppState(dataDir: string) {
  const statePath = path.join(dataDir, 'router_state.json');
  const state = loadJson<{ last_timestamp?: string }>(statePath, {});
  lastTimestamp = state.last_timestamp || '';
  registeredGroups = loadJson<Record<string, RegisteredGroup>>(
    path.join(dataDir, 'registered_groups.json'),
    {},
  );
}

function saveAppState(dataDir: string) {
  saveJson(path.join(dataDir, 'router_state.json'), {
    last_timestamp: lastTimestamp,
  });
}

// ─── TTS Server Subprocess ──────────────────────────────────────────────────

function shouldAutoStartTts(config: { qwenTtsEnabled: boolean; qwenTtsUrl: string }): boolean {
  if (!config.qwenTtsEnabled || !config.qwenTtsUrl) return false;
  try {
    const url = new URL(config.qwenTtsUrl);
    return ['localhost', '127.0.0.1', '0.0.0.0'].includes(url.hostname);
  } catch {
    return false;
  }
}

function startTtsServer(
  log: { info: (m: string, msg: string, e?: Record<string, unknown>) => void; warn: (m: string, msg: string) => void; error: (m: string, msg: string, e?: Record<string, unknown>) => void },
  qwenTtsUrl: string,
): ChildProcess | null {
  const ttsDir = path.join(process.cwd(), 'tts-server');
  if (!fs.existsSync(path.join(ttsDir, 'server.py'))) {
    log.warn('tts', 'tts-server/server.py not found, skipping TTS auto-start');
    return null;
  }

  log.info('tts', 'Starting local TTS server', { url: qwenTtsUrl });
  const proc = spawn('uv', ['run', 'server.py'], {
    cwd: ttsDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  proc.stdout?.on('data', (data: Buffer) => {
    for (const line of data.toString().trim().split('\n')) {
      log.info('tts', line);
    }
  });

  proc.stderr?.on('data', (data: Buffer) => {
    for (const line of data.toString().trim().split('\n')) {
      log.info('tts', line);
    }
  });

  proc.on('exit', (code) => {
    if (code !== null && code !== 0) {
      log.error('tts', 'TTS server exited unexpectedly', { code });
    }
    ttsProcess = null;
  });

  return proc;
}

function stopTtsProcess() {
  if (ttsProcess) {
    ttsProcess.kill('SIGTERM');
    ttsProcess = null;
  }
}

// ─── Main Effect Program ────────────────────────────────────────────────────

export const program = Effect.gen(function* () {
  // ── Acquire services from context ──────────────────────────────────────
  const config = yield* Config;
  const log = yield* AppLoggerService;
  const db = yield* Database;
  const telegram = yield* Telegram;
  const container = yield* Container;
  const scheduler = yield* Scheduler;
  const browse = yield* Browse;
  const sandbox = yield* Sandbox;
  const _memory = yield* Memory;
  const auxiliary = yield* Auxiliary;

  // ── 1. Validate prerequisites ──────────────────────────────────────────
  if (!config.telegramBotToken) {
    return yield* Effect.die(new Error('TELEGRAM_BOT_TOKEN is required'));
  }
  if (!config.telegramOwnerId) {
    return yield* Effect.die(new Error('TELEGRAM_OWNER_ID is required'));
  }

  yield* ensureDocker;

  // ── 2. Ensure Docker images ────────────────────────────────────────────
  yield* container.ensureImage();
  yield* container.cleanupOrphans();

  // ── 3. Initialize database ─────────────────────────────────────────────
  yield* db.init();
  log.info('index', 'Database initialized');

  // ── 4. Initialize auxiliary services ───────────────────────────────────
  yield* auxiliary.initTrajectoryPersistence();
  yield* auxiliary.initLogSync();
  yield* auxiliary.pruneOldLogEntries();
  yield* auxiliary.pruneDebugEventEntries();
  yield* auxiliary.rotateServiceLogs(10);

  // ── 5. Load persisted state ────────────────────────────────────────────
  loadAppState(config.dataDir);

  // Load thinking state
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    if (fs.existsSync(path.join(config.groupsDir, group.folder, '.thinking_disabled'))) {
      telegram.addThinkingDisabled(chatJid);
    }
  }

  log.info('index', 'State loaded', {
    groupCount: Object.keys(registeredGroups).length,
  });

  // ── 6. Clean up old media ──────────────────────────────────────────────
  for (const group of Object.values(registeredGroups)) {
    yield* auxiliary.cleanupOldMedia(
      path.join(config.groupsDir, group.folder, 'media'),
      7,
    );
  }

  // ── 7. Register group callback ─────────────────────────────────────────
  const registerGroup = (jid: string, group: RegisteredGroup) => {
    registeredGroups[jid] = group;
    saveJson(
      path.join(config.dataDir, 'registered_groups.json'),
      registeredGroups,
    );
    const groupDir = path.join(config.groupsDir, group.folder);
    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
    log.info('index', 'Group registered', {
      jid,
      name: group.name,
      folder: group.folder,
    });
  };

  // ── 8. Build scheduler dependencies ────────────────────────────────────
  const sendMessage = async (jid: string, text: string) => {
    await Effect.runPromise(telegram.sendMessage(jid, text));
  };

  const schedulerDeps: SchedulerDependencies = {
    sendMessage,
    registeredGroups: () => registeredGroups,
  };

  const taskActions: TaskActionHandler = {
    runTaskNow: (taskId: string) =>
      Effect.runPromise(scheduler.runTaskNow(taskId, schedulerDeps)),
  };

  // ── 9. Start optional services ─────────────────────────────────────────
  if (shouldAutoStartTts(config)) {
    ttsProcess = startTtsServer(log, config.qwenTtsUrl);
  }

  yield* auxiliary.startCuaTakeover();
  yield* auxiliary.startDashboard();
  yield* auxiliary.initTailscale();

  // ── 10. Build interrupt handler ────────────────────────────────────────
  const interruptHandler: InterruptHandler = {
    interrupt(chatJid: string) {
      const group = registeredGroups[chatJid];
      if (!group) {
        return { interrupted: false, message: 'No registered group for this chat.' };
      }
      browse.cancelWaitingRequests(group.folder);
      return container.interruptContainer(group.folder);
    },
  };

  // ── 11. Message handler with semaphore ─────────────────────────────────
  const onMessageStored: OnMessageStored = async (msg) => {
    if (msg.timestamp > lastTimestamp) {
      lastTimestamp = msg.timestamp;
      saveAppState(config.dataDir);
    }
    // Fire-and-forget with concurrency limiting.
    // Message processing is delegated to the existing processMessage in index.ts.
    // This Effect runtime provides the service orchestration layer;
    // the full message→agent pipeline reuse is a future migration step.
    void agentSemaphore.acquire().then(async () => {
      try {
        // TODO: Wire processMessage here when fully migrated
        log.debug('index', 'Message received (Effect runtime)', {
          chatJid: msg.chat_jid,
          timestamp: msg.timestamp,
        });
      } finally {
        agentSemaphore.release();
      }
    });
  };

  // ── 12. Connect Telegram ───────────────────────────────────────────────
  const runnerHandle = yield* telegram.connect(
    () => registeredGroups,
    registerGroup,
    taskActions,
    interruptHandler,
    onMessageStored,
  );

  // ── 13. Start background loops ─────────────────────────────────────────
  yield* scheduler.start(schedulerDeps);
  yield* sandbox.startIdleWatcher();
  yield* container.startIdleCleanup();

  log.info('index', `NanoClaw running (trigger: @${config.assistantName})`);

  // ── 14. Register shutdown finalizer ────────────────────────────────────
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      log.info('index', 'Shutting down (Effect finalizer)');

      // Stop Telegram (30s timeout)
      yield* telegram.stop();

      // Kill containers
      yield* container.killAll();

      // Disconnect browser
      yield* browse.disconnect();

      // Stop TTS server
      stopTtsProcess();

      // Stop auxiliary services (handled by layer finalizers too,
      // but explicit for deterministic ordering)
      yield* auxiliary.stopTailscale();
      yield* auxiliary.stopDashboard();
      yield* auxiliary.stopLogSync();
      yield* auxiliary.stopCuaTakeover();
      yield* auxiliary.closeServiceLogHandles();

      // Cleanup sandbox
      yield* sandbox.cleanup();
    }),
  );

  // ── 15. Keep alive via runner task ─────────────────────────────────────
  // RunnerHandle.task() keeps the process alive while the bot is running
  const task = runnerHandle.task();
  if (task) {
    yield* Effect.promise(() => task);
  }
});
