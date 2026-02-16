# Architecture — Effect Runtime v2

## Directory Structure

```
san-diego/
  src/                              # Existing v1 (untouched)
  src-v2/                           # New Effect host runtime
    index.ts                        # Entry point: bootstrap + BunRuntime.runMain
    config.ts                       # AppConfig service (env vars via Effect Config)
    errors.ts                       # All tagged error types

    services/
      Database.ts                   # bun:sqlite wrapped as Effect Service
      Telegram.ts                   # grammY bot -> Effect Stream<IncomingMessage>
      Docker.ts                     # Docker CLI operations
      ContainerRunner.ts            # Persistent + one-shot container lifecycle (scoped)
      Credentials.ts                # Keychain / .env / OAuth fallback chain
      Sandbox.ts                    # CUA sandbox lifecycle (scoped resource)
      BrowseHost.ts                 # Browse request/response + wait_for_user
      Scheduler.ts                  # Task scheduling fiber
      TTS.ts                        # TTS dispatch (Qwen/Replicate/Freya)
      Supermemory.ts                # Long-term memory
      Media.ts                      # Audio transcription, file download

    coordinators/
      GroupCoordinator.ts           # Per-group fiber: message queue + auto-interrupt
      MessagePipeline.ts            # Per-run Telegram message lifecycle
      MessageRouter.ts              # Routes Telegram stream -> group coordinators

    state/
      GroupRegistry.ts              # SynchronizedRef<Record<string, RegisteredGroup>>

    schemas/
      ContainerIO.ts                # Effect Schema for container input/output
      IpcMessages.ts                # IPC message schemas
      RpcProtocol.ts                # RPC wire format schemas
      Tasks.ts                      # Scheduled task schemas
      Groups.ts                     # RegisteredGroup schema

    layers/
      Live.ts                       # Production layer composition
      Test.ts                       # Test layer composition (mocked services)

  container/agent-runner-v2/        # New Effect container agent
    package.json
    tsconfig.json
    src/
      index.ts                      # Entry point: mode detection + Effect runtime
      errors/                       # Tagged errors (ToolError, AdapterError, RpcError, etc.)
      services/
        HostBridge.ts               # RPC communication (replaces global activeBridge)
        ToolRegistry.ts             # Modular tool loading + dispatch
        Cancellation.ts             # Fiber-based interruption (replaces file polling)
        PromptBuilder.ts            # SOUL.md injection, prompt prep
        StatusEmitter.ts            # Status event emission (RPC or file fallback)
      schemas/                      # Effect Schema for container I/O, RPC, events
      tools/
        index.ts                    # Collects all tool modules
        types.ts                    # NanoTool interface (handler returns Effect)
        communication.ts            # send_message, send_file, send_voice
        audio.ts                    # download_audio, convert_audio, transcribe_audio
        tasks.ts                    # schedule_task, list/pause/resume/cancel
        groups.ts                   # register_group
        skills.ts                   # store/list/delete_skill
        browse.ts                   # All browse_* tools
        firecrawl.ts                # firecrawl_scrape/crawl/map
        memory.ts                   # memory_save/search
      adapters/
        index.ts                    # createAdapter factory
        types.ts                    # ProviderAdapter returns Stream<AgentEvent>
        claude-adapter.ts           # Claude SDK -> Effect Stream
        openai-adapter.ts           # OpenAI function-calling loop -> Effect Stream
        minimax-adapter.ts          # MiniMax Anthropic-compat -> Effect Stream
      rpc/
        protocol.ts                 # Serialize/parse (unchanged wire format)
        server.ts                   # Unix socket RPC server as Effect Layer
        oneshot.ts                  # Stdin/stdout one-shot mode
      mcp/
        ipc-mcp.ts                  # Maps Effect tools -> Claude SDK MCP format
```

## Key Architectural Decisions

1. **Effect Services & Layers** for all subsystems — typed DI, testable, composable
2. **Fiber supervision tree** — MainFiber -> TelegramFiber + MessageRouterFiber (-> per-group GroupCoordinatorFibers) + SchedulerFiber + SandboxIdleFiber + etc.
3. **Scoped resources** — containers and sandbox auto-cleanup on fiber interruption via `Effect.scoped` finalizers
4. **Push-based messaging** — Telegram `Stream<IncomingMessage>` routed to per-group `Queue<IncomingMessage>` (replaces DB polling)
5. **Fiber-based cancellation** — `Effect.Deferred` signal + `Fiber.interrupt` replaces cooperative file polling
6. **Tagged errors** at every boundary (DatabaseError, DockerError, ContainerError, TelegramError, etc.)
7. **Effect Schema** for container I/O boundaries; **Zod kept for tool argument schemas** (Claude SDK MCP and OpenAI function-calling consume Zod shapes directly)
8. **SynchronizedRef** replaces global Maps (`registeredGroups`, `activeRuns`)
9. **grammY stays** — wrapped in Telegram service, updates bridged to Effect Stream
10. **bun:sqlite stays** — synchronous calls wrapped with `Effect.sync()`

## Layer Dependency Tree (Host)

```
AppConfig (no deps — reads env vars)
+-- Database (AppConfig)
+-- Docker (AppConfig)
|   +-- Credentials (AppConfig)
|   +-- ContainerRunner (Docker, Credentials, AppConfig) [scoped]
|   +-- Sandbox (Docker, AppConfig) [scoped]
+-- Telegram (AppConfig) [scoped]
+-- BrowseHost (Sandbox, Docker, AppConfig)
+-- Scheduler (Database, ContainerRunner, GroupRegistry)
+-- TTS (AppConfig)
+-- Supermemory (AppConfig)
+-- Media (AppConfig)
+-- GroupRegistry (Database, AppConfig) [SynchronizedRef]
+-- MessageRouter (GroupRegistry, Telegram, Database, ContainerRunner,
                   BrowseHost, Scheduler, TTS, Supermemory, Media)
```

## Fiber Supervision Tree (Host)

```
MainFiber (app root — SIGINT/SIGTERM interrupts everything)
+-- TelegramFiber (grammY runner -> pushes to MessageRouter)
+-- MessageRouterFiber (routes stream -> per-group coordinators)
|   +-- GroupCoordinatorFiber("main") [spawned on demand]
|   |   +-- ContainerFiber [scoped per-run, interruptible]
|   +-- GroupCoordinatorFiber("group2")
|   |   +-- ContainerFiber
|   +-- ...
+-- SchedulerFiber (Effect.schedule every 60s, forks ContainerFibers)
+-- SandboxIdleFiber (checks every 60s)
+-- ContainerCleanupFiber (checks every 2min)
+-- IpcWatcherFiber (1s poll — backward compat only)
+-- DashboardFiber, TakeoverFiber, etc.
```

**Auto-interrupt**: When new message arrives for a group with active ContainerFiber, GroupCoordinator interrupts the existing fiber before starting a new one.

**Graceful shutdown**: MainFiber scope finalizers cascade — kill containers, stop sandbox, disconnect Telegram, close DB.

## Container Agent Services

| Service | Replaces | Key Improvement |
|---------|----------|-----------------|
| `HostBridge` | Global `activeBridge` variable | Per-connection via Effect context, no global state |
| `ToolRegistry` | Monolithic `tool-registry.ts` (2,243 lines) | 9 modular files, Effect-based handlers |
| `Cancellation` | File-based `isCancelled()` polling | Fiber interruption via `Deferred` + `Fiber.interrupt` |
| `PromptBuilder` | Inline `preparePrompt()` | Testable service with SOUL.md injection |
| `StatusEmitter` | Mixed RPC/file emission | Unified interface, mode-aware Layer |

**Type changes:**
- Tool handlers: `Promise<ToolResult>` -> `Effect<ToolResult, ToolError, HostBridge>`
- Adapters: `AsyncGenerator<AgentEvent>` -> `Stream<AgentEvent, AdapterError, HostBridge | ToolRegistry | Cancellation>`
