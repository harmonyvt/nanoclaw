#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST_TEMPLATE="$ROOT_DIR/launchd/com.nanoclaw.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/com.nanoclaw.plist"
BUN_PATH="$(command -v bun)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[nanoclaw] ERROR: deploy-launchd.sh is macOS-only." >&2
  exit 1
fi

if [[ ! -f "$PLIST_TEMPLATE" ]]; then
  echo "[nanoclaw] ERROR: plist template missing at $PLIST_TEMPLATE" >&2
  exit 1
fi

cd "$ROOT_DIR"

./scripts/ensure-docker-requirements.sh

if [[ ! -f .env ]]; then
  echo "[nanoclaw] ERROR: .env is missing. Create it from .env.example first." >&2
  exit 1
fi

if ! grep -q '^TELEGRAM_BOT_TOKEN=' .env; then
  echo "[nanoclaw] ERROR: TELEGRAM_BOT_TOKEN is missing in .env" >&2
  exit 1
fi

if ! grep -q '^TELEGRAM_OWNER_ID=' .env; then
  echo "[nanoclaw] ERROR: TELEGRAM_OWNER_ID is missing in .env" >&2
  exit 1
fi

bun run build
mkdir -p logs
mkdir -p "$HOME/Library/LaunchAgents"

sed \
  -e "s#{{BUN_PATH}}#$BUN_PATH#g" \
  -e "s#{{PROJECT_ROOT}}#$ROOT_DIR#g" \
  -e "s#{{HOME}}#$HOME#g" \
  "$PLIST_TEMPLATE" > "$PLIST_DEST"

launchctl unload "$PLIST_DEST" >/dev/null 2>&1 || true
launchctl load "$PLIST_DEST"

if launchctl list | grep -q com.nanoclaw; then
  echo "[nanoclaw] service loaded: com.nanoclaw"
else
  echo "[nanoclaw] WARNING: service did not appear in launchctl list" >&2
fi

echo "[nanoclaw] deploy complete"
