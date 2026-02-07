#!/bin/bash
set -e

# Track child PIDs for graceful shutdown
PIDS=()

cleanup() {
  echo "Shutting down sandbox..."
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  wait
  exit 0
}

trap cleanup SIGTERM SIGINT

# Start Xvfb
Xvfb :99 -screen 0 1920x1080x24 -ac &
PIDS+=($!)
export DISPLAY=:99
sleep 1

# Start Chromium (non-headless, on virtual display)
chromium \
  --no-first-run \
  --no-default-browser-check \
  --no-sandbox \
  --disable-gpu \
  --disable-software-rasterizer \
  --remote-debugging-port=9333 \
  --remote-debugging-address=0.0.0.0 \
  --user-data-dir=/data/chrome-profile \
  --start-maximized &
PIDS+=($!)
sleep 2

# Start x11vnc
x11vnc -display :99 -forever -nopw -shared -rfbport 5900 &
PIDS+=($!)
sleep 1

# Forward CDP port to 0.0.0.0 (Chromium only binds to 127.0.0.1)
socat TCP-LISTEN:9222,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:9333 &
PIDS+=($!)

# Start websockify/noVNC
websockify --web /usr/share/novnc 6080 localhost:5900 &
PIDS+=($!)

# Wait for any process to exit
wait -n
exit $?
