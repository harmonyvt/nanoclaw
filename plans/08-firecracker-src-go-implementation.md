# Firecracker VM Implementation Plan for `src-go`

Last updated: 2026-02-19

## Goal

Replace the simulated VM lifecycle in `src-go` with a real Firecracker-backed runtime while preserving current API shape and phased TS-to-Go cutover assumptions in `src-go/MIGRATION.md`.

## What Research Implies

From `research/00-index.md` through `research/06-claim-validation-ledger.md`, the practical baseline for NanoClaw V1 is:

1. MicroVM-only execution path.
2. Deny-by-default egress with explicit allowlists.
3. Signed capability policy per run.
4. Kill-switch workflow (quarantine, freeze, terminate, revoke).
5. Auditable and replayable lifecycle events.

Important constraint from research: microVMs are necessary but not sufficient. The Firecracker path must be paired with explicit policy enforcement and telemetry, not treated as a full security boundary by itself.

## Current `src-go` Gaps

Observed in `src-go/internal/vm/supervisor.go`, `src-go/internal/api/server.go`, and `src-go/SYSTEM.md`:

1. `Supervisor` is in-memory state only, with no process lifecycle.
2. `NANOCLAW_GO_FIRECRACKER_BIN` currently toggles mode flags but does not launch Firecracker.
3. `TaskRunResult.Output` is simulated text.
4. `snapshot` increments a counter only; no VM snapshot artifact.
5. Kill-switch sets status but does not freeze/kill runtime resources.

## Target Runtime Design

## 1) Split VM control into backend interface + implementations

Create a backend boundary in `src-go/internal/vm`:

- `SimulatedBackend` (existing behavior).
- `FirecrackerBackend` (new).

Suggested interface:

```go
type Backend interface {
    CreateSandbox(ctx context.Context, spec contracts.SandboxSpec) (contracts.SandboxStatus, error)
    StartSandbox(ctx context.Context, id string) (contracts.SandboxStatus, error)
    StopSandbox(ctx context.Context, id string) (contracts.SandboxStatus, error)
    SnapshotSandbox(ctx context.Context, id string) (contracts.SandboxStatus, error)
    DestroySandbox(ctx context.Context, id string) (contracts.SandboxStatus, error)
    KillSwitch(ctx context.Context, id string, reason string) (contracts.SandboxStatus, error)
    GetStatus(ctx context.Context, id string) (contracts.SandboxStatus, error)
    Summary() map[string]any
}
```

`Supervisor` becomes orchestration/state guard, delegating runtime operations to the selected backend.

## 2) Firecracker lifecycle implementation (new package)

Add `src-go/internal/vm/firecracker/` with:

- Process launch and API socket lifecycle.
- VM configuration calls (machine config, boot source, drives, optional network).
- Per-sandbox runtime directory ownership and cleanup.
- PID and socket tracking.
- Snapshot artifact management.

Suggested files:

- `backend.go`: backend implementation entrypoint.
- `process.go`: launch/stop/firecracker process supervision.
- `api_client.go`: Unix-socket HTTP client for Firecracker control API.
- `models.go`: internal runtime metadata.
- `snapshot.go`: create/restore bookkeeping.
- `network_none.go` and later `network_tap.go`: staged network implementation.

## 3) Config model expansion

Extend `src-go/internal/config/config.go` to avoid mode ambiguity:

- `NANOCLAW_GO_VM_BACKEND=simulated|firecracker` (default `simulated`).
- `NANOCLAW_GO_FIRECRACKER_BIN` (required when backend is `firecracker`).
- `NANOCLAW_GO_JAILER_BIN` (optional for later jailer support).
- `NANOCLAW_GO_VM_STATE_DIR` (runtime files, sockets, snapshots).
- `NANOCLAW_GO_VM_KERNEL_IMAGE` (default kernel path fallback).
- `NANOCLAW_GO_VM_NET_MODE=none|tap` (start with `none`).
- `NANOCLAW_GO_VM_STOP_TIMEOUT_MS`.

Keep legacy `NANOCLAW_GO_SIMULATED_VM` temporarily for compatibility, but mark as deprecated once backend flag exists.

## 4) Contract additions for real runtime observability

Extend `src-go/internal/contracts/types.go`:

- Add runtime fields to `SandboxStatus`:
  - `Backend string`
  - `VMID string`
  - `PID int`
  - `APISocket string`
  - `LastExitCode int`
  - `SnapshotRef string`

Prefer additive fields to preserve compatibility with existing API clients.

## 5) Reconciler hardening

`src-go/internal/reconciler/reconciler.go` should move to explicit transition handling:

- Validate legal transitions (`stopped -> running`, `running -> stopped`, etc.).
- Add retry/backoff for transient runtime errors.
- Classify terminal vs retryable failures.
- Persist failure reason with machine-parseable error codes.

## 6) API behavior updates

`src-go/internal/api/server.go`:

1. `POST /v1/tasks/runs`
   - Stop returning simulated output for successful task creation.
   - Return accepted execution metadata and sandbox state.
2. `POST /v1/sandboxes/{id}:snapshot`
   - Return snapshot ref/path metadata from backend.
3. `sandbox.state_changed` and `sandbox.snapshot` events
   - Include backend/runtime metadata for audit.

## 7) Store and event durability changes

`src-go/internal/store/store.go`:

- Persist expanded `SandboxStatus` runtime metadata.
- Add bounded event retention or rolling file strategy (to avoid unbounded growth noted in `src-go/SYSTEM.md`).
- Keep atomic write behavior.

## 8) Kill-switch execution path

Implement concrete kill-switch stages in backend:

1. Mark sandbox `quarantined`.
2. Freeze/throttle runtime resources (where supported).
3. Terminate VM process.
4. Record reason + timestamp + operator/event source.
5. Trigger secret/session revocation hooks in API/policy integration layer.

## Phased Delivery Plan

## Phase A: Refactor for backend pluggability (no behavior change)

Files:

- `src-go/internal/vm/supervisor.go`
- `src-go/cmd/nanoclawd/main.go`
- `src-go/cmd/vm-supervisor/main.go`
- `src-go/internal/reconciler/reconciler.go`

Deliverables:

- Introduce backend interface.
- Preserve all existing tests and simulated behavior.
- Add tests ensuring simulated backend parity.

## Phase B: Firecracker cold-boot MVP

Files (new + changed):

- `src-go/internal/vm/firecracker/*` (new)
- `src-go/internal/config/config.go`
- `src-go/internal/contracts/types.go`
- `src-go/internal/vm/supervisor_test.go` (expanded)

Deliverables:

- Create/start/stop/destroy with real Firecracker process and API socket.
- Backend metadata visible in `/healthz` summary and sandbox status.
- `NANOCLAW_GO_VM_NET_MODE=none` first (fail-closed network posture).

## Phase C: Snapshot + restore plumbing

Files:

- `src-go/internal/vm/firecracker/snapshot.go` (new)
- `src-go/internal/api/server.go`
- `src-go/internal/store/store.go`

Deliverables:

- Real snapshot file creation.
- Snapshot reference persisted in status.
- API returns snapshot metadata.

## Phase D: Kill-switch + policy coupling

Files:

- `src-go/internal/vm/firecracker/*`
- `src-go/internal/policy/engine.go`
- `src-go/internal/api/server.go`

Deliverables:

- Multi-stage kill-switch execution.
- Enforce strict deny-on-policy-failure before VM start.
- Emit structured incident events.

## Phase E: Network enforcement and host hardening

Files:

- `src-go/internal/vm/firecracker/network_tap.go` (new)
- `src-go/internal/policy/*`
- `src-go/internal/api/*`

Deliverables:

- Explicit egress policy-to-runtime mapping.
- Observability for dropped/denied egress attempts (where feasible).
- Documented operational baseline for single-host deployment.

## Test Strategy

## Unit tests

- Backend selection and config validation.
- Transition legality and idempotency.
- Firecracker API request construction and error handling.
- Kill-switch state transitions and audit payloads.

## Integration tests

- Keep current `src-go/scripts/e2e.sh` for simulated mode.
- Add Firecracker-gated integration suite:
  - only runs when `NANOCLAW_GO_VM_BACKEND=firecracker` and binary exists.
  - validates create/start/stop/snapshot/destroy/kill-switch with real artifacts.

## Conformance checks

- Verify policy signatures still validate after schema expansion.
- Verify all lifecycle events include correlation identifiers and backend type.

## Risks and Mitigations

1. Host networking complexity for deny-by-default egress.
   - Mitigation: ship MVP with `net_mode=none`, then add controlled tap mode.
2. Snapshot portability assumptions.
   - Mitigation: treat snapshots as host-local in V1 and document constraints.
3. API compatibility break risk.
   - Mitigation: additive contract changes only, no removals in initial rollout.
4. Operational drift between `nanoclawd` and `vm-supervisor`.
   - Mitigation: share the same backend package and transition logic.

## First PR Slice Recommendation

Ship Phase A only:

1. Introduce VM backend interface.
2. Move current simulated behavior into `SimulatedBackend`.
3. Keep API outputs stable.
4. Add backend-selection wiring in config/main.

This de-risks the refactor and creates a clean seam for Firecracker code without mixing runtime and API changes in one PR.
