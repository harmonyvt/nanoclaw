#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_IMAGE="${CONTAINER_IMAGE:-nanoclaw-agent:latest}"
CUA_IMAGE_CONFIGURED="${CUA_SANDBOX_IMAGE:-trycua/cua-xfce:latest}"
CUA_PLATFORM="${CUA_SANDBOX_PLATFORM:-linux/amd64}"
CUA_IMAGE="$CUA_IMAGE_CONFIGURED"

cd "$ROOT_DIR"

echo "[nanoclaw] checking Docker prerequisites..."

if ! command -v docker >/dev/null 2>&1; then
  echo "[nanoclaw] ERROR: docker CLI not found. Install Docker Desktop (macOS) or docker engine (Linux)." >&2
  exit 1
fi

docker info >/dev/null 2>&1 || {
  echo "[nanoclaw] ERROR: docker daemon is not running." >&2
  echo "[nanoclaw] Start Docker, then retry." >&2
  exit 1
}

echo "[nanoclaw] docker daemon reachable"

if ! docker image inspect "$AGENT_IMAGE" >/dev/null 2>&1; then
  echo "[nanoclaw] agent image not found: $AGENT_IMAGE"
  echo "[nanoclaw] building agent image via ./container/build.sh"
  ./container/build.sh
else
  echo "[nanoclaw] agent image present: $AGENT_IMAGE"
fi

if [[ "$CUA_IMAGE_CONFIGURED" == "trycua/cua-sandbox:latest" ]]; then
  echo "[nanoclaw] WARNING: CUA_SANDBOX_IMAGE is set to deprecated image $CUA_IMAGE" >&2
  echo "[nanoclaw] Falling back to trycua/cua-xfce:latest. Update .env to silence this warning." >&2
  CUA_IMAGE="trycua/cua-xfce:latest"
fi

if ! docker image inspect "$CUA_IMAGE" >/dev/null 2>&1; then
  echo "[nanoclaw] CUA sandbox image not found: $CUA_IMAGE"
  echo "[nanoclaw] pulling CUA image for platform $CUA_PLATFORM"
  docker pull --platform "$CUA_PLATFORM" "$CUA_IMAGE"
else
  echo "[nanoclaw] CUA sandbox image present: $CUA_IMAGE"
fi

echo "[nanoclaw] Docker requirements look good"
