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

# Suppress dbus errors in container
export DBUS_SESSION_BUS_ADDRESS=/dev/null

# Remove stale Chrome profile lock (from previous container)
rm -f /data/chrome-profile/SingletonLock /data/chrome-profile/SingletonCookie /data/chrome-profile/SingletonSocket

# Start Chromium (non-headless, on virtual display)
# Chromium binds to 127.0.0.1 only (Debian ignores --remote-debugging-address=0.0.0.0)
# socat below bridges 0.0.0.0:9222 -> 127.0.0.1:9333 for Docker port mapping
chromium \
  --no-first-run \
  --no-default-browser-check \
  --no-sandbox \
  --disable-gpu \
  --disable-software-rasterizer \
  --disable-dev-shm-usage \
  --remote-debugging-port=9333 \
  --remote-debugging-address=0.0.0.0 \
  --user-data-dir=/data/chrome-profile \
  --start-maximized &
PIDS+=($!)
sleep 2

# Wait for Chromium CDP to be ready on internal port
for i in $(seq 1 15); do
  if curl -sf http://127.0.0.1:9333/json/version >/dev/null 2>&1; then
    echo "Chromium CDP is ready on port 9333"
    break
  fi
  sleep 1
done

# Forward CDP to 0.0.0.0:9222 so Docker port mapping can reach it
socat TCP-LISTEN:9222,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:9333 &
PIDS+=($!)

# Verify external CDP is reachable
for i in $(seq 1 5); do
  if curl -sf http://localhost:9222/json/version >/dev/null 2>&1; then
    echo "CDP forwarding ready on port 9222"
    break
  fi
  sleep 1
done

# Start x11vnc
x11vnc -display :99 -forever -nopw -shared -rfbport 5900 &
PIDS+=($!)
sleep 1

# Start websockify/noVNC
websockify --web /usr/share/novnc 6080 localhost:5900 &
PIDS+=($!)

# Wait for any process to exit
wait -n
exit $?
