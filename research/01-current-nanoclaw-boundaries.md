# Current NanoClaw Boundaries

Last verified: 2026-02-18

## Container Lifecycle and RPC Surface
Confidence: 0.96

- [Direct evidence] `src/index.ts` imports and orchestrates `runContainerAgent`, `interruptContainer`, `writeTasksSnapshot`, `writeGroupsSnapshot`, and consumes host RPC events/requests from the container runner.
  - Source: `src/index.ts`
- [Direct evidence] `src/container-runner.ts` defines core host/container contracts: `ContainerInput`, `ContainerOutput`, `HostRpcRequest`, `HostRpcEvent`, `HostRpcHandlers`.
  - Source: `src/container-runner.ts`
- [Direct evidence] `runContainerAgent()` in `src/container-runner.ts` is the primary execution path and contains persistent/one-shot handling.
  - Source: `src/container-runner.ts`
- [Direct evidence] The newline-delimited JSON RPC framing is defined in `src/rpc-protocol.ts`.
  - Source: `src/rpc-protocol.ts`

## Sandbox Lifecycle and Browser Isolation Path
Confidence: 0.94

- [Direct evidence] `src/sandbox-manager.ts` exports `ensureSandbox`, `getSandboxUrl`, `resetSandbox`, `resetSandboxFull`, `rotateSandboxVncPassword`, and drives Docker-based CUA lifecycle.
  - Source: `src/sandbox-manager.ts`
- [Direct evidence] Sandbox usage is wired through browse and host flows (`src/browse-host.ts`, `src/index.ts`, `src/telegram.ts`, `src/dashboard-server.ts`).
  - Source: `src/browse-host.ts`, `src/index.ts`, `src/telegram.ts`, `src/dashboard-server.ts`

## Mount and Access Controls
Confidence: 0.95

- [Direct evidence] `src/mount-security.ts` enforces allowlist-based mount validation with blocked patterns and read-only coercion for non-main contexts.
  - Source: `src/mount-security.ts`
- [Direct evidence] `src/container-runner.ts` calls `validateAdditionalMounts()` before preparing mounts.
  - Source: `src/container-runner.ts`

## Host RPC Authorization Layer
Confidence: 0.97

- [Direct evidence] `src/host-rpc-router.ts` routes `telegram.sendMessage`, `telegram.sendVoice`, `telegram.sendFile`, `tasks.handle`, and `browse.handle`.
  - Source: `src/host-rpc-router.ts`
- [Direct evidence] Authorization checks are enforced via `isAuthorizedTarget(...)` before message/file/voice sends.
  - Source: `src/host-rpc-router.ts`

## Temporary Keep Set During Migration
Confidence: 0.93

- [Direct evidence] `src/task-scheduler.ts` directly invokes `runContainerAgent` and `writeTasksSnapshot`.
  - Source: `src/task-scheduler.ts`
- [Direct evidence] `src/telegram.ts` invokes `ensureSandbox` for browser-related actions.
  - Source: `src/telegram.ts`
- [Inference] `src/skills.ts` and `src/log-sync.ts` can remain until Go sandbox core stabilizes because they do not own sandbox lifecycle orchestration.
  - Source context: `src/skills.ts`, `src/log-sync.ts`, `src/index.ts`

## Migration-Critical Breakpoints
Confidence: 0.9

- [Direct evidence] The most coupled replacement points are `src/container-runner.ts`, `src/sandbox-manager.ts`, `src/mount-security.ts`, `src/host-rpc-router.ts`.
  - Source: imports and call sites in `src/index.ts`, `src/task-scheduler.ts`, `src/dashboard-server.ts`
- [Inference] A phased cutover should keep existing TS modules as API clients of new Go services before complete replacement.
  - Supporting context: current dependency graph across `src/index.ts` and scheduler/telegram modules.
