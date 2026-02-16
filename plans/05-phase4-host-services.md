# Phase 4: Host — Core Services

## Goal

Implement the Live Layers for core host services: AppConfig (done), Database, Docker, Credentials, Telegram, ContainerRunner, GroupRegistry, and MessagePipeline.

## AppConfig — DONE (Phase 1)

Already fully implemented in `src-v2/config.ts`. Reads 75+ env vars with proper defaults.

## Database (`services/Database.ts`)

**Source**: `src/db.ts`

Wraps bun:sqlite. All operations are synchronous so we use `Effect.sync()`:

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
      yield* Effect.sync(() => runMigrations(db));

      // Register scope finalizer
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => { db.close(); })
      );

      return {
        storeTextMessage: (msg) => Effect.sync(() => {
          const stmt = db.prepare('INSERT INTO messages ...');
          stmt.run(msg.chatJid, msg.sender, msg.text, msg.timestamp);
        }),
        getConversationHistory: (chatJid, limit) => Effect.sync(() => {
          const stmt = db.prepare('SELECT * FROM messages WHERE chat_jid = ? ORDER BY id DESC LIMIT ?');
          return stmt.all(chatJid, limit) as MessageRow[];
        }),
        // ... all other methods
      };
    }),
  );
```

Key tables (same schema as v1): `messages`, `chats`, `tasks`, `task_run_logs`

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
        // ... etc
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

      return { resolve, refreshOAuth: /* ... */, writeEnvFile: /* ... */ };
    }),
  );
```

## Telegram (`services/Telegram.ts`)

**Source**: `src/telegram.ts`

Wraps grammY. The `connect` method returns a `Stream<IncomingMessage>`:

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
        sendMessage: (chatId, text, options) =>
          Effect.tryPromise({
            try: () => bot.api.sendMessage(chatId, text, options),
            catch: (err) => new TelegramSendError({ chatId, message: String(err) }),
          }),
        // ... other methods wrapping bot.api calls
      };
    }),
  );
```

## ContainerRunner (`services/ContainerRunner.ts`)

**Source**: `src/container-runner.ts`

The most complex service. `runAgent` is a scoped resource that:
1. Resolves credentials
2. Builds volume mounts
3. Spawns Docker container
4. Handles RPC events (persistent) or stdout parsing (one-shot)
5. Returns results + auto-cleanup on scope exit

```typescript
export const ContainerRunnerLive: Layer.Layer<
  ContainerRunner,
  ContainerError,
  Docker | Credentials | AppConfig | Database
> = Layer.effect(
  ContainerRunner,
  Effect.gen(function* () {
    const docker = yield* Docker;
    const credentials = yield* Credentials;
    const config = yield* AppConfig;

    return {
      runAgent: (group, prompt, handlers) =>
        Effect.scoped(
          Effect.gen(function* () {
            // Resolve credentials
            const creds = yield* credentials.resolve;
            yield* credentials.writeEnvFile(creds);

            // Build mounts
            const mounts = buildMounts(config, group);

            // Spawn container
            const proc = yield* docker.run({ image: config.containerImage, mounts, /* ... */ });

            // Register finalizer to kill container on interrupt
            yield* Effect.addFinalizer(() =>
              docker.stop(proc.containerId).pipe(Effect.ignore)
            );

            // Write input to stdin
            yield* Effect.tryPromise({ try: () => proc.writeStdin(JSON.stringify(input)), /* ... */ });

            // Read output with timeout
            const output = yield* Effect.tryPromise({ try: () => proc.readStdout(), /* ... */ }).pipe(
              Effect.timeout(config.containerTimeout),
              Effect.catchTag('TimeoutException', () =>
                Effect.fail(new ContainerTimeoutError({ groupFolder: group.folder }))
              ),
            );

            return parseContainerOutput(output);
          }),
        ),

      interrupt: (groupFolder) => /* ... */,
      killAll: docker.killAllWithLabel('nanoclaw-agent'),
      ensureImage: /* ... */,
      cleanupOrphans: /* ... */,
    };
  }),
);
```

## GroupRegistry (`state/GroupRegistry.ts`)

**Source**: `src/index.ts` (global `registeredGroups` Map)

```typescript
export const GroupRegistryLive: Layer.Layer<GroupRegistry, DatabaseError, Database | AppConfig> =
  Layer.effect(
    GroupRegistry,
    Effect.gen(function* () {
      const db = yield* Database;
      const config = yield* AppConfig;

      // Initialize from database + filesystem
      const initial = yield* loadGroupsFromDb(db, config);
      const ref = yield* SynchronizedRef.make(initial);

      return {
        get: (folder) => SynchronizedRef.get(ref).pipe(Effect.map(groups => groups[folder] ?? null)),
        getAll: SynchronizedRef.get(ref),
        register: (group) => SynchronizedRef.update(ref, (groups) => ({ ...groups, [group.folder]: group })),
        update: (folder, fn) => SynchronizedRef.update(ref, (groups) => {
          const existing = groups[folder];
          if (!existing) return groups;
          return { ...groups, [folder]: fn(existing) };
        }),
        remove: (folder) => SynchronizedRef.update(ref, (groups) => {
          const { [folder]: _, ...rest } = groups;
          return rest;
        }),
        loadFromDatabase: /* ... */,
      };
    }),
  );
```

## MessagePipeline (`coordinators/MessagePipeline.ts`)

**Source**: `src/streaming-pipeline.ts` (`StreamingMessagePipeline` class)

Port of the per-run Telegram message lifecycle: sends initial "thinking" message, accumulates text deltas, edits message periodically, handles tool use indicators, sends final message.

```typescript
export const createMessagePipeline = (chatId: number, replyToMessageId: number) =>
  Effect.gen(function* () {
    const telegram = yield* Telegram;
    let statusMsgId: number | null = null;
    let buffer = '';

    return {
      onTextDelta: (text: string) => Effect.gen(function* () {
        buffer += text;
        if (!statusMsgId) {
          statusMsgId = yield* telegram.sendStatusMessage(chatId, buffer);
        } else {
          yield* telegram.editStatusMessage(chatId, statusMsgId, buffer);
        }
      }),
      onToolUse: (toolName: string) => /* update status message */,
      onDone: (finalText: string) => /* send final message, delete status */,
      onError: (error: string) => /* send error message */,
    };
  });
```

## Checklist

- [ ] Implement `DatabaseLive` Layer (wrap bun:sqlite operations)
- [ ] Implement `DockerLive` Layer (wrap Docker CLI)
- [ ] Implement `CredentialsLive` Layer (fallback chain)
- [ ] Implement `TelegramLive` Layer (grammY -> Effect Stream)
- [ ] Implement `ContainerRunnerLive` Layer (scoped lifecycle)
- [ ] Implement `GroupRegistryLive` (SynchronizedRef + DB load)
- [ ] Implement `MessagePipeline` (streaming message lifecycle)
- [ ] Update `layers/Live.ts` with all service layers
- [ ] Test database operations (CRUD for messages, chats, tasks)
- [ ] Test Docker operations (image check, container run)
- [ ] Test Telegram connection (bot.start, message stream)
