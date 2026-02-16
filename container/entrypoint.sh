#!/bin/bash
set -e

# Source credentials from mounted env file
if [ -f /workspace/env-dir/env ]; then
  set -a
  source /workspace/env-dir/env
  set +a
fi

# Select runtime version (default: v1)
AGENT_VERSION="${NANOCLAW_AGENT_VERSION:-1}"

if [ "$AGENT_VERSION" = "2" ]; then
  APP_DIR="/app-v2"
else
  APP_DIR="/app"
fi

# Graceful shutdown: forward SIGTERM/SIGINT to the bun process
# so Effect fibers (v2) and cleanup handlers (v1) run properly
cleanup() {
  if [ -n "$PID" ]; then
    kill -TERM "$PID" 2>/dev/null
    wait "$PID" 2>/dev/null
  fi
  exit 0
}

trap cleanup SIGTERM SIGINT

if [ "${NANOCLAW_PERSISTENT}" = "1" ]; then
  # Persistent mode: run agent-runner directly (it watches IPC dir for input)
  bun "$APP_DIR/dist/index.js" &
  PID=$!
  wait "$PID"
else
  # One-shot mode: read JSON from stdin, process, output to stdout
  cat > /tmp/input.json
  bun "$APP_DIR/dist/index.js" < /tmp/input.json &
  PID=$!
  wait "$PID"
fi
