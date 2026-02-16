# Phase 6: Integration + Testing

## Goal

Verify the Effect runtime works end-to-end with real Telegram bot, Docker containers, and all subsystems. Build test layers for unit testing. Validate all 37 tool operations, persistent container mode, retry logic, and Effect-specific patterns.

## Test Layer (`layers/Test.ts`)

Mock implementations for every service, enabling isolated unit tests:

```typescript
// Example: Test Database that uses in-memory arrays
export const DatabaseTest: Layer.Layer<Database> = Layer.succeed(
  Database,
  {
    storeTextMessage: (msg) => Effect.sync(() => { messages.push(msg); }),
    getConversationHistory: (chatJid, limit) => Effect.succeed(
      messages.filter(m => m.chatJid === chatJid).slice(-limit)
    ),
    insertConversationReset: (chatJid) => Effect.sync(() => {
      messages.push({ chatJid, sender: 'SYSTEM', text: '[reset]', isReset: true });
    }),
    // Model menu methods
    addModelToMenu: () => Effect.void,
    getModelMenu: () => Effect.succeed([]),
    setActiveModelOverride: () => Effect.void,
    getActiveModelOverride: () => Effect.succeed(null),
    // Debug event methods
    insertDebugEvent: () => Effect.void,
    exportDebugEvents: () => Effect.succeed([]),
    getDebugEventStats: () => Effect.succeed({ count: 0, byCategory: {}, dateRange: null }),
    // ... all other methods with in-memory implementations
  },
);

// Example: Test Docker that simulates container runs
export const DockerTest: Layer.Layer<Docker> = Layer.succeed(
  Docker,
  {
    isRunning: Effect.succeed(true),
    imageExists: () => Effect.succeed(true),
    run: (args) => Effect.succeed({ containerId: 'test-123', writeStdin: async () => {}, readStdout: async () => '...' }),
    runDetached: (args) => Effect.succeed({ containerId: 'test-detached-123' }),
    stop: () => Effect.void,
    kill: () => Effect.void,
    rm: () => Effect.void,
    inspect: () => Effect.succeed({}),
    listByLabel: () => Effect.succeed(''),
    killAllWithLabel: () => Effect.void,
  },
);

// Test AgentSemaphore (no concurrency limit in tests)
export const AgentSemaphoreTest = Layer.effect(
  AgentSemaphore,
  Effect.makeSemaphore(100), // Effectively unlimited in tests
);

// Compose all test layers using provideMerge chain (same pattern as MainLive)
export const TestLayer = AppConfigTest.pipe(
  Layer.provideMerge(DatabaseTest),
  Layer.provideMerge(DockerTest),
  Layer.provideMerge(TelegramTest),
  Layer.provideMerge(AgentSemaphoreTest),
  Layer.provideMerge(ContainerRunnerTest),
  // ...
);
```

## Unit Tests

### 1. Database Operations

```bash
# Test CRUD operations against real SQLite
bun test src-v2/__tests__/database.test.ts
```

- Store and retrieve messages
- Store and retrieve tasks (create, update, delete, getTaskByShortId)
- Conversation history ordering and limits
- **Conversation reset boundaries**: insert reset marker, verify `getConversationHistory` only returns messages after the most recent reset
- Task due date queries
- Model menu operations (add, remove, get, set/clear active override)
- Debug events (insert, export with filters, prune by date, stats aggregation)
- Logs and container logs (insert, query with filters)
- Chat upsert and dashboard queries (getChatsWithCounts)

### 2. Docker Operations

```bash
# Test Docker CLI wrapper (requires Docker running)
bun test src-v2/__tests__/docker.test.ts
```

- Check Docker is running
- Image exists / pull
- Container run (one-shot) + collect output
- Container runDetached + inspect + stop + kill
- Container listByLabel
- Container killAllWithLabel (cleanup)

### 3. Persistent Container Mode

```bash
bun test src-v2/__tests__/persistent-container.test.ts
```

- **Heartbeat monitoring**: start persistent container, verify heartbeat file appears within 30s
- **Container reuse**: send two messages to same group, verify same container ID used
- **Idle timeout cleanup**: start container, wait past idle timeout (use short timeout in test), verify container killed
- **Auto-fallback to one-shot**: simulate persistent container failure, verify fallback to one-shot mode succeeds
- **Orphan cleanup on startup**: create orphan containers with `nanoclaw=agent` label, verify cleanup on ContainerRunner init

### 4. Retry Logic

```bash
bun test src-v2/__tests__/retry-logic.test.ts
```

- **Non-retryable error detection**: verify `billing`, `rate_limit`, `authentication`, `overloaded`, `permission`, `model_not_found` errors skip retry loop
- **Exponential backoff**: verify delay pattern is `AGENT_RETRY_DELAY * 2^attempt`
- **Max retries**: verify loop stops after `MAX_AGENT_RETRIES` (7) attempts
- **Retryable success**: fail first 2 attempts, succeed on 3rd, verify output returned

### 5. Container Compatibility

```bash
# v2 host spawns v1 container
bun src-v2/index.ts  # (with test message)

# v1 host spawns v2 container
bun src/index.ts  # (with CONTAINER_ENTRYPOINT pointing to v2)
```

- Verify same JSON input format works
- Verify same JSON output format returned
- Verify IPC file formats unchanged
- Verify RPC wire protocol unchanged

### 6. Credential Refresh

```bash
bun test src-v2/__tests__/credentials.test.ts
```

- OAuth refresh debouncing (second call within 2 min returns cached)
- Token threshold check (only refresh if < 15 min remaining)
- Env file writing (verify file content matches expected format)
- Fallback chain order (.env -> keychain -> credentials file)

### 7. Filesystem Tools

```bash
bun test src-v2/__tests__/filesystem-tools.test.ts
```

- `read_file` with valid path returns content
- `read_file` with path outside workspace fails with authorization error
- `write_file` with valid path creates/overwrites file
- `write_file` with path traversal attempt (`../`) fails

## Integration Tests

### 8. Telegram Connection

```bash
# Test with real bot token (manual)
TELEGRAM_BOT_TOKEN=xxx bun src-v2/index.ts
```

- Bot connects and receives messages
- Messages stream to correct group coordinators
- Send/edit/delete messages work
- Photo/document/voice sending works
- Slash command registration (19 commands)

### 9. Auto-Interrupt

1. Send message to trigger container run
2. While container is running, send another message
3. Verify first container fiber is interrupted (via `Cause.isInterruptedOnly`)
4. Verify second message is processed
5. Verify Telegram message indicates interruption

### 10. Graceful Shutdown

1. Start the v2 runtime with `BunRuntime.runMain`
2. Trigger a container run
3. Send SIGINT
4. Verify:
   - Running container is killed
   - Sandbox is stopped (if running)
   - Telegram bot disconnects
   - SQLite database is closed
   - Process exits cleanly (exit code 0)

### 11. Scheduler

1. Create a "once" task due in 5 seconds
2. Wait for scheduler tick (60s, or reduce for testing)
3. Verify container runs with task prompt
4. Verify task status updated in DB
5. Verify task snapshot written to `current_tasks.json`

### 12. CUA Sandbox

1. Trigger a `browse_navigate` tool call
2. Verify sandbox container starts (lazy start)
3. Verify screenshot is captured and sent
4. Wait 30+ minutes (or reduce idle timeout)
5. Verify sandbox auto-stops

### 13. Tool Operations

Test all 37 tool categories:

**Communication (3 tools)**:
- `send_message` -> verify IPC file created
- `send_file` -> verify file path validation and IPC
- `send_voice` -> verify TTS dispatch and IPC

**Audio (3 tools)**:
- `download_audio` -> verify yt-dlp runs
- `convert_audio` -> verify ffmpeg conversion
- `transcribe_audio` -> verify Replicate API call

**Tasks (4 tools)**:
- `schedule_task` -> verify task in DB
- `list_tasks` -> verify task listing
- `pause_task` / `resume_task` / `cancel_task` -> verify status updates

**Groups (1 tool)**:
- `register_group` -> verify group in registry

**Skills (3 tools)**:
- `store_skill` -> verify skill file created
- `list_skills` -> verify skill listing
- `delete_skill` -> verify skill file deleted

**Browse (13 tools)**:
- `browse_navigate` -> verify sandbox request
- `browse_snapshot` -> verify a11y tree returned
- `browse_click` -> verify element finding + click
- `browse_click_xy` -> verify coordinate click
- `browse_type_at_xy` -> verify coordinate type
- `browse_perform` -> verify multi-step action sequence
- `browse_fill` -> verify element finding + fill
- `browse_scroll` -> verify scroll command
- `browse_screenshot` -> verify screenshot captured + sent as photo
- `browse_wait_for_user` -> verify takeover URL + VNC password rotation
- `browse_go_back` -> verify back navigation
- `browse_close` -> verify page close
- `browse_extract_file` / `browse_upload_file` -> verify file transfer

**Firecrawl (3 tools)**:
- `firecrawl_scrape` -> verify API call
- `firecrawl_crawl` -> verify crawl with depth/limit
- `firecrawl_map` -> verify URL discovery

**Memory (2 tools)**:
- `memory_save` -> verify Supermemory API call
- `memory_search` -> verify search results

**Filesystem (2 tools)**:
- `read_file` -> verify content returned with path validation
- `write_file` -> verify file written with path validation

**Other (3 tools)**:
- `browse_evaluate` -> verify backward compat stub
- `download_audio` -> already counted above under Audio

### 14. IPC Authorization

```bash
bun test src-v2/__tests__/ipc-authorization.test.ts
```

- Non-main group writes IPC message targeting **own** chat -> processed
- Non-main group writes IPC message targeting **other** chat -> rejected with log
- Non-main group writes IPC task targeting **own** group -> processed
- Non-main group writes IPC task targeting **other** group -> rejected with log
- Main group writes IPC message targeting any chat -> processed

## Effect Pattern Tests

### 15. Layer.provideMerge Composition

```bash
bun test src-v2/__tests__/layer-composition.test.ts
```

- Verify `MainLive` layer builds without missing dependency errors
- Verify services can access their dependencies (e.g., ContainerRunner can access Docker, Credentials)
- Verify circular dependency detection (should not exist)

### 16. Fiber Interrupt Handling

```bash
bun test src-v2/__tests__/fiber-interrupt.test.ts
```

- Fork a long-running Effect, interrupt it, verify `Cause.isInterruptedOnly` returns true
- Verify interrupted fiber's finalizers run (cleanup)
- Verify `Effect.catchAllCause` with `Cause.isInterruptedOnly` catches interrupts correctly
- Verify non-interrupt failures are NOT caught by `isInterruptedOnly`

### 17. BunRuntime.runMain Signal Handling

```bash
bun test src-v2/__tests__/runtime-signals.test.ts
```

- Start program with `BunRuntime.runMain`, send SIGINT, verify graceful shutdown
- Verify all scoped resources are finalized
- Verify exit code is 0 on clean shutdown

### 18. Stream.asyncScoped for Adapters (if applicable)

- Verify adapter streams properly clean up on scope exit
- Verify backpressure works correctly

## Performance Verification

- Effect runtime overhead should be negligible (<5ms per message routing)
- Fiber interruption should be near-instant (no polling delay)
- Memory usage should be comparable to v1 (Effect is lean)
- Stream backpressure should prevent queue buildup
- Persistent container reuse should reduce latency vs one-shot (~1-2s saved per message)

## Checklist

- [ ] Create `layers/Test.ts` with mocked services (all interfaces, using `Layer.provideMerge`)
- [ ] Write database unit tests (all 10 tables, conversation reset boundaries)
- [ ] Write Docker unit tests (run, runDetached, inspect, cleanup)
- [ ] Write persistent container mode tests (heartbeat, reuse, idle timeout, fallback, orphan cleanup)
- [ ] Write retry logic tests (non-retryable detection, exponential backoff, max retries)
- [ ] Write credential refresh tests (debouncing, threshold, env file writing)
- [ ] Write filesystem tool tests (read_file, write_file with path validation)
- [ ] Test v2 host -> v1 container compatibility
- [ ] Test v1 host -> v2 container compatibility
- [ ] Test Telegram connection + message routing
- [ ] Test auto-interrupt scenario (verify `Cause.isInterruptedOnly`)
- [ ] Test graceful shutdown (via `BunRuntime.runMain`)
- [ ] Test scheduler task execution + task snapshot writing
- [ ] Test CUA sandbox lifecycle (lazy start, idle timeout, VNC password rotation)
- [ ] Test all 37 tool operations
- [ ] Test IPC authorization (non-main group restrictions)
- [ ] Test Layer.provideMerge composition (no missing dependencies)
- [ ] Test fiber interrupt handling patterns
- [ ] Test BunRuntime.runMain signal handling
- [ ] Performance benchmarks vs v1
- [ ] Update `package.json` with `test:v2` script
