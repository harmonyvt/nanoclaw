# src-go

Go sandbox-core runtime scaffold for NanoClaw.

## Binaries
- `cmd/nanoclawd`: control plane API.
- `cmd/vm-supervisor`: sandbox supervisor process (kill-switch endpoint included).
- `cmd/sessiond`: PTY/session bridge service.

## Run

```bash
cd src-go
go run ./cmd/nanoclawd
```

## End-to-end test

```bash
cd /Users/harmony/nanoclaw
bun run go:test:e2e
```

Environment variables:
- `NANOCLAW_GO_API_ADDR` (default `:8088`)
- `NANOCLAW_GO_SESSION_ADDR` (default `:8089`)
- `NANOCLAW_GO_SUPERVISOR_ADDR` (default `:8090`)
- `NANOCLAW_GO_STATE_FILE` (optional persisted state path)
- `NANOCLAW_GO_POLICY_KEY` (HMAC policy signing key)
- `NANOCLAW_GO_FIRECRACKER_BIN` (optional path; if unset, simulated VM mode)
- `NANOCLAW_GO_SIMULATED_VM` (default `true` unless firecracker binary configured)

## API
- `POST /v1/tasks/runs`
- `GET /v1/tasks/{id}`
- `POST /v1/sandboxes`
- `POST /v1/sandboxes/{id}:start|stop|destroy|snapshot`
- `POST /v1/sessions`
- `GET /v1/events/stream`

## Notes
This implementation is microVM-control-plane oriented with a simulated VM backend by default. Firecracker process-level execution hooks are intentionally left for host-specific integration.
