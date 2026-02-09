#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${SELF_UPDATE_BRANCH:-main}"
REMOTE="${SELF_UPDATE_REMOTE:-origin}"
SELF_UPDATE_CHAT_ID="${SELF_UPDATE_CHAT_ID:-}"
TELEGRAM_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
LOG_PREFIX="[nanoclaw]"
CAN_NOTIFY=0

if [[ -n "$SELF_UPDATE_CHAT_ID" && -n "$TELEGRAM_TOKEN" ]] && command -v curl >/dev/null 2>&1; then
  CAN_NOTIFY=1
fi

# --- Progressive single-message Telegram notifications ---
# Instead of flooding the chat with one message per step, we send a single
# message and edit it as each step completes. Completed steps get a checkmark,
# the current step gets a spinner, and failures get an X.

PROGRESS_MSG_ID="${_SELF_UPDATE_MSG_ID:-}"
PROGRESS_DONE="${_SELF_UPDATE_DONE:-}"
CURRENT_STEP=""

render_progress() {
  local text="${PROGRESS_DONE}"
  if [[ -n "$CURRENT_STEP" ]]; then
    text+="$(printf '⏳ %s...' "$CURRENT_STEP")"
  fi
  printf '%s' "$text"
}

send_or_edit() {
  local text="$1"
  [[ "$CAN_NOTIFY" == "1" ]] || return 0
  [[ -n "$text" ]] || return 0

  if [[ -z "$PROGRESS_MSG_ID" ]]; then
    local resp
    resp=$(curl -s --max-time 10 -X POST \
      "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${SELF_UPDATE_CHAT_ID}" \
      --data-urlencode "text=${text}" 2>/dev/null) || return 0
    PROGRESS_MSG_ID=$(printf '%s' "$resp" | sed -n 's/.*"message_id":\([0-9]*\).*/\1/p' | head -1)
  else
    curl -s --max-time 10 -X POST \
      "https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText" \
      --data-urlencode "chat_id=${SELF_UPDATE_CHAT_ID}" \
      --data-urlencode "message_id=${PROGRESS_MSG_ID}" \
      --data-urlencode "text=${text}" \
      >/dev/null 2>&1 || true
  fi
}

log_step() {
  local message="$1"
  echo "${LOG_PREFIX} ${message}"

  # Mark previous step as completed
  if [[ -n "$CURRENT_STEP" ]]; then
    PROGRESS_DONE+="$(printf '✓ %s\n' "$CURRENT_STEP")"
  fi
  CURRENT_STEP="$message"

  send_or_edit "$(render_progress)"
}

# Mark current step done and show final success
log_done() {
  local message="$1"
  echo "${LOG_PREFIX} ${message}"

  if [[ -n "$CURRENT_STEP" ]]; then
    PROGRESS_DONE+="$(printf '✓ %s\n' "$CURRENT_STEP")"
  fi
  CURRENT_STEP=""
  PROGRESS_DONE+="$(printf '✅ %s' "$message")"

  send_or_edit "$PROGRESS_DONE"
}

fail() {
  local message="$1"
  echo "${LOG_PREFIX} ERROR: ${message}" >&2

  local text="${PROGRESS_DONE}"
  if [[ -n "$CURRENT_STEP" ]]; then
    text+="$(printf '✗ %s\n' "$CURRENT_STEP")"
  fi
  text+="$(printf '❌ %s' "$message")"

  send_or_edit "$text"
  exit 1
}

on_error() {
  local line="$1"
  local text="${PROGRESS_DONE}"
  if [[ -n "$CURRENT_STEP" ]]; then
    text+="$(printf '✗ %s\n' "$CURRENT_STEP")"
  fi
  text+="$(printf '❌ Failed near line %s. Check logs/self-update.log' "$line")"
  send_or_edit "$text"
}

trap 'on_error "$LINENO"' ERR

SELF_SCRIPT="${BASH_SOURCE[0]}"
REEXECED="${_SELF_UPDATE_REEXECED:-0}"
REBUILD_ONLY="${SELF_UPDATE_REBUILD_ONLY:-0}"

if [[ "$REBUILD_ONLY" == "1" ]]; then
  log_step "Rebuild (no git pull)"
else
  log_step "Updating from ${REMOTE}/${BRANCH}"
fi

if command -v bun >/dev/null 2>&1; then
  BUN_PATH="$(command -v bun)"
elif [[ -x "$HOME/.bun/bin/bun" ]]; then
  BUN_PATH="$HOME/.bun/bin/bun"
else
  fail "bun not found in PATH or at $HOME/.bun/bin/bun"
fi

cd "$ROOT_DIR"

if [[ ! -d .git ]]; then
  fail "not a git repository: $ROOT_DIR"
fi

# In rebuild-only mode, skip all git operations
if [[ "$REBUILD_ONLY" != "1" ]]; then
  # If we were re-execed after a git pull, skip straight to install/build/restart
  if [[ "$REEXECED" != "1" ]]; then
    DIRTY="$(git diff --stat)"
    if [[ -n "$DIRTY" ]]; then
      log_step "Resetting local changes"
      echo "$DIRTY"
    fi
    git reset --hard HEAD

    log_step "Fetching ${REMOTE}/${BRANCH}"
    git fetch --quiet "$REMOTE" "$BRANCH"

    REMOTE_REF="${REMOTE}/${BRANCH}"
    BEHIND="$(git rev-list --count "HEAD..${REMOTE_REF}")"
    if [[ "$BEHIND" == "0" ]]; then
      log_done "Already up to date"
      exit 0
    fi

    OLD_HEAD="$(git rev-parse HEAD)"

    # Snapshot the updater script hash before pulling
    OLD_SCRIPT_HASH="$(shasum -a 256 "$SELF_SCRIPT" | cut -d' ' -f1)"

    log_step "Pulling ${BEHIND} commit(s)"
    git reset --hard "${REMOTE_REF}"

    # Re-exec if the updater itself changed
    NEW_SCRIPT_HASH="$(shasum -a 256 "$SELF_SCRIPT" | cut -d' ' -f1)"
    if [[ "$OLD_SCRIPT_HASH" != "$NEW_SCRIPT_HASH" ]]; then
      log_step "Re-executing updated script"
      # Carry progress state across exec
      if [[ -n "$CURRENT_STEP" ]]; then
        PROGRESS_DONE+="$(printf '✓ %s\n' "$CURRENT_STEP")"
      fi
      export _SELF_UPDATE_REEXECED=1
      export _SELF_UPDATE_OLD_HEAD="$OLD_HEAD"
      export _SELF_UPDATE_MSG_ID="$PROGRESS_MSG_ID"
      export _SELF_UPDATE_DONE="$PROGRESS_DONE"
      exec bash "$SELF_SCRIPT"
    fi
  else
    # Recover state passed from the previous exec
    OLD_HEAD="${_SELF_UPDATE_OLD_HEAD:-$(git rev-parse HEAD)}"
  fi
fi

log_step "Installing dependencies"
if ! "$BUN_PATH" install --frozen-lockfile; then
  log_step "Retrying install (no frozen lockfile)"
  "$BUN_PATH" install
fi

log_step "Building"
"$BUN_PATH" run build

# Rebuild the agent container if needed
if [[ "$REBUILD_ONLY" == "1" ]]; then
  # In rebuild-only mode, always rebuild the container
  CONTAINER_CHANGED="rebuild-only"
else
  CONTAINER_CHANGED="$(git diff --name-only "${OLD_HEAD}..HEAD" -- container/)"
fi
if [[ -n "$CONTAINER_CHANGED" ]]; then
  if command -v docker >/dev/null 2>&1; then
    log_step "Rebuilding agent container"
    bash "${ROOT_DIR}/container/build.sh"
  else
    log_step "Skipping container (docker not found)"
  fi
else
  # Mark as skipped in log but don't update progress (not interesting)
  echo "${LOG_PREFIX} no container changes; skipping image rebuild"
fi

# Write a marker so the new process can verify the update on startup
NEW_HEAD="$(git rev-parse HEAD)"
MARKER_FILE="${ROOT_DIR}/data/self-update-pending.json"
mkdir -p "${ROOT_DIR}/data"
if [[ -n "$CONTAINER_CHANGED" ]]; then
  REBUILT_FLAG="true"
else
  REBUILT_FLAG="false"
fi
cat > "$MARKER_FILE" <<MARKER_EOF
{"expectedHead":"${NEW_HEAD}","chatId":"${SELF_UPDATE_CHAT_ID}","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","containerRebuilt":${REBUILT_FLAG}}
MARKER_EOF

log_step "Restarting service"

OS="$(uname -s)"
if [[ "$OS" == "Darwin" ]]; then
  if ! command -v launchctl >/dev/null 2>&1; then
    fail "launchctl not found on Darwin host"
  fi
  # On macOS, kickstart -k kills this process, so the progress message
  # will show "⏳ Restarting service..." as the last state. The post-restart
  # verification (verifySelfUpdate) sends the final confirmation.
  launchctl kickstart -k "gui/${UID}/com.nanoclaw"
elif [[ "$OS" == "Linux" ]]; then
  if ! command -v systemctl >/dev/null 2>&1; then
    fail "systemctl not found on Linux host"
  fi
  # Use systemd-run to restart from a separate cgroup scope, so this script
  # isn't killed when systemd tears down the service's cgroup.
  if command -v systemd-run >/dev/null 2>&1; then
    systemd-run --user --no-block --unit=nanoclaw-self-update-restart \
      systemctl --user restart com.nanoclaw.service
  else
    # Fallback: direct restart (script will be killed, exit code will be null)
    systemctl --user restart com.nanoclaw.service
  fi
else
  fail "unsupported OS for self-update: ${OS}"
fi

log_done "Update complete"
