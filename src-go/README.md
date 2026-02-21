# src-go

Go sandbox-core runtime scaffold for NanoClaw.

Detailed architecture and flow documentation lives in `SYSTEM.md`.

## Binaries
- `cmd/nanoclawd`: control plane API.
- `cmd/vm-supervisor`: sandbox supervisor process (kill-switch endpoint included).
- `cmd/sessiond`: PTY/session bridge service.
- `cmd/telegram-agent`: Telegram agent runtime entrypoint (intended for microVM sandbox execution).

## Run

```bash
cd src-go
go run ./cmd/nanoclawd
```

### Telegram Agent Runtime Entrypoint (Go)

This service is the Go Telegram runtime loop that the control plane can launch inside a sandbox microVM.

Required env vars:
- `TELEGRAM_BOT_TOKEN`
- `OPENAI_API_KEY`

Optional:
- `OPENAI_BASE_URL`
- `NANOCLAW_GO_AGENT_MODEL` (falls back to `DEFAULT_MODEL`, then `gpt-4o-mini`)
- `NANOCLAW_GO_AGENT_SYSTEM_PROMPT`
- `NANOCLAW_GO_TELEGRAM_ALLOWED_CHAT_IDS` (comma-separated numeric chat IDs)
- `NANOCLAW_GO_TELEGRAM_POLL_SECONDS` (default `30`)
- `NANOCLAW_GO_AGENT_TIMEOUT_SECONDS` (default `60`)
- `NANOCLAW_GO_TELEGRAM_DEBUG` (`true`/`false`)

Run:

```bash
cd src-go
go run ./cmd/telegram-agent
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

The dashboard is remote-only and executes `scripts/remote-firecracker.sh` commands for the Telegram runtime microVM flow.
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
./scripts/cli-smoke.sh up
./scripts/cli-smoke.sh status
./scripts/cli-smoke.sh task "telegram-agent --runtime microvm --source cli-smoke"
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
- remote runtime backend: `NANOCLAW_GO_VM_BACKEND=firecracker`
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
- `NANOCLAW_GO_VM_BACKEND` (`firecracker`; default `firecracker`)
- `NANOCLAW_GO_FIRECRACKER_BIN` (required when backend is `firecracker`)
- `NANOCLAW_GO_VM_STATE_DIR` (runtime state/socket/snapshot directory)
- `NANOCLAW_GO_VM_KERNEL_IMAGE` (default kernel image path fallback)
- `NANOCLAW_GO_VM_NET_MODE` (`none` or `tap`, with `none` as current safe default)
- `NANOCLAW_GO_VM_STOP_TIMEOUT_MS` (stop timeout in milliseconds)

## API
- `POST /v1/tasks/runs`
- `GET /v1/tasks/{id}`
- `POST /v1/sandboxes`
- `POST /v1/sandboxes/{id}:start|stop|destroy|snapshot`
- `POST /v1/sessions`
- `GET /v1/events/stream`

Credential isolation requirement:
- Every sandbox/task request must include `credential_refs.telegram_bot_token_ref` and `credential_refs.openai_api_key_ref`.
- These refs must be unique per sandbox (cannot be reused by another non-destroyed sandbox).

## Notes
This implementation is microVM-control-plane oriented and defaults to Firecracker-backed runtime for create/start/stop/destroy/snapshot/kill-switch flows.
