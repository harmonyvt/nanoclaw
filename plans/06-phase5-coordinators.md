# Phase 5: Host — Coordinators + Subsystems

## Goal

Build the coordination layer that ties all services together: GroupCoordinator (per-group fiber with auto-interrupt, retry logic, concurrency control), MessageRouter (stream routing with catch-up), and all remaining subsystem services (Scheduler, Sandbox, BrowseHost, TTS, Supermemory, Media, IPC Watcher). Wire up the full `src-v2/index.ts` entry point.

## GroupCoordinator (`coordinators/GroupCoordinator.ts`)

**Source**: `src/index.ts` (message handling logic scattered across handleMessage/runContainerRequest)

Each registered group gets its own fiber. The coordinator:
1. Owns a `Queue<IncomingMessage>` for incoming messages
2. Processes messages sequentially within the group
3. Auto-interrupts: if a new message arrives while a container is running, interrupt the current container fiber and start a new one
4. Manages the per-group MessagePipeline lifecycle
5. Orchestrates the retry loop with exponential backoff
6. Acquires from the global concurrency semaphore (`MAX_CONCURRENT_AGENTS=4`)
7. Resolves provider/model including per-chat model overrides
8. Retrieves memories via Supermemory before agent invocation
9. Translates media paths (host -> container)

### Auto-Interrupt Error Handling

**CRITICAL**: `Effect.catchTag('ContainerInterruptedError', ...)` does NOT catch fiber interrupts. Fiber interruption in Effect uses `Cause.Interrupt`, not tagged errors. Use `Effect.catchAllCause` with `Cause.isInterruptedOnly`:

```typescript
yield* Fiber.join(fiber).pipe(
  Effect.catchAllCause((cause) =>
    Cause.isInterruptedOnly(cause)
      ? pipeline.onError('Interrupted by new message')
      : Effect.failCause(cause)
  ),
);
```

### Non-Retryable Errors

Pattern-match error strings for: `billing`, `rate_limit`, `authentication`, `overloaded`, `permission`, `model_not_found`. These skip the retry loop.

```typescript
const isNonRetryableError = (error: string): boolean => {
  const patterns = ['billing', 'rate_limit', 'authentication', 'overloaded', 'permission', 'model_not_found'];
  return patterns.some(p => error.toLowerCase().includes(p));
};
```

### Full Implementation

```typescript
export const createGroupCoordinator = (group: RegisteredGroup) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<IncomingMessage>();
    const activeFiber = yield* Ref.make<Fiber.Fiber<void, any> | null>(null);
    const containerRunner = yield* ContainerRunner;
    const telegram = yield* Telegram;
    const db = yield* Database;
    const config = yield* AppConfig;
    const memory = yield* Supermemory;
    const tts = yield* TTS;

    // Global concurrency semaphore (shared across all groups)
    // Passed in or accessed from a shared Ref
    const semaphore = yield* AgentSemaphore;

    const processMessage = (msg: IncomingMessage) =>
      Effect.gen(function* () {
        // Auto-interrupt: cancel any active container fiber
        const current = yield* Ref.get(activeFiber);
        if (current) {
          yield* Fiber.interrupt(current);
          yield* Ref.set(activeFiber, null);
        }

        // Store message in DB
        yield* db.storeTextMessage(/* ... */);

        // Build prompt from conversation history (respects reset boundaries)
        const history = yield* db.getConversationHistory(group.chatJid, 50);

        // Retrieve memories (if Supermemory configured)
        const memories = yield* memory.search(msg.text).pipe(
          Effect.orElse(() => Effect.succeed([]))
        );

        // Resolve provider/model (per-group config + per-chat model override)
        const modelOverride = yield* db.getActiveModelOverride(group.chatJid);
        const provider = modelOverride?.model ?? group.providerConfig?.model ?? config.defaultModel;

        // Translate media paths (host -> container)
        const translatedMsg = translateMediaPaths(msg, config, group);

        // Check if this is a skill invocation
        const skillPrompt = yield* resolveSkillPrompt(msg, group);

        const prompt = buildPrompt(history, translatedMsg, memories, skillPrompt);

        // Create message pipeline for streaming updates
        const pipeline = yield* createMessagePipeline(msg.chatId, msg.messageId);

        // Retry loop with exponential backoff
        const runWithRetries = Effect.gen(function* () {
          for (let attempt = 0; attempt <= config.maxAgentRetries; attempt++) {
            const result = yield* semaphore.withPermit(
              containerRunner.runAgent(group, prompt, {
                onTextDelta: pipeline.onTextDelta,
                onToolUse: pipeline.onToolUse,
                onDone: pipeline.onDone,
                onError: pipeline.onError,
              })
            ).pipe(
              Effect.either
            );

            if (Either.isRight(result)) {
              const output = result.right;

              // Post-run: handle voice TTS (skip if looksLikeCode)
              if (output.text && !looksLikeCode(output.text)) {
                yield* tts.synthesize(output.text, group.folder).pipe(Effect.ignore);
              }

              // Post-run: store memory
              yield* memory.save(output.text).pipe(Effect.ignore);

              return output;
            }

            const error = String(Either.isLeft(result) ? result.left : '');

            // Non-retryable errors: bail immediately
            if (isNonRetryableError(error)) {
              yield* pipeline.onError(error);
              return yield* Effect.fail(new NonRetryableAgentError({ message: error }));
            }

            // Retryable: log and backoff
            if (attempt < config.maxAgentRetries) {
              yield* Effect.log(`Retrying agent (attempt ${attempt + 1}/${config.maxAgentRetries + 1})`);
              yield* Effect.sleep(Duration.millis(config.agentRetryDelay * Math.pow(2, attempt)));
              continue;
            }

            // Exhausted retries
            yield* pipeline.onError(`Failed after ${config.maxAgentRetries + 1} attempts: ${error}`);
            return yield* Effect.fail(new AgentExhaustedError({ message: error, attempts: attempt + 1 }));
          }
        });

        // Fork container run
        const fiber = yield* Effect.fork(runWithRetries);
        yield* Ref.set(activeFiber, fiber);

        // Await result (can be interrupted by next message)
        yield* Fiber.join(fiber).pipe(
          Effect.catchAllCause((cause) =>
            Cause.isInterruptedOnly(cause)
              ? pipeline.onError('Interrupted by new message')
              : Effect.failCause(cause)
          ),
        );

        yield* Ref.set(activeFiber, null);
      });

    // Main loop: take from queue, process
    const loop = Stream.fromQueue(queue).pipe(
      Stream.tap((msg) => processMessage(msg)),
      Stream.runDrain,
    );

    return { queue, loop };
  });
```

### AgentSemaphore

Global concurrency limiter shared across all group coordinators:

```typescript
export class AgentSemaphore extends Context.Tag('AgentSemaphore')<
  AgentSemaphore,
  Effect.Semaphore
>() {}

export const AgentSemaphoreLive = Layer.effect(
  AgentSemaphore,
  Effect.map(Effect.makeSemaphore(MAX_CONCURRENT_AGENTS), (s) => s),
);
```

## MessageRouter (`coordinators/MessageRouter.ts`)

**Source**: `src/index.ts` (top-level message routing)

Routes the Telegram `Stream<IncomingMessage>` to per-group coordinator queues. Also handles catch-up of missed messages on startup.

```typescript
export const MessageRouterLive = Effect.gen(function* () {
  const telegram = yield* Telegram;
  const registry = yield* GroupRegistry;
  const db = yield* Database;
  const coordinators = yield* Ref.make<Record<string, GroupCoordinatorHandle>>({});

  // Catch up missed messages from DB (arrived while offline)
  yield* catchUpMissedMessages(db, registry);

  const messageStream = yield* telegram.connect;

  // Route each message to the appropriate group coordinator
  yield* messageStream.pipe(
    Stream.filter((msg) => !isBotOwnMessage(msg, config.assistantName)),  // Filter own messages
    Stream.tap((msg) =>
      Effect.gen(function* () {
        const group = yield* registry.get(msg.chatJid);
        if (!group) {
          yield* Effect.log(`Ignoring message from unregistered chat: ${msg.chatJid}`);
          return;
        }

        // Get or create coordinator for this group
        const existing = yield* Ref.get(coordinators);
        let coordinator = existing[group.folder];

        if (!coordinator) {
          coordinator = yield* createGroupCoordinator(group);
          yield* Ref.update(coordinators, (c) => ({ ...c, [group.folder]: coordinator }));
          // Fork the coordinator's processing loop
          yield* Effect.fork(coordinator.loop);
        }

        // Enqueue message
        yield* Queue.offer(coordinator.queue, msg);
      }),
    ),
    Stream.runDrain,
  );
});
```

### `catchUpMissedMessages`

On startup, processes messages that arrived while offline by checking the last processed timestamp cursor in `data/router_state.json`:

```typescript
const catchUpMissedMessages = (db: Database, registry: GroupRegistry) =>
  Effect.gen(function* () {
    const state = yield* loadRouterState();
    const groups = yield* registry.getAll;

    for (const [chatJid, group] of Object.entries(groups)) {
      const unprocessed = yield* db.getMessagesSince(chatJid, state.lastTimestamp[chatJid] ?? 0);
      if (unprocessed.length > 0) {
        yield* Effect.log(`Catching up ${unprocessed.length} missed messages for ${group.name}`);
        // Process each missed message through the normal pipeline
        // ...
      }
    }
  });
```

### Bot Message Filtering

Own messages (prefixed with `ASSISTANT_NAME:`) are filtered out at the router level before reaching coordinators.

## IPC Watcher (`coordinators/IpcWatcher.ts`)

**Source**: `src/index.ts` (IPC polling logic)

Polls IPC directories for fire-and-forget messages and request/response browse commands. **Includes authorization checks**: non-main groups can only send messages to their own chat and schedule tasks for themselves.

```typescript
export const createIpcWatcher = Effect.gen(function* () {
  const registry = yield* GroupRegistry;
  const telegram = yield* Telegram;
  const db = yield* Database;
  const browseHost = yield* BrowseHost;
  const config = yield* AppConfig;

  const pollOnce = Effect.gen(function* () {
    const groups = yield* registry.getAll;

    for (const [chatJid, group] of Object.entries(groups)) {
      const ipcDir = path.join(config.dataDir, 'ipc', group.folder);

      // --- Messages (fire-and-forget) ---
      const msgFiles = yield* listJsonFiles(path.join(ipcDir, 'messages'));
      for (const file of msgFiles) {
        const msg = yield* readAndDelete(file);

        // Authorization: non-main groups can only send to own chat
        if (!group.isMain && msg.chatJid !== chatJid) {
          yield* Effect.log(`IPC auth denied: ${group.folder} tried to send to ${msg.chatJid}`);
          continue;
        }

        yield* telegram.sendMessage(msg.chatId, msg.text, msg.options).pipe(Effect.ignore);
      }

      // --- Tasks (fire-and-forget) ---
      const taskFiles = yield* listJsonFiles(path.join(ipcDir, 'tasks'));
      for (const file of taskFiles) {
        const task = yield* readAndDelete(file);

        // Authorization: non-main groups can only schedule for themselves
        if (!group.isMain && task.groupFolder !== group.folder) {
          yield* Effect.log(`IPC auth denied: ${group.folder} tried to schedule for ${task.groupFolder}`);
          continue;
        }

        yield* db.storeTask(task).pipe(Effect.ignore);
      }

      // --- Browse (request/response) ---
      const browseFiles = yield* listJsonFiles(path.join(ipcDir, 'browse'), 'req-*.json');
      for (const file of browseFiles) {
        const req = yield* readJson(file);
        const reqId = path.basename(file).replace('req-', '').replace('.json', '');
        const result = yield* browseHost.handleRequest(req).pipe(
          Effect.catchAll((err) => Effect.succeed({ error: String(err) }))
        );
        // Write response atomically (temp + rename)
        const resPath = path.join(ipcDir, 'browse', `res-${reqId}.json`);
        yield* writeJsonAtomic(resPath, result);
        yield* deleteFile(file); // Clean up request
      }
    }
  });

  // Poll every 1 second
  return pollOnce.pipe(
    Effect.catchAll((err) => Effect.log(`IPC poll error: ${err}`)),
    Effect.repeat(Schedule.fixed('1 second')),
  );
});
```

## Scheduler (`services/Scheduler.ts`)

**Source**: `src/task-scheduler.ts`

Runs on a 60-second schedule, checks for due tasks, spawns container fibers. Must handle:
- Task snapshot writing (`data/ipc/{group}/current_tasks.json`) for agent visibility
- Provider/model resolution per task's group
- SOUL name resolution for task context

```typescript
export const SchedulerLive: Layer.Layer<Scheduler, SchedulerError, Database | ContainerRunner | GroupRegistry | AppConfig> =
  Layer.scoped(
    Scheduler,
    Effect.gen(function* () {
      const db = yield* Database;
      const runner = yield* ContainerRunner;
      const registry = yield* GroupRegistry;
      const config = yield* AppConfig;

      const writeTaskSnapshot = (groupFolder: string) =>
        Effect.gen(function* () {
          const tasks = yield* db.getTasksByGroup(groupFolder);
          const snapshotPath = path.join(config.dataDir, 'ipc', groupFolder, 'current_tasks.json');
          yield* Effect.try({
            try: () => fs.writeFileSync(snapshotPath, JSON.stringify(tasks, null, 2)),
            catch: () => new SchedulerError({ message: 'Failed to write task snapshot' }),
          });
        });

      const runDueTasks = Effect.gen(function* () {
        const due = yield* db.getDueTasks(new Date());
        for (const task of due) {
          const group = yield* registry.getByFolder(task.groupFolder);
          if (!group) continue;

          // Resolve provider/model for task's group
          const modelOverride = yield* db.getActiveModelOverride(group.chatJid);

          // Fork each task run so they don't block each other
          yield* Effect.fork(
            runner.runAgent(group, task.prompt, { /* minimal handlers */ }).pipe(
              Effect.tap(() => db.updateTaskAfterRun(task.id, 'success')),
              Effect.tap(() => writeTaskSnapshot(group.folder)),
              Effect.catchAll((err) => db.updateTaskAfterRun(task.id, 'error', String(err))),
            )
          );
        }
      });

      // Start the schedule fiber
      const fiber = yield* Effect.fork(
        runDueTasks.pipe(
          Effect.repeat(Schedule.fixed('60 seconds')),
        )
      );

      yield* Effect.addFinalizer(() => Fiber.interrupt(fiber));

      return {
        start: Effect.void,
        stop: Fiber.interrupt(fiber),
        createTask: (task) => db.storeTask(task),
        pauseTask: (id) => db.updateTaskStatus(id, 'paused'),
        resumeTask: (id) => db.updateTaskStatus(id, 'active'),
        cancelTask: (id) => db.updateTaskStatus(id, 'cancelled'),
        listTasks: (groupFolder) => db.getTasksByGroup(groupFolder),
        getTaskByShortId: (shortId) => db.getTaskByShortId(shortId),
        runDueTasks,
        writeTaskSnapshot,
      };
    }),
  );
```

## Sandbox (`services/Sandbox.ts`)

**Source**: `src/sandbox-manager.ts`

CUA desktop sandbox lifecycle as a scoped resource:

```typescript
export const SandboxLive: Layer.Layer<Sandbox, SandboxError, Docker | AppConfig> =
  Layer.scoped(
    Sandbox,
    Effect.gen(function* () {
      const docker = yield* Docker;
      const config = yield* AppConfig;
      const connectionRef = yield* Ref.make<SandboxConnection | null>(null);
      const lastActivityRef = yield* Ref.make<number>(Date.now());
      const vncPasswordRef = yield* Ref.make<string>('');

      // Idle timeout fiber: stop sandbox after 30min of inactivity
      const idleFiber = yield* Effect.fork(
        Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep('60 seconds');
            const lastActivity = yield* Ref.get(lastActivityRef);
            if (Date.now() - lastActivity > config.sandboxIdleTimeout) {
              yield* stop;
            }
          }
        })
      );

      yield* Effect.addFinalizer(() =>
        Effect.all([Fiber.interrupt(idleFiber), stop]).pipe(Effect.ignore)
      );

      // Generate random VNC password
      const generateVncPassword = () =>
        Effect.sync(() => crypto.randomBytes(12).toString('base64url'));

      const acquire = Effect.gen(function* () {
        // Check if already running
        const existing = yield* Ref.get(connectionRef);
        if (existing) {
          yield* Ref.set(lastActivityRef, Date.now());
          return existing;
        }

        // Check for image staleness (container image ID vs current)
        // Pull image if needed

        // Generate VNC password
        const vncPw = yield* generateVncPassword();
        yield* Ref.set(vncPasswordRef, vncPw);

        // Start CUA container (persist mode: stop/start, not rm)
        yield* docker.runDetached({
          name: 'nanoclaw-cua',
          image: config.cuaSandboxImage,
          platform: config.cuaSandboxPlatform,
          ports: {
            [config.cuaCommandPort]: 8000,
            [config.cuaVncPort]: 5901,
            [config.cuaNoVncPort]: 6901,
          },
          env: {
            SCREEN_WIDTH: String(config.cuaScreenWidth),
            SCREEN_HEIGHT: String(config.cuaScreenHeight),
            SCREEN_DEPTH: String(config.cuaScreenDepth),
            VNC_PW: vncPw,
          },
          shmSize: config.cuaShmSize,
          volumes: [{ host: config.cuaHomeVolume, container: '/home/cua', type: 'volume' }],
        });

        // Wait for command API to be ready
        yield* Effect.retry(
          Effect.tryPromise({
            try: () => fetch(`http://localhost:${config.cuaCommandPort}/health`),
            catch: (err) => new SandboxError({ message: `Health check failed: ${err}` }),
          }),
          Schedule.exponential('500 millis').pipe(Schedule.compose(Schedule.recurs(10))),
        );

        const conn: SandboxConnection = { commandPort: config.cuaCommandPort, vncPassword: vncPw };
        yield* Ref.set(connectionRef, conn);
        return conn;
      });

      const stop = Effect.gen(function* () {
        const existing = yield* Ref.get(connectionRef);
        if (!existing) return;
        yield* docker.stop('nanoclaw-cua').pipe(Effect.ignore);
        // Don't remove - persist mode keeps state
        yield* Ref.set(connectionRef, null);
      });

      return {
        acquire,
        isRunning: Ref.get(connectionRef).pipe(Effect.map(c => c !== null)),
        stop,
        executeCommand: (cmd) =>
          Effect.tryPromise({
            try: () => fetch(`http://localhost:${config.cuaCommandPort}/cmd`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(cmd),
            }).then(r => r.json()),
            catch: (err) => new SandboxError({ message: `Command failed: ${err}` }),
          }).pipe(Effect.tap(() => Ref.set(lastActivityRef, Date.now()))),
        takeScreenshot: /* POST to /cmd screenshot, save to group media */,
        getVncPassword: Ref.get(vncPasswordRef),
        rotateVncPassword: /* generate new password, update container VNC_PW */,
      };
    }),
  );
```

## BrowseHost (`services/BrowseHost.ts`)

**Source**: `src/browse-host.ts`

Bridges container browse requests to the CUA sandbox. Includes element finding with retry chain and before/after verification:

```typescript
export const BrowseHostLive: Layer.Layer<BrowseHost, BrowseError, Sandbox | Docker | AppConfig | Telegram> =
  Layer.effect(
    BrowseHost,
    Effect.gen(function* () {
      const sandbox = yield* Sandbox;
      const telegram = yield* Telegram;
      const config = yield* AppConfig;

      // Element finding retry chain: CSS selector -> a11y tree -> OmniParser (if enabled)
      const findElement = (description: string, hint?: string) =>
        Effect.gen(function* () {
          // 1. Try CSS-like selector (best-effort hint)
          if (hint) {
            const cssResult = yield* sandbox.executeCommand({ action: 'find_css', selector: hint }).pipe(
              Effect.orElse(() => Effect.succeed(null))
            );
            if (cssResult) return cssResult;
          }

          // 2. Try a11y tree description matching
          const a11yResult = yield* sandbox.executeCommand({ action: 'find_a11y', description }).pipe(
            Effect.orElse(() => Effect.succeed(null))
          );
          if (a11yResult) return a11yResult;

          // 3. OmniParser vision-based (if enabled)
          if (config.omniparserEnabled) {
            return yield* sandbox.executeCommand({ action: 'find_omniparser', description }).pipe(
              Effect.timeout(Duration.millis(config.omniparserTimeoutMs)),
              Effect.orElse(() => Effect.succeed(null))
            );
          }

          return null;
        });

      return {
        handleRequest: (req) => Effect.gen(function* () {
          const conn = yield* sandbox.acquire;

          // Before screenshot (for verification)
          const beforeScreenshot = yield* sandbox.takeScreenshot().pipe(Effect.ignore);

          // Dispatch based on req.action
          const result = yield* match(req.action, {
            navigate: () => sandbox.executeCommand({ action: 'navigate', url: req.url }),
            click: () => Effect.gen(function* () {
              const el = yield* findElement(req.description, req.selector);
              if (!el) return yield* Effect.fail(new BrowseError({ message: `Element not found: ${req.description}` }));
              return yield* sandbox.executeCommand({ action: 'click', ...el });
            }),
            click_xy: () => sandbox.executeCommand({ action: 'click', x: req.x, y: req.y }),
            screenshot: () => Effect.gen(function* () {
              const path = yield* sandbox.takeScreenshot();
              // Also send as Telegram photo
              yield* telegram.sendPhoto(req.chatId, path).pipe(Effect.ignore);
              return { screenshotPath: path };
            }),
            snapshot: () => sandbox.executeCommand({ action: 'accessibility_tree' }),
            fill: () => Effect.gen(function* () {
              const el = yield* findElement(req.description, req.selector);
              if (!el) return yield* Effect.fail(new BrowseError({ message: `Element not found: ${req.description}` }));
              return yield* sandbox.executeCommand({ action: 'fill', ...el, value: req.value });
            }),
            wait_for_user: () => handleWaitForUser(req),
            // ... other actions
          });

          return result;
        }),

        handleWaitForUser: (req) => Effect.gen(function* () {
          // Rotate VNC password for this takeover session
          yield* sandbox.rotateVncPassword;
          const vncPw = yield* sandbox.getVncPassword;

          // Build takeover URL
          const host = config.sandboxTailscaleEnabled
            ? yield* getTailscaleIp().pipe(Effect.orElse(() => Effect.succeed('127.0.0.1')))
            : '127.0.0.1';
          const takeoverUrl = `http://${host}:${config.cuaTakeoverWebPort}/cua/takeover/${generateToken()}`;

          // Send URL to chat
          yield* telegram.sendMessage(req.chatId, `Take control: ${takeoverUrl}`).pipe(Effect.ignore);

          // Wait for user to click "continue" (poll takeover endpoint)
          yield* Effect.retry(
            Effect.tryPromise({
              try: () => fetch(`${takeoverUrl}/status`).then(r => r.json()),
              catch: () => new BrowseError({ message: 'Takeover poll failed' }),
            }).pipe(Effect.flatMap(s => s.returned ? Effect.void : Effect.fail(new BrowseError({ message: 'waiting' })))),
            Schedule.fixed('2 seconds'),
          );

          // Invalidate VNC password after control returns
          yield* sandbox.rotateVncPassword;
        }),

        isActive: sandbox.isRunning,
      };
    }),
  );
```

## TTS (`services/TTS.ts`)

**Source**: `src/tts-dispatch.ts`, `src/tts-qwen.ts`, `src/tts-replicate.ts`

Routes to self-hosted Qwen or Replicate-hosted TTS. Includes `looksLikeCode()` check for skipping TTS on code-heavy responses:

```typescript
// Shared utility: skip TTS for code blocks, JSON, etc.
export const looksLikeCode = (text: string): boolean => {
  const codeIndicators = ['```', '{"', 'function ', 'const ', 'import ', '=> {'];
  const codeRatio = codeIndicators.reduce((count, indicator) =>
    count + (text.includes(indicator) ? 1 : 0), 0);
  return codeRatio >= 2 || (text.match(/```/g)?.length ?? 0) >= 2;
};

export const TTSLive: Layer.Layer<TTS, TTSError, AppConfig> =
  Layer.effect(TTS, Effect.gen(function* () {
    const config = yield* AppConfig;
    return {
      synthesize: (text, voiceProfile) => Effect.gen(function* () {
        // Skip TTS for code-heavy content
        if (looksLikeCode(text)) {
          return yield* Effect.fail(new TTSSkippedError({ reason: 'code content' }));
        }

        if (config.qwenTtsEnabled) {
          return yield* qwenSynthesize(config, text, voiceProfile);
        }
        if (config.replicateTtsEnabled) {
          return yield* replicateSynthesize(config, text, voiceProfile);
        }
        return yield* Effect.fail(new TTSError({ message: 'No TTS provider enabled' }));
      }),
      loadVoiceProfile: (groupFolder) => /* read voice_profile.json */,
    };
  }));
```

## Supermemory, Media — Similar Patterns

Simple `Effect.tryPromise` wrappers around HTTP API calls.

## Full Entry Point (`src-v2/index.ts`)

**IMPORTANT**: Use `BunRuntime.runMain` instead of `Effect.runPromise` with manual `Effect.scoped` + `Effect.interruptible`. `BunRuntime.runMain` handles SIGINT/SIGTERM gracefully and sets up proper fiber supervision.

```typescript
import { BunRuntime } from '@effect/platform-bun';

const program = Effect.gen(function* () {
  const config = yield* AppConfig;
  yield* Effect.log(`NanoClaw v2 starting (@${config.assistantName})`);

  // Validate Docker
  const docker = yield* Docker;
  yield* docker.isRunning;

  // Ensure agent image (auto-rebuild if missing)
  const runner = yield* ContainerRunner;
  yield* runner.ensureImage;

  // Cleanup orphan containers from previous runs
  yield* runner.cleanupOrphans;

  // Start subsystems as forked fibers
  const scheduler = yield* Scheduler;
  yield* Effect.fork(scheduler.start);

  // Start IPC watcher fiber
  yield* Effect.fork(createIpcWatcher);

  // Start message router (blocks until Telegram disconnects)
  yield* MessageRouterLive;
});

// Layer composition: use provideMerge chain for dependency resolution
const MainLayer = AppConfigLive.pipe(
  Layer.provideMerge(DatabaseLive),
  Layer.provideMerge(DockerLive),
  Layer.provideMerge(CredentialsLive),
  Layer.provideMerge(TelegramLive),
  Layer.provideMerge(AgentSemaphoreLive),
  Layer.provideMerge(ContainerRunnerLive),
  Layer.provideMerge(GroupRegistryLive),
  Layer.provideMerge(SchedulerLive),
  Layer.provideMerge(SandboxLive),
  Layer.provideMerge(BrowseHostLive),
  Layer.provideMerge(TTSLive),
  Layer.provideMerge(SupermemoryLive),
  Layer.provideMerge(MediaLive),
);

// BunRuntime.runMain handles SIGINT/SIGTERM -> fiber interrupt -> cascade cleanup
const main = program.pipe(
  Effect.provide(MainLayer),
  Effect.scoped,
);

BunRuntime.runMain(main);
```

## Deferred Subsystems

The following are explicitly deferred to future phases (post-v2 MVP):

| Subsystem | Description |
|---|---|
| Dashboard server | Web UI for viewing logs, messages, debug events |
| Self-update system | `/update` and `/rebuild` Telegram commands |
| CUA takeover server | Express server for VNC takeover web UI |
| CUA trajectory recording | Record browse actions for replay/debugging |
| Log sync / service log writer | Stream logs to external services |
| Debug UI | Interactive debug event viewer |
| noVNC proxy | Proxy for noVNC connections with auth |
| Model swap system | Inline keyboard for model selection (deferred; DB methods in Phase 4) |

## Checklist

- [ ] Implement `AgentSemaphore` (global concurrency limiter, `MAX_CONCURRENT_AGENTS=4`)
- [ ] Implement `GroupCoordinator` (per-group fiber, queue, auto-interrupt with `Cause.isInterruptedOnly`)
  - [ ] Retry loop with exponential backoff (`MAX_AGENT_RETRIES=7`, `AGENT_RETRY_DELAY * 2^attempt`)
  - [ ] Non-retryable error detection (billing, rate_limit, auth, overloaded, permission, model_not_found)
  - [ ] Provider/model resolution with per-chat model override
  - [ ] Memory retrieval via Supermemory before agent invocation
  - [ ] Media path translation (host -> container)
  - [ ] Skills invocation handling
  - [ ] `looksLikeCode()` check for TTS skipping
  - [ ] Voice dedup window (2.5s)
- [ ] Implement `MessageRouter` (Telegram stream -> group coordinators)
  - [ ] `catchUpMissedMessages()` on startup
  - [ ] Bot message filtering (own messages by `ASSISTANT_NAME:` prefix)
- [ ] Implement `IpcWatcher` (1s poll, messages/tasks/browse, authorization checks)
  - [ ] Non-main groups restricted to own chat for messages
  - [ ] Non-main groups restricted to own group for tasks
  - [ ] Atomic response writing for browse (temp + rename)
- [ ] Implement `SchedulerLive` Layer (60s schedule, fork task runs)
  - [ ] Task snapshot writing (`current_tasks.json`)
  - [ ] Provider/model resolution per task's group
- [ ] Implement `SandboxLive` Layer (scoped CUA lifecycle, idle timeout)
  - [ ] Image staleness check
  - [ ] VNC password generation and rotation per takeover session
  - [ ] Persist mode (stop/start, not rm)
- [ ] Implement `BrowseHostLive` Layer (element finding retry chain: CSS -> a11y -> OmniParser)
  - [ ] Before/after verification screenshots
  - [ ] VNC password rotation per takeover session
  - [ ] Takeover URL generation with Tailscale IP
- [ ] Implement `TTSLive` Layer (Qwen/Replicate dispatch, `looksLikeCode()` skip)
- [ ] Implement `SupermemoryLive` Layer
- [ ] Implement `MediaLive` Layer
- [ ] Wire up full `src-v2/index.ts` with `BunRuntime.runMain` and `Layer.provideMerge` chain
- [ ] Test graceful shutdown (SIGINT -> cascade interrupt via BunRuntime)
- [ ] Test auto-interrupt (send message during active run, verify `Cause.isInterruptedOnly`)
- [ ] Test IPC authorization (non-main group cannot send to other chats)
