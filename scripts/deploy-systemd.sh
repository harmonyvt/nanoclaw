#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_TEMPLATE="$ROOT_DIR/systemd/com.nanoclaw.service"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_DEST="$UNIT_DIR/com.nanoclaw.service"

if command -v bun >/dev/null 2>&1; then
  BUN_PATH="$(command -v bun)"
elif [[ -x "$HOME/.bun/bin/bun" ]]; then
  BUN_PATH="$HOME/.bun/bin/bun"
else
  echo "[nanoclaw] ERROR: bun not found in PATH or at $HOME/.bun/bin/bun" >&2
  echo "[nanoclaw] Install Bun: https://bun.sh" >&2
  exit 1
fi

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "[nanoclaw] ERROR: deploy-systemd.sh is Linux-only." >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "[nanoclaw] ERROR: systemctl not found. Install systemd or deploy manually." >&2
  exit 1
fi

if [[ ! -f "$UNIT_TEMPLATE" ]]; then
  echo "[nanoclaw] ERROR: systemd unit template missing at $UNIT_TEMPLATE" >&2
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
mkdir -p "$UNIT_DIR"

sed \
  -e "s#{{BUN_PATH}}#$BUN_PATH#g" \
  -e "s#{{PROJECT_ROOT}}#$ROOT_DIR#g" \
  -e "s#{{HOME}}#$HOME#g" \
  "$UNIT_TEMPLATE" > "$UNIT_DEST"

systemctl --user daemon-reload
systemctl --user enable --now com.nanoclaw.service

if systemctl --user is-active --quiet com.nanoclaw.service; then
  echo "[nanoclaw] service active: com.nanoclaw.service"
else
  echo "[nanoclaw] WARNING: service is not active" >&2
  echo "[nanoclaw] Check logs: journalctl --user -u com.nanoclaw.service -n 100 --no-pager" >&2
fi

echo "[nanoclaw] deploy complete"
