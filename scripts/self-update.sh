#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${SELF_UPDATE_BRANCH:-main}"
REMOTE="${SELF_UPDATE_REMOTE:-origin}"

if command -v bun >/dev/null 2>&1; then
  BUN_PATH="$(command -v bun)"
elif [[ -x "$HOME/.bun/bin/bun" ]]; then
  BUN_PATH="$HOME/.bun/bin/bun"
else
  echo "[nanoclaw] ERROR: bun not found in PATH or at $HOME/.bun/bin/bun" >&2
  exit 1
fi

cd "$ROOT_DIR"

if [[ ! -d .git ]]; then
  echo "[nanoclaw] ERROR: not a git repository: $ROOT_DIR" >&2
  exit 1
fi

echo "[nanoclaw] resetting local changes"
git reset --hard HEAD

echo "[nanoclaw] fetching ${REMOTE}/${BRANCH}"
git fetch --quiet "$REMOTE" "$BRANCH"

REMOTE_REF="${REMOTE}/${BRANCH}"
BEHIND="$(git rev-list --count "HEAD..${REMOTE_REF}")"
if [[ "$BEHIND" == "0" ]]; then
  echo "[nanoclaw] already up to date on ${REMOTE_REF}"
  exit 0
fi

echo "[nanoclaw] updating to ${REMOTE_REF} (${BEHIND} commit(s) behind)"
git reset --hard "${REMOTE_REF}"

echo "[nanoclaw] installing dependencies"
if ! "$BUN_PATH" install --frozen-lockfile; then
  echo "[nanoclaw] frozen lockfile install failed; retrying without --frozen-lockfile"
  "$BUN_PATH" install
fi

echo "[nanoclaw] building"
"$BUN_PATH" run build

OS="$(uname -s)"
if [[ "$OS" == "Darwin" ]]; then
  if ! command -v launchctl >/dev/null 2>&1; then
    echo "[nanoclaw] ERROR: launchctl not found on Darwin host" >&2
    exit 1
  fi
  echo "[nanoclaw] restarting launchd service com.nanoclaw"
  launchctl kickstart -k "gui/${UID}/com.nanoclaw"
elif [[ "$OS" == "Linux" ]]; then
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "[nanoclaw] ERROR: systemctl not found on Linux host" >&2
    exit 1
  fi
  echo "[nanoclaw] restarting systemd user service com.nanoclaw.service"
  systemctl --user restart com.nanoclaw.service
else
  echo "[nanoclaw] ERROR: unsupported OS for self-update: ${OS}" >&2
  exit 1
fi

echo "[nanoclaw] self-update complete"
