#!/usr/bin/env bash
#
# Deploy Qwen3-TTS server to a remote machine via SSH.
#
# Usage:
#   ./tts-server/deploy.sh user@host [api-key]
#
# What it does:
#   1. Rsyncs tts-server/ to ~/nanoclaw-tts/ on the target
#   2. Installs uv + deps
#   3. Installs ffmpeg if missing
#   4. Sets up launchd (macOS) or systemd (Linux) service
#   5. Starts/restarts the service
#
set -euo pipefail

REMOTE="${1:?Usage: $0 user@host [api-key]}"
API_KEY="${2:-}"
REMOTE_DIR="nanoclaw-tts"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> Deploying TTS server to ${REMOTE}..."

# 1. Rsync server files
echo "==> Syncing files..."
rsync -avz --delete \
  --exclude '.venv' \
  --exclude '__pycache__' \
  --exclude '*.pyc' \
  "${SCRIPT_DIR}/" "${REMOTE}:~/${REMOTE_DIR}/"

# 2-6. Run setup on remote
ssh -t "${REMOTE}" bash -s "${API_KEY}" "${REMOTE_DIR}" << 'REMOTE_SCRIPT'
set -euo pipefail

API_KEY="$1"
REMOTE_DIR="$2"
cd ~/"${REMOTE_DIR}"

echo "==> Detecting platform..."
OS="$(uname -s)"
echo "    OS: ${OS}"

# Install system dependencies (ffmpeg + sox)
if [[ "$OS" == "Darwin" ]]; then
  for pkg in ffmpeg sox; do
    if ! command -v "$pkg" &>/dev/null; then
      echo "==> Installing ${pkg}..."
      brew install "$pkg"
    fi
  done
else
  MISSING=()
  command -v ffmpeg &>/dev/null || MISSING+=(ffmpeg)
  command -v sox &>/dev/null || MISSING+=(sox)
  if [ ${#MISSING[@]} -gt 0 ]; then
    echo "==> Installing ${MISSING[*]}..."
    sudo apt-get update -qq && sudo apt-get install -y -qq "${MISSING[@]}"
  fi
fi

# Install uv if missing
if ! command -v uv &>/dev/null; then
  echo "==> Installing uv..."
  curl -LsSf https://astral.sh/uv/install.sh -o /tmp/uv-install.sh && bash /tmp/uv-install.sh
  export PATH="$HOME/.local/bin:$PATH"
fi

echo "==> Installing Python dependencies via uv..."
uv sync

# Generate API key if not provided
if [ -z "$API_KEY" ]; then
  if [ -f .env ] && grep -q "TTS_API_KEY=" .env; then
    echo "==> Using existing API key from .env"
  else
    API_KEY="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
    echo "TTS_API_KEY=${API_KEY}" > .env
    echo "==> Generated API key: ${API_KEY}"
  fi
else
  echo "TTS_API_KEY=${API_KEY}" > .env
  echo "==> Set API key from argument"
fi

# Source .env to get the key for display
source .env

# Set up service — use `uv run` so the venv is automatic
UV_PATH="$(command -v uv)"
SERVER_PATH="$(pwd)/server.py"

if [[ "$OS" == "Darwin" ]]; then
  # macOS: launchd
  PLIST_NAME="com.nanoclaw.tts"
  PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"

  echo "==> Setting up launchd service..."
  cat > "${PLIST_PATH}" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${UV_PATH}</string>
    <string>run</string>
    <string>${SERVER_PATH}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(pwd)</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TTS_API_KEY</key>
    <string>${TTS_API_KEY}</string>
    <key>TTS_PORT</key>
    <string>8787</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$(pwd)/logs/tts.log</string>
  <key>StandardErrorPath</key>
  <string>$(pwd)/logs/tts.error.log</string>
</dict>
</plist>
PLIST

  mkdir -p logs

  # Unload if already loaded, then load
  launchctl unload "${PLIST_PATH}" 2>/dev/null || true
  launchctl load "${PLIST_PATH}"
  echo "==> Service started via launchd"

else
  # Linux: systemd user service
  UNIT_DIR="$HOME/.config/systemd/user"
  UNIT_NAME="nanoclaw-tts"
  mkdir -p "${UNIT_DIR}"

  echo "==> Setting up systemd user service..."
  cat > "${UNIT_DIR}/${UNIT_NAME}.service" << UNIT
[Unit]
Description=Qwen3-TTS Server
After=network.target

[Service]
Type=simple
WorkingDirectory=$(pwd)
ExecStart=${UV_PATH} run ${SERVER_PATH}
EnvironmentFile=$(pwd)/.env
Environment=TTS_PORT=8787
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT

  systemctl --user daemon-reload
  systemctl --user enable "${UNIT_NAME}"
  systemctl --user restart "${UNIT_NAME}"
  echo "==> Service started via systemd"
fi

# Print summary
echo ""
echo "============================================"
echo "  TTS Server deployed successfully!"
echo "============================================"
echo "  API Key: ${TTS_API_KEY}"
echo "  Port:    8787"
echo ""
echo "  Test:"
echo "    curl http://localhost:8787/health"
echo ""
echo "  NanoClaw .env:"
echo "    QWEN_TTS_ENABLED=true"
echo "    QWEN_TTS_URL=http://<tailscale-ip>:8787"
echo "    QWEN_TTS_API_KEY=${TTS_API_KEY}"
echo "============================================"
REMOTE_SCRIPT

echo ""
echo "==> Deploy complete! Set QWEN_TTS_URL in your NanoClaw .env to the Tailscale IP of ${REMOTE}."
