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

notify_telegram() {
  local text="$1"
  if [[ "$CAN_NOTIFY" != "1" ]]; then
    return 0
  fi

  curl \
    --silent \
    --show-error \
    --max-time 10 \
    --request POST \
    "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${SELF_UPDATE_CHAT_ID}" \
    --data-urlencode "text=${text}" \
    >/dev/null || true
}

log_step() {
  local message="$1"
  echo "${LOG_PREFIX} ${message}"
  notify_telegram "Update progress: ${message}"
}

fail() {
  local message="$1"
  echo "${LOG_PREFIX} ERROR: ${message}" >&2
  notify_telegram "Update failed: ${message}"
  exit 1
}

on_error() {
  local line="$1"
  notify_telegram "Update failed near script line ${line}. Check logs/self-update.log for details."
}

trap 'on_error "$LINENO"' ERR

SELF_SCRIPT="${BASH_SOURCE[0]}"
REEXECED="${_SELF_UPDATE_REEXECED:-0}"
REBUILD_ONLY="${SELF_UPDATE_REBUILD_ONLY:-0}"

if [[ "$REBUILD_ONLY" == "1" ]]; then
  log_step "rebuild-only mode (no git pull)"
else
  log_step "triggered for ${REMOTE}/${BRANCH}"
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
      log_step "found local uncommitted changes; resetting to HEAD before update"
      echo "$DIRTY"
    fi
    git reset --hard HEAD

    log_step "fetching ${REMOTE}/${BRANCH}"
    git fetch --quiet "$REMOTE" "$BRANCH"

    REMOTE_REF="${REMOTE}/${BRANCH}"
    BEHIND="$(git rev-list --count "HEAD..${REMOTE_REF}")"
    if [[ "$BEHIND" == "0" ]]; then
      log_step "already up to date on ${REMOTE_REF}"
      exit 0
    fi

    OLD_HEAD="$(git rev-parse HEAD)"

    # Snapshot the updater script hash before pulling
    OLD_SCRIPT_HASH="$(shasum -a 256 "$SELF_SCRIPT" | cut -d' ' -f1)"

    log_step "updating to ${REMOTE_REF} (${BEHIND} commit(s) behind)"
    git reset --hard "${REMOTE_REF}"

    # Re-exec if the updater itself changed
    NEW_SCRIPT_HASH="$(shasum -a 256 "$SELF_SCRIPT" | cut -d' ' -f1)"
    if [[ "$OLD_SCRIPT_HASH" != "$NEW_SCRIPT_HASH" ]]; then
      log_step "updater script changed; re-executing fresh version"
      export _SELF_UPDATE_REEXECED=1
      export _SELF_UPDATE_OLD_HEAD="$OLD_HEAD"
      exec bash "$SELF_SCRIPT"
    fi
  else
    # Recover OLD_HEAD passed from the previous exec
    OLD_HEAD="${_SELF_UPDATE_OLD_HEAD:-$(git rev-parse HEAD)}"
  fi
fi

log_step "installing dependencies"
if ! "$BUN_PATH" install --frozen-lockfile; then
  log_step "frozen lockfile install failed; retrying without --frozen-lockfile"
  "$BUN_PATH" install
fi

log_step "building"
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
    log_step "rebuilding agent image"
    bash "${ROOT_DIR}/container/build.sh"
  else
    log_step "docker not found; skipping image rebuild"
  fi
else
  log_step "no container changes; skipping image rebuild"
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

OS="$(uname -s)"
if [[ "$OS" == "Darwin" ]]; then
  if ! command -v launchctl >/dev/null 2>&1; then
    fail "launchctl not found on Darwin host"
  fi
  log_step "restarting launchd service com.nanoclaw"
  launchctl kickstart -k "gui/${UID}/com.nanoclaw"
elif [[ "$OS" == "Linux" ]]; then
  if ! command -v systemctl >/dev/null 2>&1; then
    fail "systemctl not found on Linux host"
  fi
  log_step "restarting systemd user service com.nanoclaw.service"
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

log_step "self-update complete"
