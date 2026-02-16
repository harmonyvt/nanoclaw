# Phase 1: Foundation Scaffolding — COMPLETE

## What Was Done

- Installed `effect` v3.19.17 via `bun add effect`
- Created `tsconfig.v2.json` for `src-v2/`
- Added `dev:v2`, `build:v2`, `typecheck:v2` scripts to `package.json`
- Created all host runtime files (27 TypeScript files in `src-v2/`)
- Created all container agent files (18 TypeScript files in `container/agent-runner-v2/src/`)
- Both runtimes compile cleanly with zero errors
- Host entry point boots and reads config from `.env`
- Container entry point runs and outputs valid JSON

## Host Files Created (src-v2/)

### Core
| File | Purpose | Status |
|------|---------|--------|
| `index.ts` | Entry point — boots Effect runtime, reads AppConfig, logs startup | Scaffold (logs + exits) |
| `config.ts` | `AppConfig` service — 75+ env var mappings with defaults | **Fully implemented** |
| `errors.ts` | 20+ tagged error classes via `Data.TaggedError` | **Fully implemented** |

### Schemas (Effect Schema at I/O boundaries)
| File | Purpose |
|------|---------|
| `schemas/index.ts` | Re-exports all schemas |
| `schemas/ContainerIO.ts` | `ContainerInput`, `ContainerOutput` (**BUG**: `status` is `Schema.Literal('success', 'error')` but should be `Schema.Literal('success', 'error', 'interrupted')` to match host expectations) |
| `schemas/RpcProtocol.ts` | `RpcRequestMessage`, `RpcResponseMessage`, `RpcEventMessage`, `RpcMessage` union |
| `schemas/Groups.ts` | `ProviderConfig`, `AdditionalMount`, `ContainerConfig`, `RegisteredGroup` |
| `schemas/Tasks.ts` | `ScheduledTask`, `TaskRunLog` |
| `schemas/IpcMessages.ts` | `IpcTextMessage`, `IpcVoiceMessage`, `IpcFileMessage`, `IpcTaskMessage`, `IpcMessage` union, `PipelineEvent` |

### Services (Context.Tag + interface, no Live Layer implementations yet)
| File | Key Types / Methods |
|------|---------------------|
| `services/index.ts` | Re-exports |
| `services/Database.ts` | `MessageRow`, `ChatRow`, `NewMessage`; `initDatabase`, `storeTextMessage`, `storeMediaMessage`, `getConversationHistory`, `getAllChats`, `getAllTasks`, `getDueTasks`, etc. |
| `services/Telegram.ts` | `IncomingMessage`; `connect` (returns `Stream`), `sendMessage`, `sendPhoto`, `sendDocument`, `sendVoice`, `editMessageText`, `deleteMessage`, `setTyping`, `stop` |
| `services/Docker.ts` | `VolumeMount`, `DockerRunArgs`, `DockerProcess`; `isRunning`, `imageExists`, `pullImage`, `run`, `exec`, `stop`, `remove`, `inspect`, `killAllWithLabel` |
| `services/ContainerRunner.ts` | `HostRpcRequest`, `HostRpcEvent`, `HostRpcHandlers`, `InterruptResult`; `runAgent` (scoped), `interrupt`, `killAll`, `ensureImage`, `cleanupOrphans` |
| `services/Credentials.ts` | `CredentialResult`; `resolve`, `refreshOAuth`, `writeEnvFile` |
| `services/Sandbox.ts` | `SandboxConnection`; `acquire` (scoped), `isRunning`, `stop`, `executeCommand`, `takeScreenshot` |
| `services/BrowseHost.ts` | `BrowseResult`; `handleRequest`, `handleWaitForUser`, `isActive` |
| `services/Scheduler.ts` | `TaskRunResult`; `start`, `stop`, `createTask`, `pauseTask`, `resumeTask`, `cancelTask`, `listTasks`, `runDueTasks` |
| `services/TTS.ts` | `TTSResult`, `VoiceProfile`; `synthesize`, `loadVoiceProfile` |
| `services/Supermemory.ts` | `MemorySearchResult`; `search`, `store`, `storeConversation` |
| `services/Media.ts` | `transcribeAudio`, `downloadFile`, `cleanupOldMedia` |

### State
| File | Purpose |
|------|---------|
| `state/GroupRegistry.ts` | `GroupRegistry` service — `SynchronizedRef<Record<string, RegisteredGroup>>` interface with `get`, `getAll`, `register`, `update`, `remove`, `loadFromDatabase` |

### Coordinators (stubs for Phase 5)
| File | Purpose |
|------|---------|
| `coordinators/GroupCoordinator.ts` | Per-group fiber with message queue + auto-interrupt |
| `coordinators/MessagePipeline.ts` | Per-run Telegram message lifecycle (streaming updates) |
| `coordinators/MessageRouter.ts` | Routes Telegram stream to group coordinators |

### Layers
| File | Purpose |
|------|---------|
| `layers/Live.ts` | Currently only includes `AppConfigLive` (grows as services are implemented) |
| `layers/Test.ts` | Stub for Phase 6 |

## Container Agent Files Created (container/agent-runner-v2/src/)

### Core
| File | Purpose | Status |
|------|---------|--------|
| `index.ts` | Mode detection (one-shot vs persistent), Effect runtime entry | Scaffold (outputs error JSON) |
| `errors/index.ts` | 5 tagged errors: `ToolError`, `AdapterError`, `RpcError`, `CancellationError`, `ValidationError` | **Fully implemented** |

### Schemas
| File | Purpose |
|------|---------|
| `schemas/index.ts` | Re-exports |
| `schemas/ContainerIO.ts` | `ContainerInput`, `ContainerOutput` (mirrors host schema) |
| `schemas/AgentEvent.ts` | 7 event variants: `SessionInitEvent`, `ResultEvent`, `ResponseDeltaEvent`, `ToolStartEvent`, `ToolProgressEvent`, `ThinkingEvent`, `AdapterStderrEvent` |
| `schemas/RpcProtocol.ts` | `RpcRequest`, `RpcResponse`, `RpcEvent` |
| `schemas/IpcContext.ts` | `IpcMcpContext` (chatJid, groupFolder, isMain) |
| `schemas/ToolResult.ts` | `ToolResult` — flat struct: `{ content: string, isError?: boolean, imageBase64?: string, imageMimeType?: string }` (matches v1 return type) |

### Services
| File | Purpose | Status |
|------|---------|--------|
| `services/index.ts` | Re-exports | Done |
| `services/HostBridge.ts` | `HostBridge` Context.Tag + interface; stub layers: `HostBridgePersistent`, `HostBridgeOneShot`, `HostBridgeTest` | Interface only |
| `services/ToolRegistry.ts` | `ToolRegistry` Context.Tag + interface (`listTools`, `dispatch`, `getToolSchemas`) | Interface only |
| `services/Cancellation.ts` | `Cancellation` Context.Tag; **`CancellationLive` Layer fully implemented** using `Deferred` + `Fiber.interrupt` | **Live Layer done** |
| `services/PromptBuilder.ts` | `PromptBuilder` Context.Tag; **`PromptBuilderLive` Layer implemented** (reads SOUL.md, injects markers) | **Live Layer done** |
| `services/StatusEmitter.ts` | `StatusEmitter` Context.Tag; stub layers: `StatusEmitterRpc` (via HostBridge), `StatusEmitterFile` (via fs) | Interface only |

### Tools
| File | Purpose |
|------|---------|
| `tools/types.ts` | `NanoTool` interface — handler returns `Effect<ToolResult, ToolError, HostBridge>` |
| `tools/index.ts` | `ALL_TOOLS` array — empty, populated in Phase 2 |

### Adapters
| File | Purpose |
|------|---------|
| `adapters/types.ts` | `AdapterInput` interface, `ProviderAdapter` interface returning `Stream<AgentEvent>` |
| `adapters/index.ts` | `createAdapter` factory — throws (Phase 3) |

## Config Files
| File | Purpose |
|------|---------|
| `tsconfig.v2.json` | TypeScript config for `src-v2/` (target ES2022, NodeNext modules, strict) |
| `container/agent-runner-v2/package.json` | Dependencies: `effect`, `@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/sdk`, `openai`, `zod`, etc. |
| `container/agent-runner-v2/tsconfig.json` | TypeScript config for container agent |

## package.json Scripts Added
```json
"dev:v2": "bun --watch src-v2/index.ts",
"build:v2": "tsc -p tsconfig.v2.json",
"typecheck:v2": "tsc -p tsconfig.v2.json --noEmit"
```

## Known Issues & Gaps (to address in subsequent phases)

### Schema Bugs

- **`ContainerOutput.status`**: Missing `'interrupted'` literal — currently `Schema.Literal('success', 'error')`, should be `Schema.Literal('success', 'error', 'interrupted')` to match host-side handling.

### Missing v1 Schemas

The following v1 interfaces have no v2 Effect Schema equivalents yet:

- **`Skill`** — skill definition with name, description, instructions, parameters
- **`MountAllowlist` / `AllowedRoot`** — security allowlist for additional container mounts
- **`Session`** — session ID mapping per group

### Zod v4 Compatibility Note

The container agent (`container/agent-runner-v2/package.json`) uses **Zod v4** (`"zod": "^4.0.0"`) while v1 uses Zod v3. The `zod-to-json-schema` package (`"^3.0.0"`) must be verified for Zod v4 compatibility — the Zod v4 API has breaking changes in `.describe()`, `.transform()`, and schema introspection that could affect JSON Schema generation for OpenAI function calling.

### Service Interface Gaps

All services have `Context.Tag` + interface defined, but the following methods listed in interfaces are not yet implemented (stubs only). These need implementation in their respective phases:

| Service | Missing from scaffolding vs interface |
|---------|--------------------------------------|
| `Credentials` | `writeEnvFile` — needs implementation in Phase 4 |
| `Scheduler` | `stop`, `createTask`, `pauseTask`, `resumeTask`, `cancelTask`, `listTasks`, `runDueTasks` — all Phase 5 |
| `Sandbox` | `isRunning`, `stop` — Phase 4 |
| `BrowseHost` | Method naming: scaffolding uses `handleRequest` but v1 uses `processAction` — reconcile in Phase 5 |
| `TTS` | `loadVoiceProfile` — Phase 4 |
| `Supermemory` | `storeConversation` — Phase 4 |
| `GroupRegistry` | `update`, `remove`, `loadFromDatabase` — Phase 4 |
| `Database` | `createTask`, `updateTask`, `deleteTask` — Phase 4 |

These are expected gaps — Phase 1 is scaffolding only. Listed here to ensure nothing is missed during implementation.
