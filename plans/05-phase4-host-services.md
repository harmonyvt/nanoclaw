# Phase 4: Host — Core Services

## Goal

Implement the Live Layers for core host services: AppConfig (done), Database, Docker, Credentials, Telegram, ContainerRunner, GroupRegistry, and MessagePipeline.

## AppConfig — DONE (Phase 1)

Already fully implemented in `src-v2/config.ts`. Reads 75+ env vars with proper defaults.

## Database (`services/Database.ts`)

**Source**: `src/db.ts` (1138 lines)

Wraps bun:sqlite. All operations are synchronous but **use `Effect.try` (not `Effect.sync`)** so errors surface as typed `DatabaseError` failures instead of untyped defects:

```typescript
export const DatabaseLive: Layer.Layer<Database, DatabaseConnectionError, AppConfig> =
  Layer.scoped(
    Database,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const db = new BunDatabase(config.dbPath);
      db.exec('PRAGMA journal_mode=WAL');
      db.exec('PRAGMA foreign_keys=ON');

      // Run migrations
      yield* Effect.try({
        try: () => runMigrations(db),
        catch: (err) => new DatabaseConnectionError({ message: String(err) }),
      });

      // Register scope finalizer
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => { db.close(); })
      );

      // Helper: wrap all DB operations for typed errors
      const dbTry = <A>(op: () => A) =>
        Effect.try({
          try: op,
          catch: (err) => new DatabaseError({ message: String(err) }),
        });

      return {
        // --- Messages ---
        storeTextMessage: (msg) => dbTry(() => {
          const stmt = db.prepare('INSERT INTO messages ...');
          stmt.run(msg.chatJid, msg.sender, msg.text, msg.timestamp);
        }),
        getConversationHistory: (chatJid, limit) => dbTry(() => {
          // Must respect conversation reset boundaries
          const stmt = db.prepare(
            `SELECT * FROM messages WHERE chat_jid = ?
             AND id > COALESCE((SELECT MAX(id) FROM messages WHERE chat_jid = ? AND is_reset = 1), 0)
             ORDER BY id DESC LIMIT ?`
          );
          return stmt.all(chatJid, chatJid, limit) as MessageRow[];
        }),
        insertConversationReset: (chatJid) => dbTry(() => {
          db.prepare('INSERT INTO messages (chat_jid, sender, text, is_reset) VALUES (?, ?, ?, 1)')
            .run(chatJid, 'SYSTEM', '[conversation reset]');
        }),

        // --- Chats ---
        upsertChat: (chat) => dbTry(() => { /* ... */ }),
        getChatsWithCounts: () => dbTry(() => { /* dashboard: join chats + message counts */ }),
        getChatMessages: (chatJid, limit, offset) => dbTry(() => { /* paginated */ }),

        // --- Tasks ---
        storeTask: (task) => dbTry(() => { /* INSERT INTO scheduled_tasks */ }),
        getDueTasks: (now) => dbTry(() => { /* WHERE next_run_at <= ? AND status = 'active' */ }),
        getTasksByGroup: (groupFolder) => dbTry(() => { /* ... */ }),
        getTaskByShortId: (shortId) => dbTry(() => { /* ... */ }),
        updateTaskStatus: (id, status) => dbTry(() => { /* ... */ }),
        updateTaskAfterRun: (id, status, error?) => dbTry(() => { /* ... */ }),
        createTask: (task) => dbTry(() => { /* ... */ }),
        updateTask: (id, updates) => dbTry(() => { /* ... */ }),
        deleteTask: (id) => dbTry(() => { /* ... */ }),

        // --- Task Run Logs ---
        insertTaskRunLog: (log) => dbTry(() => { /* ... */ }),

        // --- Model Menu ---
        addModelToMenu: (chatJid, label, model) => dbTry(() => { /* INSERT INTO model_menu */ }),
        removeModelFromMenu: (chatJid, id) => dbTry(() => { /* DELETE model_menu + active_model_override */ }),
        getModelMenu: (chatJid) => dbTry(() => { /* LEFT JOIN active_model_override */ }),
        setActiveModelOverride: (chatJid, modelMenuId) => dbTry(() => { /* INSERT OR REPLACE */ }),
        clearActiveModelOverride: (chatJid) => dbTry(() => { /* DELETE */ }),
        getActiveModelOverride: (chatJid) => dbTry(() => { /* JOIN model_menu */ }),

        // --- Logs (dashboard) ---
        insertLog: (log) => dbTry(() => { /* INSERT INTO logs */ }),
        queryLogs: (filters) => dbTry(() => { /* WHERE with dynamic filters */ }),
        insertContainerLog: (log) => dbTry(() => { /* INSERT INTO container_logs */ }),
        queryContainerLogs: (filters) => dbTry(() => { /* ... */ }),

        // --- Debug Events ---
        insertDebugEvent: (event) => dbTry(() => { /* INSERT INTO debug_events */ }),
        exportDebugEvents: (filters) => dbTry(() => { /* SELECT with WHERE */ }),
        pruneDebugEvents: (olderThan) => dbTry(() => { /* DELETE WHERE timestamp < ? */ }),
        getDebugEventStats: () => dbTry(() => ({
          count: /* SELECT COUNT(*) */,
          byCategory: /* GROUP BY category */,
          dateRange: /* MIN/MAX timestamp */,
        })),
      };
    }),
  );
```

### Tables (10 total, same schema as v1)

| Table | Purpose |
|---|---|
| `chats` | Registered chat metadata |
| `messages` | All messages (with `is_reset` for conversation boundaries) |
| `scheduled_tasks` | Cron/interval/once tasks |
| `task_run_logs` | Execution history for tasks |
| `logs` | Application-level logs (dashboard) |
| `container_logs` | Per-container execution logs |
| `debug_events` | Structured debug events with category/type |
| `model_menu` | Per-chat model swap options |
| `active_model_override` | Currently active model override per chat |

## Docker (`services/Docker.ts`)

**Source**: `src/container-runner.ts` (Docker CLI calls)

Wraps Docker CLI via `Bun.spawn`:

```typescript
export const DockerLive: Layer.Layer<Docker, DockerError, AppConfig> =
  Layer.effect(
    Docker,
    Effect.gen(function* () {
      const config = yield* AppConfig;

      const execDocker = (args: string[]) =>
        Effect.tryPromise({
          try: async () => {
            const proc = Bun.spawn(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' });
            const exitCode = await proc.exited;
            const stdout = await new Response(proc.stdout).text();
            const stderr = await new Response(proc.stderr).text();
            if (exitCode !== 0) throw new Error(stderr);
            return stdout;
          },
          catch: (err) => new DockerError({ operation: args[0], message: String(err) }),
        });

      return {
        isRunning: execDocker(['info']).pipe(Effect.map(() => true), Effect.orElse(() => Effect.succeed(false))),
        imageExists: (name) => execDocker(['image', 'inspect', name]).pipe(/* ... */),
        run: (args) => /* ... spawn with stdin pipe, timeout, label ... */,
        runDetached: (args) => /* ... docker run -d with named container, returns containerId ... */,
        stop: (containerId) => execDocker(['stop', containerId]),
        kill: (containerId) => execDocker(['kill', containerId]),
        rm: (containerId) => execDocker(['rm', '-f', containerId]),
        inspect: (containerId) => execDocker(['inspect', containerId]).pipe(Effect.map(JSON.parse)),
        listByLabel: (label) => execDocker(['ps', '-a', '--filter', `label=${label}`, '--format', '{{.ID}}\t{{.Names}}\t{{.Status}}']),
        killAllWithLabel: (label) => /* ... docker kill $(docker ps -q --filter label=...) ... */,
      };
    }),
  );
```

## Credentials (`services/Credentials.ts`)

**Source**: `src/container-runner.ts:resolveCredentials()`

Fallback chain: .env -> macOS Keychain -> ~/.claude/.credentials.json

```typescript
export const CredentialsLive: Layer.Layer<Credentials, CredentialError, AppConfig> =
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const config = yield* AppConfig;

      // Track last refresh attempt for debouncing
      const lastRefreshRef = yield* Ref.make<number>(0);

      const resolve = Effect.gen(function* () {
        // Try .env first
        const envResult = yield* tryEnvFile(config);
        if (envResult) return envResult;

        // Try macOS Keychain
        const keychainResult = yield* tryKeychain().pipe(Effect.orElse(() => Effect.succeed(null)));
        if (keychainResult) return keychainResult;

        // Try ~/.claude/.credentials.json
        const credFileResult = yield* tryCredentialsFile().pipe(Effect.orElse(() => Effect.succeed(null)));
        if (credFileResult) return credFileResult;

        return yield* Effect.fail(new CredentialError({ message: 'No credentials found' }));
      });

      const refreshOAuth = (creds: ResolvedCredentials) =>
        Effect.gen(function* () {
          const now = Date.now();
          const lastRefresh = yield* Ref.get(lastRefreshRef);

          // Debounce: don't retry within 2 minutes
          if (now - lastRefresh < REFRESH_DEBOUNCE_MS) return creds;

          // Only refresh if < 15 minutes remaining
          if (creds.expiresAt && creds.expiresAt - now > REFRESH_THRESHOLD_MS) return creds;

          yield* Ref.set(lastRefreshRef, now);

          // POST to refresh endpoint
          const refreshed = yield* Effect.tryPromise({
            try: () => fetch('https://auth.ide.new/oauth/token', {
              method: 'POST',
              body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: creds.refreshToken }),
            }).then(r => r.json()),
            catch: (err) => new CredentialError({ message: `OAuth refresh failed: ${err}` }),
          });

          // Write refreshed token back to BOTH keychain AND credentials file
          yield* writeToKeychain(refreshed).pipe(Effect.ignore);
          yield* writeToCredentialsFile(refreshed).pipe(Effect.ignore);

          return { ...creds, accessToken: refreshed.access_token, expiresAt: refreshed.expires_at };
        });

      const writeEnvFile = (creds: ResolvedCredentials) =>
        Effect.try({
          try: () => {
            const envContent = buildEnvFileContent(creds, config);
            const envDir = path.join(config.dataDir, 'env');
            fs.mkdirSync(envDir, { recursive: true });
            fs.writeFileSync(path.join(envDir, 'env'), envContent);
          },
          catch: (err) => new CredentialError({ message: `Failed to write env file: ${err}` }),
        });

      return { resolve, refreshOAuth, writeEnvFile };
    }),
  );
```

### Key Constants

| Constant | Value | Purpose |
|---|---|---|
| `REFRESH_THRESHOLD_MS` | 15 min | Refresh if token expires within this window |
| `REFRESH_DEBOUNCE_MS` | 2 min | Don't retry refresh within this window |
| Refresh endpoint | `https://auth.ide.new/oauth/token` | OAuth token refresh |

## Telegram (`services/Telegram.ts`)

**Source**: `src/telegram.ts`

Wraps grammY with `@grammyjs/runner` and `sequentialize` middleware. The `connect` method returns a `Stream<IncomingMessage>`:

```typescript
export const TelegramLive: Layer.Layer<Telegram, TelegramConnectionError, AppConfig> =
  Layer.scoped(
    Telegram,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const bot = new Bot(config.telegramBotToken);

      // Register scope finalizer
      yield* Effect.addFinalizer(() =>
        Effect.tryPromise({ try: () => bot.stop(), catch: /* ... */ }).pipe(Effect.ignore)
      );

      return {
        connect: Effect.gen(function* () {
          return Stream.async<IncomingMessage, TelegramError>((emit) => {
            bot.on('message:text', (ctx) => emit.single(mapTextMessage(ctx)));
            bot.on('message:voice', (ctx) => emit.single(mapVoiceMessage(ctx)));
            bot.on('message:photo', (ctx) => emit.single(mapPhotoMessage(ctx)));
            bot.on('message:document', (ctx) => emit.single(mapDocumentMessage(ctx)));
            bot.start({ onStart: () => emit.single(/* connected event */) });
          });
        }),

        // OnMessageStored callback pattern: store in DB first, then trigger processing
        onMessageStored: /* callback hook for after DB insert */,

        sendMessage: (chatId, text, options) =>
          Effect.tryPromise({
            try: () => bot.api.sendMessage(chatId, text, options),
            catch: (err) => new TelegramSendError({ chatId, message: String(err) }),
          }),
        editMessage: (chatId, messageId, text, options) => /* ... */,
        deleteMessage: (chatId, messageId) => /* ... */,
        sendPhoto: (chatId, source, options) => /* ... */,
        sendDocument: (chatId, source, options) => /* ... */,
        sendVoice: (chatId, source, options) => /* ... */,

        // Markdown-to-Telegram-HTML converter
        formatMarkdown: (text) => /* convert markdown to Telegram HTML entities */,

        // Slash command registration
        registerCommands: (commands) =>
          Effect.tryPromise({
            try: () => bot.api.setMyCommands(commands),
            catch: (err) => new TelegramSendError({ chatId: 0, message: String(err) }),
          }),

        // Raw bot access for advanced features (inline keyboards, etc.)
        bot,
      };
    }),
  );
```

### Telegram Features by Phase

**Phase 4 (this phase):**
- Bot connection + message stream (text, voice, photo, document)
- Send/edit/delete messages
- Markdown-to-HTML formatting
- Slash command registration (19 commands from v1)
- `OnMessageStored` callback pattern
- `sequentialize` middleware for per-chat ordering

**Deferred to later phases:**
- Self-update system (`/update`, `/rebuild`)
- Model swap inline keyboard
- Task management inline keyboard
- Skills command dynamic registration (Phase 5, with GroupCoordinator)

## ContainerRunner (`services/ContainerRunner.ts`)

**Source**: `src/container-runner.ts` (1870 lines)

The most complex service. Supports **dual mode**: persistent containers (default) and one-shot (`NANOCLAW_ONESHOT=1`).

### Persistent Mode (Default)

- `docker run -d` with named container (`nanoclaw-{groupFolder}`)
- Heartbeat polling (300ms interval, 30s timeout) via `data/ipc/{group}/agent-heartbeat`
- Unix socket RPC at `data/ipc/{group}/rpc.sock`
- Containers stay alive between messages, killed after `CONTAINER_IDLE_TIMEOUT` (10 min)
- Auto-fallback to one-shot on persistent failure

### One-Shot Mode

- `docker run -i --rm` with stdin/stdout JSON protocol
- Used when `NANOCLAW_ONESHOT=1` or as fallback from persistent failure

### Key Constants

| Constant | Value | Purpose |
|---|---|---|
| `HEARTBEAT_POLL_INTERVAL` | 300ms | Poll heartbeat file every 300ms |
| `CONTAINER_IDLE_TIMEOUT` | 10 min | Kill idle persistent containers |
| `MAX_AGENT_RETRIES` | 7 | Retry failed agent runs (env-configurable) |
| `AGENT_RETRY_DELAY` | 2000ms | Base delay, exponential backoff (`delay * 2^attempt`) |
| `REFRESH_THRESHOLD_MS` | 15 min | OAuth refresh threshold |
| `REFRESH_DEBOUNCE_MS` | 2 min | OAuth refresh debounce |

### Non-Retryable Errors

Detected by pattern-matching error strings (billing, rate_limit, authentication, overloaded, permission, model_not_found). These skip the retry loop entirely.

```typescript
export const ContainerRunnerLive: Layer.Layer<
  ContainerRunner,
  ContainerError,
  Docker | Credentials | AppConfig | Database
> = Layer.scoped(
  ContainerRunner,
  Effect.gen(function* () {
    const docker = yield* Docker;
    const credentials = yield* Credentials;
    const config = yield* AppConfig;

    // Track active persistent containers: groupFolder -> containerId
    const persistentContainers = yield* SynchronizedRef.make<Record<string, PersistentContainer>>({});

    // --- Idle cleanup fiber: check every 2 minutes, kill dead/idle containers ---
    const idleCleanupFiber = yield* Effect.fork(
      Effect.gen(function* () {
        const containers = yield* SynchronizedRef.get(persistentContainers);
        for (const [folder, info] of Object.entries(containers)) {
          const isAlive = yield* checkHeartbeat(folder).pipe(Effect.orElse(() => Effect.succeed(false)));
          const idleTime = Date.now() - info.lastActivity;
          if (!isAlive || idleTime > config.containerIdleTimeout) {
            yield* docker.kill(info.containerId).pipe(Effect.ignore);
            yield* SynchronizedRef.update(persistentContainers, (c) => {
              const { [folder]: _, ...rest } = c;
              return rest;
            });
          }
        }
      }).pipe(Effect.repeat(Schedule.fixed('2 minutes')))
    );

    // --- Orphan cleanup on startup ---
    yield* Effect.gen(function* () {
      const orphans = yield* docker.listByLabel('nanoclaw=agent');
      for (const orphan of parseContainerList(orphans)) {
        yield* docker.kill(orphan.id).pipe(Effect.ignore);
      }
    }).pipe(Effect.ignore);

    // --- Image self-heal: rebuild if missing, coalesce concurrent rebuilds ---
    const rebuildingRef = yield* Ref.make<Fiber.Fiber<boolean> | null>(null);
    const ensureImage = Effect.gen(function* () {
      const exists = yield* docker.imageExists(config.containerImage);
      if (exists) return true;

      // Coalesce concurrent rebuild requests
      const existing = yield* Ref.get(rebuildingRef);
      if (existing) return yield* Fiber.join(existing);

      const fiber = yield* Effect.fork(
        Effect.tryPromise({
          try: () => execSync('container/build.sh', { timeout: 120_000 }),
          catch: () => new ContainerBuildError({ message: 'build.sh failed' }),
        }).pipe(
          Effect.map(() => true),
          Effect.tap(() => Ref.set(rebuildingRef, null)),
        )
      );
      yield* Ref.set(rebuildingRef, fiber);
      return yield* Fiber.join(fiber);
    });

    // Register scope finalizer
    yield* Effect.addFinalizer(() =>
      Effect.all([
        Fiber.interrupt(idleCleanupFiber),
        // Kill all persistent containers
        SynchronizedRef.get(persistentContainers).pipe(
          Effect.flatMap((containers) =>
            Effect.all(
              Object.values(containers).map((c) => docker.kill(c.containerId).pipe(Effect.ignore))
            )
          ),
        ),
      ]).pipe(Effect.ignore)
    );

    return {
      runAgent: (group, prompt, handlers) =>
        Effect.scoped(
          Effect.gen(function* () {
            // Resolve + refresh credentials
            const creds = yield* credentials.resolve;
            const refreshed = yield* credentials.refreshOAuth(creds);
            yield* credentials.writeEnvFile(refreshed);

            // Build mounts
            const mounts = buildMounts(config, group);

            if (config.forceOneshot) {
              return yield* runOneShot(docker, config, group, mounts, prompt, handlers);
            }

            // Try persistent mode, fallback to one-shot
            return yield* runPersistent(docker, config, group, mounts, prompt, handlers).pipe(
              Effect.catchTag('PersistentContainerError', () =>
                runOneShot(docker, config, group, mounts, prompt, handlers)
              ),
            );
          }),
        ),

      interrupt: (groupFolder) =>
        Effect.gen(function* () {
          // Write cancel file to IPC directory
          const cancelPath = path.join(config.dataDir, 'ipc', groupFolder, 'cancel');
          yield* Effect.try({ try: () => fs.writeFileSync(cancelPath, ''), catch: () => new ContainerError({}) });
          // Escalate: SIGTERM after 5s grace period if still running
          yield* Effect.sleep('5 seconds');
          const container = yield* SynchronizedRef.get(persistentContainers).pipe(
            Effect.map(c => c[groupFolder])
          );
          if (container) {
            yield* docker.kill(container.containerId).pipe(Effect.ignore);
          }
        }),

      killAll: Effect.gen(function* () {
        yield* docker.killAllWithLabel('nanoclaw=agent');
        yield* SynchronizedRef.set(persistentContainers, {});
      }),

      ensureImage,

      cleanupOrphans: /* ... (runs on startup, already shown above) */,

      getStatus: /* ... list all persistent containers with heartbeat status ... */,
    };
  }),
);
```

### Retry Logic (in GroupCoordinator, not ContainerRunner)

The retry loop with exponential backoff and non-retryable error detection lives in the GroupCoordinator (Phase 5), not in ContainerRunner itself. ContainerRunner handles a single run attempt; the coordinator orchestrates retries.

## GroupRegistry (`state/GroupRegistry.ts`)

**Source**: `src/index.ts` (global `registeredGroups` Map)

**IMPORTANT**: Groups are loaded from a **JSON file** (`data/registered_groups.json`), NOT from the database.

```typescript
export const GroupRegistryLive: Layer.Layer<GroupRegistry, never, AppConfig> =
  Layer.effect(
    GroupRegistry,
    Effect.gen(function* () {
      const config = yield* AppConfig;

      // Load from JSON file (not database)
      const filePath = path.join(config.dataDir, 'registered_groups.json');
      const initial = yield* Effect.try({
        try: () => {
          if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, RegisteredGroup>;
          }
          return {};
        },
        catch: () => ({}), // Default to empty on error
      });

      const ref = yield* SynchronizedRef.make(initial);

      const persist = SynchronizedRef.get(ref).pipe(
        Effect.flatMap((groups) =>
          Effect.try({
            try: () => fs.writeFileSync(filePath, JSON.stringify(groups, null, 2)),
            catch: (err) => new GroupRegistryError({ message: `Failed to persist: ${err}` }),
          })
        ),
      );

      return {
        get: (chatJid) => SynchronizedRef.get(ref).pipe(Effect.map(groups => groups[chatJid] ?? null)),
        getAll: SynchronizedRef.get(ref),
        getByFolder: (folder) => SynchronizedRef.get(ref).pipe(
          Effect.map(groups => Object.values(groups).find(g => g.folder === folder) ?? null)
        ),
        register: (chatJid, group) => SynchronizedRef.update(ref, (groups) =>
          ({ ...groups, [chatJid]: group })
        ).pipe(Effect.tap(() => persist)),
        update: (chatJid, fn) => SynchronizedRef.update(ref, (groups) => {
          const existing = groups[chatJid];
          if (!existing) return groups;
          return { ...groups, [chatJid]: fn(existing) };
        }).pipe(Effect.tap(() => persist)),
        remove: (chatJid) => SynchronizedRef.update(ref, (groups) => {
          const { [chatJid]: _, ...rest } = groups;
          return rest;
        }).pipe(Effect.tap(() => persist)),
      };
    }),
  );
```

## MessagePipeline (`coordinators/MessagePipeline.ts`)

**Source**: `src/streaming-pipeline.ts` (430 lines)

Port of the per-run Telegram message lifecycle. This is significantly more complex than a simple accumulator:

### Key Constants

| Constant | Value | Purpose |
|---|---|---|
| `STATUS_EDIT_INTERVAL_MS` | 2500ms | Rate-limit Telegram message edits |
| `MAX_CHUNK` | 4000 chars | Max chars per Telegram message |
| `HIDDEN_TOOLS` | `send_message`, `send_file`, `send_voice` | Tools that don't show as status indicators |

### Pipeline Phases

`idle` -> `thinking` -> `tool_active` -> `responding` -> `done`

```typescript
export const createMessagePipeline = (chatId: number, replyToMessageId: number) =>
  Effect.gen(function* () {
    const telegram = yield* Telegram;

    // State
    let phase: PipelinePhase = 'idle';
    let statusMsgId: number | null = null;
    let buffer = '';
    let lastEditTime = 0;
    let toolHistory: string[] = [];
    let overflowMessageIds: number[] = [];
    let voiceDedupSet = new Set<string>(); // Track voice messages sent in this pipeline

    return {
      onThinking: () => Effect.gen(function* () {
        phase = 'thinking';
        // Send initial "thinking..." status message
        const msg = yield* telegram.sendMessage(chatId, '...', { reply_to_message_id: replyToMessageId });
        statusMsgId = msg.message_id;
      }),

      onToolUse: (toolName: string) => Effect.gen(function* () {
        // Hidden tools don't update status
        if (HIDDEN_TOOLS.has(toolName)) return;

        phase = 'tool_active';
        toolHistory.push(toolName);
        // Update status message with tool indicator
        if (statusMsgId) {
          yield* telegram.editMessage(chatId, statusMsgId, formatToolStatus(toolHistory));
        }
      }),

      onTextDelta: (text: string) => Effect.gen(function* () {
        phase = 'responding';
        buffer += text;

        const now = Date.now();
        if (now - lastEditTime < STATUS_EDIT_INTERVAL_MS) return; // Rate limit edits
        lastEditTime = now;

        // Delete previous overflow messages
        for (const id of overflowMessageIds) {
          yield* telegram.deleteMessage(chatId, id).pipe(Effect.ignore);
        }
        overflowMessageIds = [];

        // Split into chunks at line boundaries
        const chunks = splitIntoChunks(buffer, MAX_CHUNK);
        if (statusMsgId) {
          yield* telegram.editMessage(chatId, statusMsgId, chunks[0]);
        }

        // Send overflow chunks as additional messages
        for (const chunk of chunks.slice(1)) {
          const msg = yield* telegram.sendMessage(chatId, chunk);
          overflowMessageIds.push(msg.message_id);
        }
      }),

      // CUA screenshot/status (edits in-place, separate from text buffer)
      onCuaStatus: (screenshotPath: string | null, statusText: string) => /* ... */,

      onDone: (finalText: string) => Effect.gen(function* () {
        phase = 'done';
        // Final edit with complete text
        if (statusMsgId && finalText) {
          const chunks = splitIntoChunks(finalText, MAX_CHUNK);
          yield* telegram.editMessage(chatId, statusMsgId, telegram.formatMarkdown(chunks[0]));
          for (const chunk of chunks.slice(1)) {
            yield* telegram.sendMessage(chatId, telegram.formatMarkdown(chunk));
          }
        }
      }),

      onError: (error: string) => Effect.gen(function* () {
        phase = 'done';
        if (statusMsgId) {
          const truncated = error.length > MAX_CHUNK ? error.slice(-MAX_CHUNK) : error;
          yield* telegram.editMessage(chatId, statusMsgId, truncated).pipe(Effect.ignore);
        }
      }),

      // Voice dedup: prevent sending same voice message twice in one pipeline
      hasVoiceSent: (key: string) => voiceDedupSet.has(key),
      markVoiceSent: (key: string) => { voiceDedupSet.add(key); },
    };
  });
```

## Layer Composition (`layers/Live.ts`)

**IMPORTANT**: Use `Layer.provideMerge` chain, NOT `Layer.mergeAll`. `mergeAll` doesn't resolve inter-layer dependencies. Services depend on each other (e.g., ContainerRunner needs Docker, Credentials, AppConfig, Database), so layers must be composed in dependency order:

```typescript
export const MainLive = AppConfigLive.pipe(
  Layer.provideMerge(DatabaseLive),
  Layer.provideMerge(DockerLive),
  Layer.provideMerge(CredentialsLive),
  Layer.provideMerge(TelegramLive),
  Layer.provideMerge(ContainerRunnerLive),
  Layer.provideMerge(GroupRegistryLive),
  // Phase 5 layers added later:
  // Layer.provideMerge(SchedulerLive),
  // Layer.provideMerge(SandboxLive),
  // ...
);
```

## Checklist

- [ ] Implement `DatabaseLive` Layer — wrap all 10 tables, use `Effect.try` for typed errors
  - [ ] Messages (store, history with reset boundaries, insertConversationReset)
  - [ ] Chats (upsert, dashboard queries)
  - [ ] Tasks (CRUD, due queries, getTaskByShortId)
  - [ ] Task run logs
  - [ ] Model menu (add, remove, get, set/clear active override)
  - [ ] Logs + container logs (insert, query)
  - [ ] Debug events (insert, export, prune, stats)
- [ ] Implement `DockerLive` Layer — wrap Docker CLI (run, runDetached, stop, kill, inspect, listByLabel)
- [ ] Implement `CredentialsLive` Layer — fallback chain + OAuth refresh with debouncing + writeEnvFile
- [ ] Implement `TelegramLive` Layer — grammY with sequentialize, message stream, send/edit/delete, formatMarkdown, registerCommands
- [ ] Implement `ContainerRunnerLive` Layer — dual mode (persistent + one-shot), idle cleanup fiber, orphan cleanup, image self-heal, interrupt with cancel file + SIGTERM escalation
- [ ] Implement `GroupRegistryLive` — SynchronizedRef + JSON file persistence (NOT database)
- [ ] Implement `MessagePipeline` — phases, rate-limited edits, MAX_CHUNK splitting, hidden tools, overflow messages, voice dedup, CUA status
- [ ] Update `layers/Live.ts` with `Layer.provideMerge` chain (NOT `Layer.mergeAll`)
- [ ] Test database operations (all 10 tables, conversation reset boundaries)
- [ ] Test Docker operations (image check, container run detached, heartbeat)
- [ ] Test Telegram connection (bot.start, message stream, command registration)
- [ ] Test credential refresh debouncing and env file writing
- [ ] Test container idle cleanup and orphan cleanup
