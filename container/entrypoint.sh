#!/bin/bash
set -e

# Source credentials from mounted env file
if [ -f /workspace/env-dir/env ]; then
  set -a
  source /workspace/env-dir/env
  set +a
fi

if [ "${NANOCLAW_PERSISTENT}" = "1" ]; then
  # Persistent mode: run agent-runner directly (it watches IPC dir for input)
  exec bun /app/dist/index.js
else
  # One-shot mode: read JSON from stdin, process, output to stdout
  cat > /tmp/input.json
  bun /app/dist/index.js < /tmp/input.json
fi
