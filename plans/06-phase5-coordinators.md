# Phase 5: Host — Coordinators + Subsystems

## Goal

Build the coordination layer that ties all services together: GroupCoordinator (per-group fiber with auto-interrupt), MessageRouter (stream routing), and all remaining subsystem services (Scheduler, Sandbox, BrowseHost, TTS, Supermemory, Media). Wire up the full `src-v2/index.ts` entry point.

## GroupCoordinator (`coordinators/GroupCoordinator.ts`)

**Source**: `src/index.ts` (message handling logic scattered across handleMessage/runContainerRequest)

Each registered group gets its own fiber. The coordinator:
1. Owns a `Queue<IncomingMessage>` for incoming messages
2. Processes messages sequentially within the group
3. Auto-interrupts: if a new message arrives while a container is running, interrupt the current container fiber and start a new one
4. Manages the per-group MessagePipeline lifecycle

```typescript
export const createGroupCoordinator = (group: RegisteredGroup) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<IncomingMessage>();
    const activeFiber = yield* Ref.make<Fiber.Fiber<void, any> | null>(null);
    const containerRunner = yield* ContainerRunner;
    const telegram = yield* Telegram;
    const db = yield* Database;

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

        // Build prompt from conversation history
        const history = yield* db.getConversationHistory(group.chatJid, 50);
        const prompt = buildPrompt(history, msg);

        // Create message pipeline for streaming updates
        const pipeline = yield* createMessagePipeline(msg.chatId, msg.messageId);

        // Fork container run
        const fiber = yield* Effect.fork(
          containerRunner.runAgent(group, prompt, {
            onTextDelta: pipeline.onTextDelta,
            onToolUse: pipeline.onToolUse,
            onDone: pipeline.onDone,
            onError: pipeline.onError,
          })
        );

        yield* Ref.set(activeFiber, fiber);

        // Await result (but can be interrupted by next message)
        yield* Fiber.join(fiber).pipe(
          Effect.catchTag('ContainerInterruptedError', () =>
            pipeline.onError('Interrupted by new message')
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

## MessageRouter (`coordinators/MessageRouter.ts`)

**Source**: `src/index.ts` (top-level message routing)

Routes the Telegram `Stream<IncomingMessage>` to per-group coordinator queues:

```typescript
export const MessageRouterLive = Effect.gen(function* () {
  const telegram = yield* Telegram;
  const registry = yield* GroupRegistry;
  const coordinators = yield* Ref.make<Record<string, GroupCoordinatorHandle>>({});

  const messageStream = yield* telegram.connect;

  // Route each message to the appropriate group coordinator
  yield* messageStream.pipe(
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

## Scheduler (`services/Scheduler.ts`)

**Source**: `src/task-scheduler.ts`

Runs on a 60-second schedule, checks for due tasks, spawns container fibers:

```typescript
export const SchedulerLive: Layer.Layer<Scheduler, SchedulerError, Database | ContainerRunner | GroupRegistry> =
  Layer.scoped(
    Scheduler,
    Effect.gen(function* () {
      const db = yield* Database;
      const runner = yield* ContainerRunner;
      const registry = yield* GroupRegistry;

      const runDueTasks = Effect.gen(function* () {
        const due = yield* db.getDueTasks(new Date());
        for (const task of due) {
          const group = yield* registry.get(task.groupFolder);
          if (!group) continue;
          // Fork each task run so they don't block each other
          yield* Effect.fork(
            runner.runAgent(group, task.prompt, { /* ... */ }).pipe(
              Effect.tap(() => db.updateTaskAfterRun(task.id, 'success')),
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
        runDueTasks,
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

      const acquire = Effect.gen(function* () {
        // Check if already running
        const existing = yield* Ref.get(connectionRef);
        if (existing) return existing;

        // Start CUA container
        yield* docker.run({
          image: config.cuaSandboxImage,
          ports: { /* VNC, noVNC, command API */ },
          env: { SCREEN_WIDTH: config.cuaScreenWidth, /* ... */ },
          volumes: [{ host: config.cuaHomeVolume, container: '/home/cua' }],
        });

        // Wait for command API to be ready
        yield* Effect.retry(
          Effect.tryPromise({ try: () => fetch(`http://localhost:${config.cuaCommandPort}/health`), catch: /* ... */ }),
          Schedule.exponential('500 millis').pipe(Schedule.compose(Schedule.recurs(10))),
        );

        const conn: SandboxConnection = { commandPort: config.cuaCommandPort, /* ... */ };
        yield* Ref.set(connectionRef, conn);
        return conn;
      });

      return {
        acquire,
        isRunning: Ref.get(connectionRef).pipe(Effect.map(c => c !== null)),
        stop: /* docker.stop + Ref.set(null) */,
        executeCommand: (cmd) => /* POST to /cmd API */,
        takeScreenshot: /* POST to /cmd screenshot */,
      };
    }),
  );
```

## BrowseHost (`services/BrowseHost.ts`)

**Source**: `src/browse-host.ts`

Bridges container browse requests to the CUA sandbox:

```typescript
export const BrowseHostLive: Layer.Layer<BrowseHost, BrowseError, Sandbox | Docker | AppConfig> =
  Layer.effect(
    BrowseHost,
    Effect.gen(function* () {
      const sandbox = yield* Sandbox;

      return {
        handleRequest: (req) => Effect.gen(function* () {
          const conn = yield* sandbox.acquire;
          // Dispatch based on req.action: navigate, click, screenshot, etc.
          const result = yield* sandbox.executeCommand(req);
          return result;
        }),
        handleWaitForUser: (req) => Effect.gen(function* () {
          // Generate takeover URL with VNC password
          // Send URL to chat
          // Wait for user to click "continue" (poll takeover endpoint)
          // Return control
        }),
        isActive: sandbox.isRunning,
      };
    }),
  );
```

## TTS (`services/TTS.ts`)

**Source**: `src/tts-dispatch.ts`, `src/tts-qwen.ts`, `src/tts-replicate.ts`

Routes to self-hosted Qwen or Replicate-hosted TTS:

```typescript
export const TTSLive: Layer.Layer<TTS, TTSError, AppConfig> =
  Layer.effect(TTS, Effect.gen(function* () {
    const config = yield* AppConfig;
    return {
      synthesize: (text, voiceProfile) => Effect.gen(function* () {
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

```typescript
const program = Effect.gen(function* () {
  const config = yield* AppConfig;
  yield* Effect.log(`NanoClaw v2 starting (@${config.assistantName})`);

  // Validate Docker
  const docker = yield* Docker;
  yield* docker.isRunning;
  yield* (yield* ContainerRunner).ensureImage;

  // Load groups from database
  const registry = yield* GroupRegistry;
  yield* registry.loadFromDatabase;

  // Start subsystems as forked fibers
  const scheduler = yield* Scheduler;
  yield* Effect.fork(scheduler.start);

  // Start message router (blocks until Telegram disconnects)
  yield* MessageRouterLive;
});

const MainLayer = Layer.mergeAll(
  AppConfigLive,
  DatabaseLive,
  DockerLive,
  CredentialsLive,
  TelegramLive,
  ContainerRunnerLive,
  GroupRegistryLive,
  SchedulerLive,
  SandboxLive,
  BrowseHostLive,
  TTSLive,
  SupermemoryLive,
  MediaLive,
);

// Handle SIGINT/SIGTERM for graceful shutdown
const main = program.pipe(
  Effect.provide(MainLayer),
  Effect.scoped, // All scoped resources cleaned up
  Effect.interruptible, // SIGINT/SIGTERM -> fiber interrupt -> cascade cleanup
);

Effect.runPromise(main);
```

## IPC Watcher Fiber (Backward Compat)

For the transition period, maintain file-based IPC polling alongside RPC:

```typescript
const ipcWatcher = Effect.gen(function* () {
  // Poll every 1s for:
  // - data/ipc/{group}/messages/*.json -> process + delete
  // - data/ipc/{group}/tasks/*.json -> process + delete
  // - data/ipc/{group}/browse/req-*.json -> process + write response
}).pipe(Effect.repeat(Schedule.fixed('1 second')));
```

## Checklist

- [ ] Implement `GroupCoordinator` (per-group fiber, queue, auto-interrupt)
- [ ] Implement `MessageRouter` (Telegram stream -> group coordinators)
- [ ] Implement `SchedulerLive` Layer (60s schedule, fork task runs)
- [ ] Implement `SandboxLive` Layer (scoped CUA lifecycle, idle timeout)
- [ ] Implement `BrowseHostLive` Layer (container request -> sandbox)
- [ ] Implement `TTSLive` Layer (Qwen/Replicate dispatch)
- [ ] Implement `SupermemoryLive` Layer
- [ ] Implement `MediaLive` Layer
- [ ] Implement IPC watcher fiber (backward compat)
- [ ] Wire up full `src-v2/index.ts` with all layers + fibers
- [ ] Test graceful shutdown (SIGINT -> cascade interrupt)
- [ ] Test auto-interrupt (send message during active run)
