# NanoClaw Effect Runtime v2 — Overview

## What This Is

A complete rewrite of NanoClaw's internals using the [Effect](https://effect.website) TypeScript library. The existing v1 runtime (`src/` and `container/agent-runner/`) stays untouched. The new runtime lives side-by-side in `src-v2/` (host) and `container/agent-runner-v2/` (container agent).

## Why

The v1 runtime works but has structural pain points:

| Problem | v1 Approach | v2 Solution |
|---------|-------------|-------------|
| No structured concurrency | Manual `Promise.all`, callback chains | Effect Fibers with supervision tree |
| No typed errors | `try/catch` with `unknown` | `Data.TaggedError` at every boundary |
| Hard-to-test services | Global singletons, import-time side effects | `Context.Tag` + `Layer` DI |
| Global mutable state | `Map<string, ...>` module-level | `SynchronizedRef` |
| Cooperative cancellation | File polling (`isCancelled()`) | `Deferred` + `Fiber.interrupt` |
| Monolithic tool registry | Single 2,243-line file (37 tools) | 9 modular tool modules |
| DB polling for messages | 1-second poll loop | Push-based `Stream<IncomingMessage>` |
| Manual resource cleanup | `finally` blocks, easy to miss | `Effect.scoped` finalizers |

## Key Constraint: Wire Protocol Compatibility

The Effect runtime does **NOT** change any external interfaces:

- **Container I/O**: Same JSON over stdin/stdout (sentinel markers) and same JSON-RPC over Unix sockets
- **IPC files**: Same directory structure, same file formats
- **Telegram**: Same bot token, same commands, same message format
- **Docker**: Same image, same volume mounts, same env vars
- **SQLite**: Same database schema

This means v1 containers work with v2 host and vice versa — enabling incremental migration.

## Implementation Phases

| Phase | Scope | Status |
|-------|-------|--------|
| **Phase 1** | Foundation scaffolding (types, schemas, interfaces) | **COMPLETE** |
| **Phase 2** | Container agent — 37 tools decomposed into 9 modules | Pending |
| **Phase 3** | Container agent — adapters (Claude/OpenAI/MiniMax) + RPC + entry point | Pending |
| **Phase 4** | Host — core services (DB, Docker, Telegram, Credentials, ContainerRunner) | Pending |
| **Phase 5** | Host — coordinators (MessageRouter, GroupCoordinator, Scheduler, BrowseHost) | Pending |
| **Phase 6** | Integration testing + v1/v2 compatibility verification | Pending |

## Scope

These plans cover the core runtime: message routing, container lifecycle, tool dispatch, adapter pattern, task scheduling, browser automation bridge, and TTS dispatch. This represents roughly 40% of the v1 host functionality — the essential runtime loop.

### Out of Scope (Deferred)

The following v1 subsystems are explicitly excluded from the initial v2 migration. They can be ported later as independent services/fibers without blocking the core runtime:

- **Dashboard server** — HTTP debug UI for monitoring active runs
- **Self-update system** — Git pull + rebuild + restart automation
- **CUA takeover server** — Express server for browser handoff web UI
- **CUA trajectory recording** — Action replay/logging for browse sessions
- **Log sync** — Remote log shipping/aggregation
- **Service log writer** — Structured log file management
- **Debug UI** — Browser-based inspection tools
- **noVNC proxy** — WebSocket proxy for CUA live view
- **OmniParser integration** — Vision-based element detection (experimental)
- **Model swap system** — Runtime model switching via commands
- **Freya TTS** — Archived TTS provider (superseded by Qwen3-TTS)

## Plan Documents

| File | Contents |
|------|----------|
| `00-overview.md` | This file |
| `01-architecture.md` | Directory structure, layer tree, fiber tree, key decisions |
| `02-phase1-complete.md` | What was built in Phase 1, all files created |
| `03-phase2-tools.md` | Container agent tool decomposition plan |
| `04-phase3-adapters.md` | Container agent adapters + RPC + entry point |
| `05-phase4-host-services.md` | Host core service implementations |
| `06-phase5-coordinators.md` | Host coordinators + subsystems |
| `07-phase6-testing.md` | Integration testing + verification |
