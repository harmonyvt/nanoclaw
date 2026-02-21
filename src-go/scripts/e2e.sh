#!/usr/bin/env bash
set -euo pipefail

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

require_cmd go
require_cmd curl
require_cmd jq

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
NANOCLAWD_ADDR="127.0.0.1:18088"
SESSIOND_ADDR="127.0.0.1:18089"
SUP_ADDR="127.0.0.1:18090"
STATE_FILE="$TMP_DIR/state.json"
FIRECRACKER_BIN="${NANOCLAW_GO_FIRECRACKER_BIN:-/opt/firecracker/bin/firecracker}"

if [[ ! -x "$FIRECRACKER_BIN" ]]; then
  echo "missing firecracker binary: $FIRECRACKER_BIN" >&2
  exit 1
fi

NANOCLAWD_PID=""
SESSIOND_PID=""
SUP_PID=""

cleanup() {
  set +e
  if [[ -n "$NANOCLAWD_PID" ]]; then
    kill "$NANOCLAWD_PID" >/dev/null 2>&1
    wait "$NANOCLAWD_PID" >/dev/null 2>&1
  fi
  if [[ -n "$SESSIOND_PID" ]]; then
    kill "$SESSIOND_PID" >/dev/null 2>&1
    wait "$SESSIOND_PID" >/dev/null 2>&1
  fi
  if [[ -n "$SUP_PID" ]]; then
    kill "$SUP_PID" >/dev/null 2>&1
    wait "$SUP_PID" >/dev/null 2>&1
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

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

echo "[e2e] starting nanoclawd"
(
  cd "$ROOT_DIR"
  NANOCLAW_GO_API_ADDR="$NANOCLAWD_ADDR" \
  NANOCLAW_GO_SESSION_ADDR="$SESSIOND_ADDR" \
  NANOCLAW_GO_SUPERVISOR_ADDR="$SUP_ADDR" \
  NANOCLAW_GO_STATE_FILE="$STATE_FILE" \
  NANOCLAW_GO_VM_BACKEND=firecracker \
  NANOCLAW_GO_FIRECRACKER_BIN="$FIRECRACKER_BIN" \
  go run ./cmd/nanoclawd >/tmp/nanoclawd-e2e.log 2>&1
) &
NANOCLAWD_PID=$!
wait_for_health "http://$NANOCLAWD_ADDR/healthz"

echo "[e2e] nanoclawd task/sandbox/session flow"
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
[[ -n "$TASK_ID" && "$TASK_ID" != "null" ]]
[[ -n "$SBX_ID" && "$SBX_ID" != "null" ]]
[[ "$STATUS" == "accepted" ]]

GET_TASK="$(curl -fsS "http://$NANOCLAWD_ADDR/v1/tasks/$TASK_ID")"
[[ "$(echo "$GET_TASK" | jq -r '.task_id')" == "$TASK_ID" ]]

for action in stop start snapshot destroy; do
  RESP="$(curl -fsS -X POST "http://$NANOCLAWD_ADDR/v1/sandboxes/$SBX_ID:$action")"
  [[ -n "$RESP" ]]
done

SESS_RESP="$(curl -fsS -X POST "http://$NANOCLAWD_ADDR/v1/sessions" \
  -H 'content-type: application/json' \
  -d "{\"sandbox_id\":\"$SBX_ID\",\"command\":\"sh\"}")"
SESS_ID="$(echo "$SESS_RESP" | jq -r '.session_id')"
[[ -n "$SESS_ID" && "$SESS_ID" != "null" ]]

echo "[e2e] starting sessiond"
(
  cd "$ROOT_DIR"
  NANOCLAW_GO_SESSION_ADDR="$SESSIOND_ADDR" \
  go run ./cmd/sessiond >/tmp/sessiond-e2e.log 2>&1
) &
SESSIOND_PID=$!
wait_for_health "http://$SESSIOND_ADDR/healthz"

SESSIOND_CREATE="$(curl -fsS -X POST "http://$SESSIOND_ADDR/v1/sessions" \
  -H 'content-type: application/json' \
  -d '{"sandbox_id":"sbx-sess","command":"sh"}')"
SESSIOND_ID="$(echo "$SESSIOND_CREATE" | jq -r '.session_id')"
[[ -n "$SESSIOND_ID" && "$SESSIOND_ID" != "null" ]]

curl -fsS -X POST "http://$SESSIOND_ADDR/v1/sessions/$SESSIOND_ID:input" \
  -H 'content-type: application/json' -d '{"input":"echo hi"}' >/dev/null
curl -fsS -X POST "http://$SESSIOND_ADDR/v1/sessions/$SESSIOND_ID:resize" \
  -H 'content-type: application/json' -d '{"rows":40,"cols":120}' >/dev/null
curl -fsS -X POST "http://$SESSIOND_ADDR/v1/sessions/$SESSIOND_ID:terminate" >/dev/null

echo "[e2e] starting vm-supervisor"
(
  cd "$ROOT_DIR"
  NANOCLAW_GO_SUPERVISOR_ADDR="$SUP_ADDR" \
  NANOCLAW_GO_VM_BACKEND=firecracker \
  NANOCLAW_GO_FIRECRACKER_BIN="$FIRECRACKER_BIN" \
  go run ./cmd/vm-supervisor >/tmp/vm-supervisor-e2e.log 2>&1
) &
SUP_PID=$!
wait_for_health "http://$SUP_ADDR/healthz"

curl -fsS -X POST "http://$SUP_ADDR/v1/supervisor/sandboxes" \
  -H 'content-type: application/json' \
  -d '{"sandbox_id":"sbx-sup","desired_state":"stopped","vm_profile":{"kernel_image":"vmlinux","rootfs_image":"rootfs.img","vcpu":1,"memory_mib":256},"network_policy":{"default_deny":true,"allow":[]},"credential_refs":{"telegram_bot_token_ref":"secret/vm/e2e-sup/telegram","openai_api_key_ref":"secret/vm/e2e-sup/openai"},"ttl_seconds":3600}' >/dev/null

for action in start snapshot stop killswitch; do
  RESP="$(curl -fsS -X POST "http://$SUP_ADDR/v1/supervisor/sandboxes/sbx-sup:$action")"
  [[ -n "$RESP" ]]
done

SUP_STATUS="$(curl -fsS "http://$SUP_ADDR/v1/supervisor/sandboxes/sbx-sup")"
[[ "$(echo "$SUP_STATUS" | jq -r '.sandbox_id')" == "sbx-sup" ]]

echo "[e2e] PASS"
