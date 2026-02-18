# Migration Notes (Sandbox Core First)

This implementation introduces Go services without forcing immediate TS runtime removal.

## First replacement targets
- `src/container-runner.ts` -> `src-go/cmd/nanoclawd` task + sandbox APIs
- `src/sandbox-manager.ts` -> `src-go/cmd/vm-supervisor` lifecycle + kill-switch APIs
- `src/mount-security.ts` -> `src-go/internal/policy` capability and egress enforcement
- `src/host-rpc-router.ts` -> versioned Go API contracts in `src-go/internal/contracts`

## Temporary retain set
- `src/telegram.ts`
- `src/task-scheduler.ts`
- `src/skills.ts`
- `src/log-sync.ts`

## Suggested cutover sequence
1. Switch scheduler/task execution path to `POST /v1/tasks/runs`.
2. Switch sandbox lifecycle actions to `POST /v1/sandboxes/{id}:...`.
3. Migrate host RPC callers to Go contracts.
4. Remove container-runner/sandbox-manager code paths after parity tests pass.
