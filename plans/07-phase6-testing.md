# Phase 6: Integration + Testing

## Goal

Verify the Effect runtime works end-to-end with real Telegram bot, Docker containers, and all subsystems. Build test layers for unit testing.

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
    // ... all methods with in-memory implementations
  },
);

// Example: Test Docker that simulates container runs
export const DockerTest: Layer.Layer<Docker> = Layer.succeed(
  Docker,
  {
    isRunning: Effect.succeed(true),
    run: (args) => Effect.succeed({ containerId: 'test-123', writeStdin: async () => {}, readStdout: async () => '...' }),
    // ...
  },
);

// Compose all test layers
export const TestLayer = Layer.mergeAll(
  AppConfigTest,
  DatabaseTest,
  DockerTest,
  TelegramTest,
  ContainerRunnerTest,
  // ...
);
```

## Integration Tests

### 1. Database Operations

```bash
# Test CRUD operations against real SQLite
bun test src-v2/__tests__/database.test.ts
```

- Store and retrieve messages
- Store and retrieve tasks
- Conversation history ordering and limits
- Task due date queries

### 2. Docker Operations

```bash
# Test Docker CLI wrapper (requires Docker running)
bun test src-v2/__tests__/docker.test.ts
```

- Check Docker is running
- Image exists / pull
- Container run + collect output
- Container kill + cleanup

### 3. Container Compatibility

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

### 4. Telegram Connection

```bash
# Test with real bot token (manual)
TELEGRAM_BOT_TOKEN=xxx bun src-v2/index.ts
```

- Bot connects and receives messages
- Messages stream to correct group coordinators
- Send/edit/delete messages work
- Photo/document/voice sending works

### 5. Auto-Interrupt

1. Send message to trigger container run
2. While container is running, send another message
3. Verify first container is interrupted (fiber.interrupt)
4. Verify second message is processed
5. Verify Telegram message indicates interruption

### 6. Graceful Shutdown

1. Start the v2 runtime
2. Trigger a container run
3. Send SIGINT
4. Verify:
   - Running container is killed
   - Sandbox is stopped (if running)
   - Telegram bot disconnects
   - SQLite database is closed
   - Process exits cleanly

### 7. Scheduler

1. Create a "once" task due in 5 seconds
2. Wait for scheduler tick (60s, or reduce for testing)
3. Verify container runs with task prompt
4. Verify task status updated in DB

### 8. CUA Sandbox

1. Trigger a `browse_navigate` tool call
2. Verify sandbox container starts (lazy start)
3. Verify screenshot is captured and sent
4. Wait 30+ minutes (or reduce idle timeout)
5. Verify sandbox auto-stops

### 9. Tool Operations

Test each tool category:
- Communication: `send_message` -> verify IPC file created
- Audio: `download_audio` -> verify yt-dlp runs
- Tasks: `schedule_task` -> verify task in DB
- Browse: `browse_navigate` -> verify sandbox request
- Firecrawl: `firecrawl_scrape` -> verify API call
- Memory: `memory_save` -> verify Supermemory API call
- Skills: `store_skill` -> verify skill file created
- Groups: `register_group` -> verify group in registry

## Performance Verification

- Effect runtime overhead should be negligible (<5ms per message routing)
- Fiber interruption should be near-instant (no polling delay)
- Memory usage should be comparable to v1 (Effect is lean)
- Stream backpressure should prevent queue buildup

## Checklist

- [ ] Create `layers/Test.ts` with mocked services
- [ ] Write database unit tests
- [ ] Write Docker unit tests
- [ ] Test v2 host -> v1 container compatibility
- [ ] Test v1 host -> v2 container compatibility
- [ ] Test Telegram connection + message routing
- [ ] Test auto-interrupt scenario
- [ ] Test graceful shutdown
- [ ] Test scheduler task execution
- [ ] Test CUA sandbox lifecycle
- [ ] Test all 22 tool operations
- [ ] Performance benchmarks vs v1
- [ ] Update `package.json` with `test:v2` script
