# src-go

Go sandbox-core runtime scaffold for NanoClaw.

Detailed architecture and flow documentation lives in `SYSTEM.md`.

## Binaries
- `cmd/nanoclawd`: control plane API.
- `cmd/vm-supervisor`: sandbox supervisor process (kill-switch endpoint included).
- `cmd/sessiond`: PTY/session bridge service.

## Run

```bash
cd src-go
go run ./cmd/nanoclawd
```

### Dev CLI (Bubble Tea, Remote Dashboard)

Run the interactive remote dashboard:

```bash
cd src-go
go run ./cmd/devctl
```

Controls:
- `up/down` or `j/k`: select remote action
- `enter`: run selected action
- quick actions: `g` doctor, `s` sync, `u` up, `h` status, `m` smoke, `l` logs, `t` test, `d` down, `r` restart
- `e`: reload remote config from `src-go/.env` (or `NANOCLAW_GO_ENV_FILE`)
- `c`: clear output panel
- `q`: quit

The dashboard is remote-only and executes `scripts/remote-firecracker.sh` commands.
It surfaces remote host config, action history, command output, and parsed service health.

## End-to-end test

```bash
cd src-go && ./scripts/e2e.sh
# or from repository root:
bun run go:test:e2e
```

## CLI smoke test commands

```bash
cd src-go
NANOCLAW_GO_VM_BACKEND=simulated ./scripts/cli-smoke.sh up
./scripts/cli-smoke.sh status
./scripts/cli-smoke.sh task "echo hello from cli"
./scripts/cli-smoke.sh smoke
./scripts/cli-smoke.sh logs nanoclawd
./scripts/cli-smoke.sh down
```

## Remote Firecracker helper workflow

Both `scripts/remote-firecracker.sh` and `scripts/cli-smoke.sh` auto-load `src-go/.env` by default.
To use a different env file, set `NANOCLAW_GO_ENV_FILE=/path/to/custom.env`.
Start from the template:

```bash
cd src-go
cp .env.example .env
```

Default `.env` in this repo includes:
- local default backend: `NANOCLAW_GO_VM_BACKEND=simulated`
- remote target variables (`NANOCLAW_REMOTE_HOST`, `NANOCLAW_REMOTE_WORKDIR`, etc.)
- remote Firecracker image paths under `/opt/firecracker/images`
- remote VM net mode: `none`

Typical remote flow:

```bash
cd src-go
./scripts/remote-firecracker.sh doctor
./scripts/remote-firecracker.sh sync
./scripts/remote-firecracker.sh up
./scripts/remote-firecracker.sh smoke
./scripts/remote-firecracker.sh down
```

Full step-by-step documentation:

- `REMOTE_FIRECRACKER.md`

Quick setup helper:

```bash
cd src-go
./scripts/remote-firecracker-quickstart.sh
```

Environment variables:
- `NANOCLAW_GO_API_ADDR` (default `:8088`)
- `NANOCLAW_GO_SESSION_ADDR` (default `:8089`)
- `NANOCLAW_GO_SUPERVISOR_ADDR` (default `:8071`)
- `NANOCLAW_GO_STATE_FILE` (optional persisted state path)
- `NANOCLAW_GO_POLICY_KEY` (HMAC policy signing key)
- `NANOCLAW_GO_VM_BACKEND` (`simulated` or `firecracker`; default `simulated`)
- `NANOCLAW_GO_FIRECRACKER_BIN` (required when backend is `firecracker`)
- `NANOCLAW_GO_VM_STATE_DIR` (runtime state/socket/snapshot directory)
- `NANOCLAW_GO_VM_KERNEL_IMAGE` (default kernel image path fallback)
- `NANOCLAW_GO_VM_NET_MODE` (`none` or `tap`, with `none` as current safe default)
- `NANOCLAW_GO_VM_STOP_TIMEOUT_MS` (stop timeout in milliseconds)
- `NANOCLAW_GO_SIMULATED_VM` (legacy compatibility flag; prefer `NANOCLAW_GO_VM_BACKEND`)

## API
- `POST /v1/tasks/runs`
- `GET /v1/tasks/{id}`
- `POST /v1/sandboxes`
- `POST /v1/sandboxes/{id}:start|stop|destroy|snapshot`
- `POST /v1/sessions`
- `GET /v1/events/stream`

## Notes
This implementation is microVM-control-plane oriented with a simulated backend by default, and now includes a Firecracker-backed runtime path for create/start/stop/destroy/snapshot/kill-switch flows.
