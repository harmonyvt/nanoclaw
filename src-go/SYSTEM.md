# `src-go` System Documentation

## Scope

`src-go` is the Go control-plane scaffold for NanoClaw sandboxing. It currently provides:

- task admission and policy signing,
- sandbox lifecycle state management,
- session metadata tracking,
- event fanout and optional state persistence.

Important reality: execution is still simulated. The APIs and contracts are in place, but there is no real Firecracker launch path in this code yet.

## Branch Delta vs `main`

Compared with `main` (`git diff main...HEAD`), this branch introduces:

1. `.gitignore` update to unignore `src-go/internal/store/*.go`.
2. New `src-go/internal/store/store.go` with `MemoryStore` (sandbox/task/session/event persistence + optional JSON disk state).

Impact:

- `nanoclawd` and `sessiond` now depend on a concrete Go store package in `src-go/internal/store/store.go`.
- State persistence behavior is now explicit in Go (`NANOCLAW_GO_STATE_FILE`) rather than implied by missing scaffolding.

## Runtime Services

### `cmd/nanoclawd`

Main control-plane HTTP API.

- Loads config from `internal/config`.
- Wires `store.MemoryStore`, `vm.Supervisor`, `policy.Engine`, `reconciler.Reconciler`, `session.Manager`, and the API server together.
- Serves:
  - `GET /healthz`
  - `POST /v1/tasks/runs`
  - `GET /v1/tasks/{id}`
  - `POST /v1/sandboxes`
  - `POST /v1/sandboxes/{id}:start|stop|destroy|snapshot`
  - `POST /v1/sessions`
  - `GET /v1/events/stream`

### `cmd/sessiond`

Session-focused service for metadata operations.

- Uses its own in-memory store instance (`store.NewMemoryStore("")`), intentionally non-persistent.
- Serves:
  - `GET /healthz`
  - `POST /v1/sessions`
  - `POST /v1/sessions/{id}:input`
  - `POST /v1/sessions/{id}:resize`
  - `POST /v1/sessions/{id}:terminate`

### `cmd/vm-supervisor`

Supervisor-only API around `internal/vm`.

- Serves:
  - `GET /healthz`
  - `POST /v1/supervisor/sandboxes`
  - `GET /v1/supervisor/sandboxes/{id}`
  - `POST /v1/supervisor/sandboxes/{id}:start|stop|snapshot|destroy|killswitch`

### `cmd/devctl`

Bubble Tea remote dashboard that drives `scripts/remote-firecracker.sh` workflows
(`doctor`, `setup`, `sync`, `up`, `status`, `smoke`, `logs`, `test`, `down`, `restart`),
with parsed service health snapshots and command output/history panes.

## Internal Package Map

### `internal/contracts`

Shared types for tasks, sandboxes, capability policy, signed policy decisions, sessions, and events.

### `internal/api`

HTTP handlers and in-process event bus:

- validates and parses requests,
- creates IDs where needed,
- coordinates policy + supervisor + reconciler + store,
- emits events and streams them to subscribers.

### `internal/policy`

Policy engine:

- denies missing `risk_class`,
- denies empty egress rules,
- denies revoked secrets,
- signs decisions with HMAC-SHA256 digest/signature.

Also includes helper checks for filesystem scopes and egress rules.

### `internal/reconciler`

Desired-state loop:

- `running|started` -> `StartSandbox`
- `stopped` -> `StopSandbox`
- `destroyed` -> `DestroySandbox`

Writes reconciled status and heartbeat back to store.

### `internal/session`

Session metadata manager:

- create session (default command `sh`),
- append input history (in-memory only),
- record resize (in-memory only),
- mark terminated (persisted session status).

### `internal/vm`

Supervisor state machine (simulated):

- create/start/stop/destroy/snapshot/kill-switch transitions,
- idempotent start/stop behavior,
- per-sandbox status map with summary output.

### `internal/store`

`MemoryStore` with optional file-backed persistence:

- entities: sandboxes, tasks, sessions, events,
- thread-safe map/slice access,
- atomic persistence via temp file + rename when `stateFile` is configured.

## End-to-End Flow

### Task Run (`POST /v1/tasks/runs`)

1. Decode `TaskRunSpec`, auto-fill task/sandbox IDs if absent.
2. Evaluate policy and produce signed decision.
3. If denied: persist `TaskRunResult{status=denied}`, emit `task.denied`, return `403`.
4. If allowed: build `SandboxSpec`, create sandbox in supervisor, persist to store.
5. Reconcile desired state to running.
6. Persist success `TaskRunResult`, emit `task.completed`, return `202`.

Output is currently simulated (`"simulated execution completed"` or echoed command text).

### Sandbox Actions (`POST /v1/sandboxes/{id}:{action}`)

1. Load sandbox from store.
2. For `start|stop|destroy`: set desired state, persist, reconcile, persist updated status.
3. For `snapshot`: call supervisor snapshot directly and persist status.
4. Emit state/snapshot events and return `202`.

### Sessions

- `nanoclawd`: supports session creation only (`POST /v1/sessions`).
- `sessiond`: supports create/input/resize/terminate.
- Session input/resize do not control a real PTY yet; they update manager metadata only.

### Events

- Every emitted event is appended to the store and fanned out to subscribers.
- Stream endpoint is best-effort fanout with buffered channels; slow clients can miss events.

## Configuration

From `internal/config/config.go`:

- `NANOCLAW_GO_API_ADDR` (default `:8088`)
- `NANOCLAW_GO_SESSION_ADDR` (default `:8089`)
- `NANOCLAW_GO_SUPERVISOR_ADDR` (default `:8071`)
- `NANOCLAW_GO_STATE_FILE` (optional persisted JSON state path)
- `NANOCLAW_GO_POLICY_KEY` (HMAC signing key)
- `NANOCLAW_GO_FIRECRACKER_BIN` (optional binary path)
- `NANOCLAW_GO_SIMULATED_VM` (default `true`, forced `false` when firecracker bin is set)

## Test Coverage Snapshot

Current coverage includes:

- policy denials, helper checks, and signature verification (`internal/policy/engine_test.go`),
- task run + sandbox stop API happy path (`internal/api/server_test.go`),
- reconcile-to-running drift healing (`internal/reconciler/reconciler_test.go`),
- supervisor lifecycle idempotency (`internal/vm/supervisor_test.go`),
- multi-service script-driven smoke flow (`scripts/e2e.sh`).

Notably thin/absent:

- broader API error-path coverage,
- reconciler failure-mode tests,
- durable event replay/ordering guarantees,
- real VM execution behavior (still simulated),
- PTY-backed session behavior.

## Migration Alignment

Per `src-go/MIGRATION.md`:

- `src/container-runner.ts` -> `src-go/cmd/nanoclawd`
- `src/sandbox-manager.ts` -> `src-go/cmd/vm-supervisor`
- `src/mount-security.ts` -> `src-go/internal/policy`
- `src/host-rpc-router.ts` -> `src-go/internal/contracts`

`src/telegram.ts`, `src/task-scheduler.ts`, `src/skills.ts`, and `src/log-sync.ts` remain in TS during phased cutover.

## Known Limits and Sharp Edges

1. Simulated backend: setting `NANOCLAW_GO_FIRECRACKER_BIN` changes mode flags but does not add real Firecracker execution logic by itself.
2. Session actions are metadata-only; no active terminal bridge is wired.
3. Event stream is best-effort and may drop messages for slow subscribers.
4. With `NANOCLAW_GO_STATE_FILE` enabled, full state is rewritten on each mutation; event growth is currently unbounded.
