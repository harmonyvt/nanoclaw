#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${NANOCLAW_GO_ENV_FILE:-$ROOT_DIR/.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

RUNTIME_DIR="${NANOCLAW_GO_CLI_RUNTIME_DIR:-$ROOT_DIR/.tmp/cli-smoke}"
PID_DIR="$RUNTIME_DIR/pids"
LOG_DIR="$RUNTIME_DIR/logs"
STATE_FILE="$RUNTIME_DIR/state.json"

API_ADDR="${NANOCLAW_GO_API_ADDR:-127.0.0.1:18088}"
SESSION_ADDR="${NANOCLAW_GO_SESSION_ADDR:-127.0.0.1:18089}"
SUPERVISOR_ADDR="${NANOCLAW_GO_SUPERVISOR_ADDR:-127.0.0.1:18090}"

VM_BACKEND="${NANOCLAW_GO_VM_BACKEND:-firecracker}"
VM_NET_MODE="${NANOCLAW_GO_VM_NET_MODE:-none}"
FIRECRACKER_BIN="${NANOCLAW_GO_FIRECRACKER_BIN:-}"
VM_KERNEL_IMAGE="${NANOCLAW_GO_VM_KERNEL_IMAGE:-}"
VM_STOP_TIMEOUT_MS="${NANOCLAW_GO_VM_STOP_TIMEOUT_MS:-10000}"
VM_STATE_DIR="${NANOCLAW_GO_VM_STATE_DIR:-$RUNTIME_DIR/vm-state}"
CLI_KERNEL_IMAGE="${NANOCLAW_GO_CLI_KERNEL_IMAGE:-${VM_KERNEL_IMAGE:-$ROOT_DIR/vmlinux}}"
CLI_ROOTFS_IMAGE="${NANOCLAW_GO_CLI_ROOTFS_IMAGE:-$ROOT_DIR/rootfs.img}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

usage() {
  cat <<EOF
Usage: scripts/cli-smoke.sh <command>

Commands:
  up            Start nanoclawd, sessiond, vm-supervisor in background
  down          Stop all services started by this script
  restart       Restart all services
  status        Show service + health status
  task [cmd]    Create a Telegram agent runtime task and print response JSON
  smoke         Run Telegram runtime + sandbox + supervisor lifecycle checks
  logs [name]   Tail logs for all services or one service

Environment loading:
  Auto-loads $ROOT_DIR/.env by default
  Override with NANOCLAW_GO_ENV_FILE=/path/to/custom.env

Examples:
  scripts/cli-smoke.sh up
  scripts/cli-smoke.sh task "telegram-agent --runtime microvm --source cli-smoke"
  scripts/cli-smoke.sh smoke
  scripts/cli-smoke.sh down

  NANOCLAW_GO_VM_BACKEND=firecracker \\
  NANOCLAW_GO_FIRECRACKER_BIN=/usr/local/bin/firecracker \\
  NANOCLAW_GO_VM_KERNEL_IMAGE=/path/to/vmlinux \\
  scripts/cli-smoke.sh up
EOF
}

ensure_runtime_dirs() {
  mkdir -p "$PID_DIR" "$LOG_DIR" "$VM_STATE_DIR"
}

vm_env() {
  cat <<EOF
NANOCLAW_GO_VM_BACKEND=$VM_BACKEND
NANOCLAW_GO_VM_NET_MODE=$VM_NET_MODE
NANOCLAW_GO_VM_STOP_TIMEOUT_MS=$VM_STOP_TIMEOUT_MS
NANOCLAW_GO_VM_STATE_DIR=$VM_STATE_DIR
NANOCLAW_GO_STATE_FILE=$STATE_FILE
NANOCLAW_GO_API_ADDR=$API_ADDR
NANOCLAW_GO_SESSION_ADDR=$SESSION_ADDR
NANOCLAW_GO_SUPERVISOR_ADDR=$SUPERVISOR_ADDR
EOF
}

check_backend_requirements() {
  if [[ "$VM_BACKEND" == "firecracker" ]]; then
    if [[ "$(uname -s)" == "Darwin" ]]; then
      echo "firecracker backend on macOS requires a Linux VM/host with KVM." >&2
      echo "use remote workflow: ./scripts/remote-firecracker.sh up" >&2
      exit 1
    fi
    if [[ -z "$FIRECRACKER_BIN" ]]; then
      echo "firecracker backend selected but NANOCLAW_GO_FIRECRACKER_BIN is unset" >&2
      exit 1
    fi
    if [[ ! -x "$FIRECRACKER_BIN" ]]; then
      echo "firecracker binary is not executable: $FIRECRACKER_BIN" >&2
      exit 1
    fi
    if [[ -z "$VM_KERNEL_IMAGE" ]]; then
      echo "warning: NANOCLAW_GO_VM_KERNEL_IMAGE is unset (sandbox starts may fail without per-request kernel image)" >&2
    fi
  fi
}

pid_file_for() {
  local name="$1"
  echo "$PID_DIR/$name.pid"
}

is_running() {
  local name="$1"
  local pid_file
  pid_file="$(pid_file_for "$name")"
  if [[ ! -f "$pid_file" ]]; then
    return 1
  fi
  local pid
  pid="$(cat "$pid_file")"
  kill -0 "$pid" >/dev/null 2>&1
}

start_service() {
  local name="$1"
  local pkg="$2"
  local log_file="$LOG_DIR/$name.log"
  local pid_file
  pid_file="$(pid_file_for "$name")"

  if is_running "$name"; then
    echo "$name already running (pid $(cat "$pid_file"))"
    return 0
  fi

  (
    cd "$ROOT_DIR"
    while IFS='=' read -r k v; do
      export "$k=$v"
    done < <(vm_env)
    if [[ -n "$FIRECRACKER_BIN" ]]; then
      export NANOCLAW_GO_FIRECRACKER_BIN="$FIRECRACKER_BIN"
    fi
    if [[ -n "$VM_KERNEL_IMAGE" ]]; then
      export NANOCLAW_GO_VM_KERNEL_IMAGE="$VM_KERNEL_IMAGE"
    fi
    nohup go run "$pkg" >"$log_file" 2>&1 &
    echo $! >"$pid_file"
  )

  echo "started $name (pid $(cat "$pid_file"))"
}

stop_service() {
  local name="$1"
  local pid_file
  pid_file="$(pid_file_for "$name")"

  if [[ ! -f "$pid_file" ]]; then
    return 0
  fi
  local pid
  pid="$(cat "$pid_file")"
  if kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
    for _ in $(seq 1 30); do
      if ! kill -0 "$pid" >/dev/null 2>&1; then
        break
      fi
      sleep 0.1
    done
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill -9 "$pid" >/dev/null 2>&1 || true
    fi
  fi
  rm -f "$pid_file"
  echo "stopped $name"
}

wait_for_health() {
  local url="$1"
  for _ in $(seq 1 80); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  echo "health check failed: $url" >&2
  return 1
}

health_status() {
  local name="$1"
  local url="$2"
  if curl -fsS "$url" >/dev/null 2>&1; then
    echo "$name health=ok url=$url"
  else
    echo "$name health=down url=$url"
  fi
}

cmd_up() {
  require_cmd go
  require_cmd curl
  ensure_runtime_dirs
  check_backend_requirements

  start_service "nanoclawd" "./cmd/nanoclawd"
  start_service "sessiond" "./cmd/sessiond"
  start_service "vm-supervisor" "./cmd/vm-supervisor"

  wait_for_health "http://$API_ADDR/healthz"
  wait_for_health "http://$SESSION_ADDR/healthz"
  wait_for_health "http://$SUPERVISOR_ADDR/healthz"
  echo "all services healthy"
}

cmd_down() {
  stop_service "nanoclawd"
  stop_service "sessiond"
  stop_service "vm-supervisor"
}

cmd_status() {
  for name in nanoclawd sessiond vm-supervisor; do
    if is_running "$name"; then
      echo "$name process=running pid=$(cat "$(pid_file_for "$name")")"
    else
      echo "$name process=stopped"
    fi
  done
  health_status "nanoclawd" "http://$API_ADDR/healthz"
  health_status "sessiond" "http://$SESSION_ADDR/healthz"
  health_status "vm-supervisor" "http://$SUPERVISOR_ADDR/healthz"
}

cmd_task() {
  require_cmd curl
  require_cmd jq
  local task_cmd="${1:-telegram-agent --runtime microvm --source cli-smoke}"
  local cred_nonce
  cred_nonce="$(date +%s%N)"
  local tg_ref="secret/vm/telegram-runtime-cli-${cred_nonce}/telegram"
  local oa_ref="secret/vm/telegram-runtime-cli-${cred_nonce}/openai"
  local payload
  payload="$(jq -n \
    --arg image_ref "$CLI_ROOTFS_IMAGE" \
    --arg command "$task_cmd" \
    --arg telegram_ref "$tg_ref" \
    --arg openai_ref "$oa_ref" \
    '{
      risk_class: "high",
      image_ref: $image_ref,
      credential_refs: {
        telegram_bot_token_ref: $telegram_ref,
        openai_api_key_ref: $openai_ref
      },
      command: $command,
      resource_profile: {cpu: 1, memory: 256, pids: 64},
      capabilities: {
        fs_scopes: [{path: "/workspace", mode: "write"}],
        egress_rules: [{host: "api.example.com", port: 443}],
        tool_rules: [{name: "shell", allowed: true}],
        secret_rules: []
      }
    }')"
  curl -fsS -X POST "http://$API_ADDR/v1/tasks/runs" \
    -H 'content-type: application/json' \
    -d "$payload"
  echo
}

cmd_smoke() {
  require_cmd curl
  require_cmd jq

  local task_resp task_id sbx_id status
  task_resp="$(cmd_task "telegram-agent --runtime microvm --source cli-smoke-smoke")"
  task_id="$(echo "$task_resp" | jq -r '.task_id')"
  sbx_id="$(echo "$task_resp" | jq -r '.sandbox_id')"
  status="$(echo "$task_resp" | jq -r '.status')"

  [[ -n "$task_id" && "$task_id" != "null" ]] || { echo "missing task_id" >&2; exit 1; }
  [[ -n "$sbx_id" && "$sbx_id" != "null" ]] || { echo "missing sandbox_id" >&2; exit 1; }
  [[ "$status" == "accepted" ]] || { echo "expected status=accepted, got $status" >&2; exit 1; }

  echo "[smoke] telegram runtime task accepted task_id=$task_id sandbox_id=$sbx_id"
  curl -fsS "http://$API_ADDR/v1/tasks/$task_id" | jq '{task_id, sandbox_id, status}'

  for action in stop start snapshot destroy; do
    echo "[smoke] sandbox action=$action"
    curl -fsS -X POST "http://$API_ADDR/v1/sandboxes/$sbx_id:$action" | jq '{sandbox_id, observed_state, health, backend, snapshot_count, snapshot_ref}'
  done

  echo "[smoke] supervisor lifecycle"
  curl -fsS -X POST "http://$SUPERVISOR_ADDR/v1/supervisor/sandboxes" \
    -H 'content-type: application/json' \
    -d "{\"sandbox_id\":\"sbx-cli-smoke\",\"desired_state\":\"stopped\",\"vm_profile\":{\"kernel_image\":\"$CLI_KERNEL_IMAGE\",\"rootfs_image\":\"$CLI_ROOTFS_IMAGE\",\"vcpu\":1,\"memory_mib\":256},\"network_policy\":{\"default_deny\":true,\"allow\":[]},\"credential_refs\":{\"telegram_bot_token_ref\":\"secret/vm/telegram-runtime-cli-supervisor/telegram\",\"openai_api_key_ref\":\"secret/vm/telegram-runtime-cli-supervisor/openai\"},\"ttl_seconds\":3600}" \
    >/dev/null
  for action in start stop snapshot killswitch; do
    curl -fsS -X POST "http://$SUPERVISOR_ADDR/v1/supervisor/sandboxes/sbx-cli-smoke:$action" | jq '{sandbox_id, observed_state, health, backend, snapshot_count, snapshot_ref, kill_switch_note}'
  done

  echo "[smoke] PASS"
}

cmd_logs() {
  local target="${1:-all}"
  case "$target" in
    all)
      tail -n 80 "$LOG_DIR/nanoclawd.log" "$LOG_DIR/sessiond.log" "$LOG_DIR/vm-supervisor.log"
      ;;
    nanoclawd|sessiond|vm-supervisor)
      tail -n 120 "$LOG_DIR/$target.log"
      ;;
    *)
      echo "unknown service: $target" >&2
      exit 1
      ;;
  esac
}

main() {
  local cmd="${1:-help}"
  shift || true

  case "$cmd" in
    up) cmd_up "$@" ;;
    down) cmd_down "$@" ;;
    restart) cmd_down; cmd_up ;;
    status) cmd_status ;;
    task) cmd_task "$@" ;;
    smoke) cmd_smoke ;;
    logs) cmd_logs "$@" ;;
    help|-h|--help) usage ;;
    *)
      echo "unknown command: $cmd" >&2
      usage
      exit 1
      ;;
  esac
}

main "$@"
