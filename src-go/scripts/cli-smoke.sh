#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${NANOCLAW_GO_ENV_FILE:-$ROOT_DIR/.env}"
SCRIPT_NAME="cli-smoke"

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
TASK_RUNTIME="${NANOCLAW_GO_TASK_RUNTIME:-bun}"
ADMIN_TOKEN="$(printf '%s' "${NANOCLAW_GO_ADMIN_TOKEN:-}" | tr -d '\r\n')"
API_AUTH_ARGS=()
if [[ -n "$ADMIN_TOKEN" ]]; then
  API_AUTH_ARGS=(-H "Authorization: Bearer $ADMIN_TOKEN")
fi

timestamp_utc() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

log_info() {
  printf '[%s][%s][INFO] %s\n' "$SCRIPT_NAME" "$(timestamp_utc)" "$*" >&2
}

log_warn() {
  printf '[%s][%s][WARN] %s\n' "$SCRIPT_NAME" "$(timestamp_utc)" "$*" >&2
}

log_error() {
  printf '[%s][%s][ERROR] %s\n' "$SCRIPT_NAME" "$(timestamp_utc)" "$*" >&2
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    log_error "missing required command: $1"
    exit 1
  fi
}

usage() {
  cat <<EOF
Usage: scripts/cli-smoke.sh <command>

Commands:
  info          Print resolved runtime configuration
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
  scripts/cli-smoke.sh task "telegram-agent --runtime bun --source cli-smoke"
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
      log_error "firecracker backend on macOS requires a Linux VM/host with KVM"
      log_error "use remote workflow: ./scripts/remote-firecracker.sh up"
      exit 1
    fi
    if [[ -z "$FIRECRACKER_BIN" ]]; then
      log_error "firecracker backend selected but NANOCLAW_GO_FIRECRACKER_BIN is unset"
      exit 1
    fi
    if [[ ! -x "$FIRECRACKER_BIN" ]]; then
      log_error "firecracker binary is not executable: $FIRECRACKER_BIN"
      exit 1
    fi
    if [[ -z "$VM_KERNEL_IMAGE" ]]; then
      log_warn "NANOCLAW_GO_VM_KERNEL_IMAGE is unset (sandbox starts may fail without per-request kernel image)"
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
    log_info "$name already running pid=$(cat "$pid_file")"
    return 0
  fi

  log_info "starting $name pkg=$pkg log=$log_file"
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

  log_info "started $name pid=$(cat "$pid_file")"
}

stop_service() {
  local name="$1"
  local pid_file
  pid_file="$(pid_file_for "$name")"

  if [[ ! -f "$pid_file" ]]; then
    log_info "$name already stopped (no pid file)"
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
  log_info "stopped $name"
}

wait_for_health() {
  if [[ "$#" -ne 2 ]]; then
    log_error "wait_for_health requires: <name> <url>"
    return 1
  fi
  local name="$1"
  local url="$2"
  log_info "waiting for health name=$name url=$url"
  for _ in $(seq 1 80); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      log_info "health ok name=$name url=$url"
      return 0
    fi
    sleep 0.25
  done
  log_error "health check failed name=$name url=$url"
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

service_addr_for() {
  local name="$1"
  case "$name" in
    nanoclawd) echo "$API_ADDR" ;;
    sessiond) echo "$SESSION_ADDR" ;;
    vm-supervisor) echo "$SUPERVISOR_ADDR" ;;
    *) echo "" ;;
  esac
}

service_port_for() {
  local addr
  addr="$(service_addr_for "$1")"
  if [[ -z "$addr" ]]; then
    echo ""
    return 0
  fi
  echo "${addr##*:}"
}

pids_listening_on_port() {
  local port="$1"
  if [[ -z "$port" ]]; then
    return 0
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | sort -u || true
    return 0
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>/dev/null | grep -E ":${port}[[:space:]]" | sed -nE 's/.*pid=([0-9]+).*/\1/p' | sort -u || true
    return 0
  fi
}

service_command_matches() {
  local name="$1"
  local pid="$2"
  local args
  args="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  if [[ -z "$args" ]]; then
    return 1
  fi
  case "$name" in
    nanoclawd) [[ "$args" == *"nanoclawd"* ]] ;;
    sessiond) [[ "$args" == *"sessiond"* ]] ;;
    vm-supervisor) [[ "$args" == *"vm-supervisor"* ]] ;;
    *) return 1 ;;
  esac
}

candidate_pids_for_service() {
  local name="$1"
  local port
  port="$(service_port_for "$name")"
  {
    pgrep -x "$name" 2>/dev/null || true
    case "$name" in
      nanoclawd)
        pgrep -f 'cmd/nanoclawd' 2>/dev/null || true
        pgrep -f 'exe/nanoclawd' 2>/dev/null || true
        ;;
      sessiond)
        pgrep -f 'cmd/sessiond' 2>/dev/null || true
        pgrep -f 'exe/sessiond' 2>/dev/null || true
        ;;
      vm-supervisor)
        pgrep -f 'cmd/vm-supervisor' 2>/dev/null || true
        pgrep -f 'exe/vm-supervisor' 2>/dev/null || true
        ;;
    esac
    pids_listening_on_port "$port"
  } | grep -E '^[0-9]+$' | sort -u || true
}

kill_pid_with_timeout() {
  local pid="$1"
  local label="$2"
  if ! kill -0 "$pid" >/dev/null 2>&1; then
    return 0
  fi
  log_warn "sending TERM to $label pid=$pid"
  kill "$pid" >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  if kill -0 "$pid" >/dev/null 2>&1; then
    log_warn "sending KILL to $label pid=$pid"
    kill -9 "$pid" >/dev/null 2>&1 || true
  fi
}

force_cleanup_service_orphans() {
  local name="$1"
  local cleaned=0
  local candidates
  candidates="$(candidate_pids_for_service "$name" | paste -sd, -)"
  if [[ -z "$candidates" ]]; then
    log_info "$name orphan-cleanup: none found"
    return 0
  fi
  log_warn "$name orphan-cleanup: candidate_pids=$candidates"
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      continue
    fi
    if ! service_command_matches "$name" "$pid"; then
      log_warn "skipping pid=$pid for $name (command mismatch)"
      continue
    fi
    kill_pid_with_timeout "$pid" "$name/orphan"
    cleaned=1
  done < <(candidate_pids_for_service "$name")
  if [[ "$cleaned" -eq 1 ]]; then
    log_info "$name orphan-cleanup: complete"
  fi
}

service_process_status_line() {
  local name="$1"
  local tracked_pid=""
  local all_pids=""
  if is_running "$name"; then
    tracked_pid="$(cat "$(pid_file_for "$name")")"
  fi
  all_pids="$(candidate_pids_for_service "$name" | paste -sd, -)"
  if [[ -n "$tracked_pid" ]]; then
    local child_pids=""
    child_pids="$(pgrep -P "$tracked_pid" 2>/dev/null | paste -sd, - || true)"
    local expected_pids="$tracked_pid"
    if [[ -n "$child_pids" ]]; then
      expected_pids="$expected_pids,$child_pids"
    fi
    local unexpected_pids=""
    unexpected_pids="$(printf '%s\n' "$all_pids" | tr ',' '\n' | awk -v expected="$expected_pids" '
      BEGIN {
        split(expected, arr, ",")
        for (i in arr) {
          if (arr[i] != "") allow[arr[i]] = 1
        }
      }
      $0 != "" && !($0 in allow) { print $0 }
    ' | paste -sd, -)"
    if [[ -n "$unexpected_pids" ]]; then
      echo "$name process=running pid=$tracked_pid child_pids=${child_pids:-none} unexpected_pids=$unexpected_pids"
    elif [[ -n "$child_pids" ]]; then
      echo "$name process=running pid=$tracked_pid child_pids=$child_pids"
    else
      echo "$name process=running pid=$tracked_pid"
    fi
    return 0
  fi
  if [[ -n "$all_pids" ]]; then
    echo "$name process=running-untracked pids=$all_pids"
  else
    echo "$name process=stopped"
  fi
}

cmd_info() {
  cat <<EOF
Resolved configuration:
  ENV_FILE=$ENV_FILE
  RUNTIME_DIR=$RUNTIME_DIR
  PID_DIR=$PID_DIR
  LOG_DIR=$LOG_DIR
  STATE_FILE=$STATE_FILE
  VM_STATE_DIR=$VM_STATE_DIR
  NANOCLAW_GO_API_ADDR=$API_ADDR
  NANOCLAW_GO_SESSION_ADDR=$SESSION_ADDR
  NANOCLAW_GO_SUPERVISOR_ADDR=$SUPERVISOR_ADDR
  NANOCLAW_GO_VM_BACKEND=$VM_BACKEND
  NANOCLAW_GO_VM_NET_MODE=$VM_NET_MODE
  NANOCLAW_GO_FIRECRACKER_BIN=${FIRECRACKER_BIN:-<unset>}
  NANOCLAW_GO_VM_KERNEL_IMAGE=${VM_KERNEL_IMAGE:-<unset>}
  NANOCLAW_GO_CLI_KERNEL_IMAGE=$CLI_KERNEL_IMAGE
  NANOCLAW_GO_CLI_ROOTFS_IMAGE=$CLI_ROOTFS_IMAGE
  NANOCLAW_GO_TASK_RUNTIME=$TASK_RUNTIME
EOF
}

cmd_up() {
  require_cmd go
  require_cmd curl
  log_info "starting local services"
  ensure_runtime_dirs
  check_backend_requirements

  start_service "nanoclawd" "./cmd/nanoclawd"
  start_service "sessiond" "./cmd/sessiond"
  start_service "vm-supervisor" "./cmd/vm-supervisor"

  wait_for_health "nanoclawd" "http://$API_ADDR/healthz"
  wait_for_health "sessiond" "http://$SESSION_ADDR/healthz"
  wait_for_health "vm-supervisor" "http://$SUPERVISOR_ADDR/healthz"
  log_info "all services healthy"
}

cmd_down() {
  log_info "stopping local services"
  stop_service "nanoclawd"
  stop_service "sessiond"
  stop_service "vm-supervisor"
  log_info "running orphan cleanup to ensure full shutdown"
  force_cleanup_service_orphans "nanoclawd"
  force_cleanup_service_orphans "sessiond"
  force_cleanup_service_orphans "vm-supervisor"
  log_info "local services stopped"
}

cmd_status() {
  log_info "collecting process and health status"
  for name in nanoclawd sessiond vm-supervisor; do
    service_process_status_line "$name"
  done
  health_status "nanoclawd" "http://$API_ADDR/healthz"
  health_status "sessiond" "http://$SESSION_ADDR/healthz"
  health_status "vm-supervisor" "http://$SUPERVISOR_ADDR/healthz"
}

cmd_task() {
  require_cmd curl
  require_cmd jq
  local task_cmd="${1:-telegram-agent --runtime $TASK_RUNTIME --source cli-smoke}"
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
  log_info "creating task command=$task_cmd image_ref=$CLI_ROOTFS_IMAGE"
  log_info "credential_refs telegram=$tg_ref openai=$oa_ref"
  curl -fsS -X POST "http://$API_ADDR/v1/tasks/runs" \
    "${API_AUTH_ARGS[@]}" \
    -H 'content-type: application/json' \
    -d "$payload"
  echo
}

cmd_smoke() {
  require_cmd curl
  require_cmd jq

  local task_resp task_id sbx_id status
  task_resp="$(cmd_task "telegram-agent --runtime $TASK_RUNTIME --source cli-smoke-smoke")"
  task_id="$(echo "$task_resp" | jq -r '.task_id')"
  sbx_id="$(echo "$task_resp" | jq -r '.sandbox_id')"
  status="$(echo "$task_resp" | jq -r '.status')"

  [[ -n "$task_id" && "$task_id" != "null" ]] || { log_error "missing task_id"; exit 1; }
  [[ -n "$sbx_id" && "$sbx_id" != "null" ]] || { log_error "missing sandbox_id"; exit 1; }
  [[ "$status" == "accepted" ]] || { log_error "expected status=accepted got=$status"; exit 1; }

  log_info "smoke task accepted task_id=$task_id sandbox_id=$sbx_id"
  curl -fsS "${API_AUTH_ARGS[@]}" "http://$API_ADDR/v1/tasks/$task_id" | jq '{task_id, sandbox_id, status}'

  for action in stop start snapshot destroy; do
    log_info "smoke sandbox action=$action sandbox_id=$sbx_id"
    curl -fsS -X POST "${API_AUTH_ARGS[@]}" "http://$API_ADDR/v1/sandboxes/$sbx_id:$action" | jq '{sandbox_id, observed_state, health, backend, snapshot_count, snapshot_ref}'
  done

  log_info "smoke supervisor lifecycle sandbox_id=sbx-cli-smoke"
  curl -fsS -X POST "http://$SUPERVISOR_ADDR/v1/supervisor/sandboxes" \
    -H 'content-type: application/json' \
    -d "{\"sandbox_id\":\"sbx-cli-smoke\",\"desired_state\":\"stopped\",\"vm_profile\":{\"kernel_image\":\"$CLI_KERNEL_IMAGE\",\"rootfs_image\":\"$CLI_ROOTFS_IMAGE\",\"vcpu\":1,\"memory_mib\":256},\"network_policy\":{\"default_deny\":true,\"allow\":[]},\"credential_refs\":{\"telegram_bot_token_ref\":\"secret/vm/telegram-runtime-cli-supervisor/telegram\",\"openai_api_key_ref\":\"secret/vm/telegram-runtime-cli-supervisor/openai\"},\"ttl_seconds\":3600}" \
    >/dev/null
  for action in start stop snapshot killswitch; do
    log_info "smoke supervisor action=$action sandbox_id=sbx-cli-smoke"
    curl -fsS -X POST "http://$SUPERVISOR_ADDR/v1/supervisor/sandboxes/sbx-cli-smoke:$action" | jq '{sandbox_id, observed_state, health, backend, snapshot_count, snapshot_ref, kill_switch_note}'
  done

  log_info "smoke PASS"
}

cmd_logs() {
  local target="${1:-all}"
  case "$target" in
    all)
      for file in "$LOG_DIR/nanoclawd.log" "$LOG_DIR/sessiond.log" "$LOG_DIR/vm-supervisor.log"; do
        if [[ -f "$file" ]]; then
          log_info "tailing $file"
          tail -n 80 "$file"
        else
          log_warn "log file missing: $file"
        fi
      done
      ;;
    nanoclawd|sessiond|vm-supervisor)
      local file="$LOG_DIR/$target.log"
      if [[ -f "$file" ]]; then
        log_info "tailing $file"
        tail -n 120 "$file"
      else
        log_warn "log file missing: $file"
      fi
      ;;
    *)
      log_error "unknown service: $target"
      exit 1
      ;;
  esac
}

main() {
  local cmd="${1:-help}"
  shift || true

  case "$cmd" in
    info) cmd_info ;;
    up) cmd_up "$@" ;;
    down) cmd_down "$@" ;;
    restart) log_info "restart requested"; cmd_down; cmd_up ;;
    status) cmd_status ;;
    task) cmd_task "$@" ;;
    smoke) cmd_smoke ;;
    logs) cmd_logs "$@" ;;
    help|-h|--help) usage ;;
    *)
      log_error "unknown command: $cmd"
      usage
      exit 1
      ;;
  esac
}

main "$@"
