#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="e2e"

timestamp_utc() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

log_info() {
  printf '[%s][%s][INFO] %s\n' "$SCRIPT_NAME" "$(timestamp_utc)" "$*" >&2
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

require_cmd go
require_cmd curl
require_cmd jq

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
LOG_DIR="$TMP_DIR/logs"
NANOCLAWD_ADDR="127.0.0.1:18088"
SESSIOND_ADDR="127.0.0.1:18089"
SUP_ADDR="127.0.0.1:18090"
STATE_FILE="$TMP_DIR/state.json"
FIRECRACKER_BIN="${NANOCLAW_GO_FIRECRACKER_BIN:-/opt/firecracker/bin/firecracker}"
NANOCLAWD_LOG="$LOG_DIR/nanoclawd.log"
SESSIOND_LOG="$LOG_DIR/sessiond.log"
SUP_LOG="$LOG_DIR/vm-supervisor.log"

mkdir -p "$LOG_DIR"

if [[ ! -x "$FIRECRACKER_BIN" ]]; then
  log_error "missing firecracker binary: $FIRECRACKER_BIN"
  exit 1
fi

NANOCLAWD_PID=""
SESSIOND_PID=""
SUP_PID=""

cleanup() {
  set +e
  log_info "cleanup start"
  if [[ -n "$NANOCLAWD_PID" ]]; then
    log_info "stopping nanoclawd pid=$NANOCLAWD_PID"
    kill "$NANOCLAWD_PID" >/dev/null 2>&1
    wait "$NANOCLAWD_PID" >/dev/null 2>&1
  fi
  if [[ -n "$SESSIOND_PID" ]]; then
    log_info "stopping sessiond pid=$SESSIOND_PID"
    kill "$SESSIOND_PID" >/dev/null 2>&1
    wait "$SESSIOND_PID" >/dev/null 2>&1
  fi
  if [[ -n "$SUP_PID" ]]; then
    log_info "stopping vm-supervisor pid=$SUP_PID"
    kill "$SUP_PID" >/dev/null 2>&1
    wait "$SUP_PID" >/dev/null 2>&1
  fi
  log_info "removing temp directory $TMP_DIR"
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

wait_for_health() {
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

assert_non_empty() {
  local label="$1"
  local value="$2"
  [[ -n "$value" && "$value" != "null" ]] || {
    log_error "expected non-empty value for $label"
    exit 1
  }
}

log_info "starting nanoclawd log=$NANOCLAWD_LOG"
(
  cd "$ROOT_DIR"
  NANOCLAW_GO_API_ADDR="$NANOCLAWD_ADDR" \
  NANOCLAW_GO_SESSION_ADDR="$SESSIOND_ADDR" \
  NANOCLAW_GO_SUPERVISOR_ADDR="$SUP_ADDR" \
  NANOCLAW_GO_STATE_FILE="$STATE_FILE" \
  NANOCLAW_GO_VM_BACKEND=firecracker \
  NANOCLAW_GO_FIRECRACKER_BIN="$FIRECRACKER_BIN" \
  go run ./cmd/nanoclawd >"$NANOCLAWD_LOG" 2>&1
) &
NANOCLAWD_PID=$!
wait_for_health "nanoclawd" "http://$NANOCLAWD_ADDR/healthz"

log_info "testing nanoclawd task/sandbox/session flow"
TASK_RESP="$(curl -fsS -X POST "http://$NANOCLAWD_ADDR/v1/tasks/runs" \
  -H 'content-type: application/json' \
  -d '{
    "risk_class":"high",
    "image_ref":"rootfs.img",
    "credential_refs":{
      "telegram_bot_token_ref":"secret/vm/e2e-sbx/telegram",
      "openai_api_key_ref":"secret/vm/e2e-sbx/openai"
    },
    "command":"echo test",
    "resource_profile":{"cpu":1,"memory":256,"pids":64},
    "capabilities":{
      "fs_scopes":[{"path":"/workspace","mode":"write"}],
      "egress_rules":[{"host":"api.example.com","port":443}],
      "tool_rules":[{"name":"shell","allowed":true}],
      "secret_rules":[]
    }
  }')"
TASK_ID="$(echo "$TASK_RESP" | jq -r '.task_id')"
SBX_ID="$(echo "$TASK_RESP" | jq -r '.sandbox_id')"
STATUS="$(echo "$TASK_RESP" | jq -r '.status')"
assert_non_empty "task_id" "$TASK_ID"
assert_non_empty "sandbox_id" "$SBX_ID"
[[ "$STATUS" == "accepted" ]] || { log_error "expected task status=accepted got=$STATUS"; exit 1; }
log_info "task accepted task_id=$TASK_ID sandbox_id=$SBX_ID"

GET_TASK="$(curl -fsS "http://$NANOCLAWD_ADDR/v1/tasks/$TASK_ID")"
[[ "$(echo "$GET_TASK" | jq -r '.task_id')" == "$TASK_ID" ]] || { log_error "task lookup mismatch task_id=$TASK_ID"; exit 1; }
log_info "task lookup verified task_id=$TASK_ID"

for action in stop start snapshot destroy; do
  log_info "sandbox action=$action sandbox_id=$SBX_ID"
  RESP="$(curl -fsS -X POST "http://$NANOCLAWD_ADDR/v1/sandboxes/$SBX_ID:$action")"
  assert_non_empty "sandbox action response ($action)" "$RESP"
done

SESS_RESP="$(curl -fsS -X POST "http://$NANOCLAWD_ADDR/v1/sessions" \
  -H 'content-type: application/json' \
  -d "{\"sandbox_id\":\"$SBX_ID\",\"command\":\"sh\"}")"
SESS_ID="$(echo "$SESS_RESP" | jq -r '.session_id')"
assert_non_empty "nanoclawd session_id" "$SESS_ID"
log_info "nanoclawd session created session_id=$SESS_ID"

log_info "starting sessiond log=$SESSIOND_LOG"
(
  cd "$ROOT_DIR"
  NANOCLAW_GO_SESSION_ADDR="$SESSIOND_ADDR" \
  go run ./cmd/sessiond >"$SESSIOND_LOG" 2>&1
) &
SESSIOND_PID=$!
wait_for_health "sessiond" "http://$SESSIOND_ADDR/healthz"

SESSIOND_CREATE="$(curl -fsS -X POST "http://$SESSIOND_ADDR/v1/sessions" \
  -H 'content-type: application/json' \
  -d '{"sandbox_id":"sbx-sess","command":"sh"}')"
SESSIOND_ID="$(echo "$SESSIOND_CREATE" | jq -r '.session_id')"
assert_non_empty "sessiond session_id" "$SESSIOND_ID"
log_info "sessiond session created session_id=$SESSIOND_ID"

curl -fsS -X POST "http://$SESSIOND_ADDR/v1/sessions/$SESSIOND_ID:input" \
  -H 'content-type: application/json' -d '{"input":"echo hi"}' >/dev/null
curl -fsS -X POST "http://$SESSIOND_ADDR/v1/sessions/$SESSIOND_ID:resize" \
  -H 'content-type: application/json' -d '{"rows":40,"cols":120}' >/dev/null
curl -fsS -X POST "http://$SESSIOND_ADDR/v1/sessions/$SESSIOND_ID:terminate" >/dev/null

log_info "sessiond interaction flow verified session_id=$SESSIOND_ID"

log_info "starting vm-supervisor log=$SUP_LOG"
(
  cd "$ROOT_DIR"
  NANOCLAW_GO_SUPERVISOR_ADDR="$SUP_ADDR" \
  NANOCLAW_GO_VM_BACKEND=firecracker \
  NANOCLAW_GO_FIRECRACKER_BIN="$FIRECRACKER_BIN" \
  go run ./cmd/vm-supervisor >"$SUP_LOG" 2>&1
) &
SUP_PID=$!
wait_for_health "vm-supervisor" "http://$SUP_ADDR/healthz"

log_info "creating supervisor sandbox sandbox_id=sbx-sup"
curl -fsS -X POST "http://$SUP_ADDR/v1/supervisor/sandboxes" \
  -H 'content-type: application/json' \
  -d '{"sandbox_id":"sbx-sup","desired_state":"stopped","vm_profile":{"kernel_image":"vmlinux","rootfs_image":"rootfs.img","vcpu":1,"memory_mib":256},"network_policy":{"default_deny":true,"allow":[]},"credential_refs":{"telegram_bot_token_ref":"secret/vm/e2e-sup/telegram","openai_api_key_ref":"secret/vm/e2e-sup/openai"},"ttl_seconds":3600}' >/dev/null

for action in start snapshot stop killswitch; do
  log_info "supervisor action=$action sandbox_id=sbx-sup"
  RESP="$(curl -fsS -X POST "http://$SUP_ADDR/v1/supervisor/sandboxes/sbx-sup:$action")"
  assert_non_empty "supervisor action response ($action)" "$RESP"
done

SUP_STATUS="$(curl -fsS "http://$SUP_ADDR/v1/supervisor/sandboxes/sbx-sup")"
[[ "$(echo "$SUP_STATUS" | jq -r '.sandbox_id')" == "sbx-sup" ]] || { log_error "supervisor status sandbox_id mismatch"; exit 1; }
log_info "supervisor status verified sandbox_id=sbx-sup"

log_info "PASS"
log_info "logs: nanoclawd=$NANOCLAWD_LOG sessiond=$SESSIOND_LOG vm-supervisor=$SUP_LOG"
