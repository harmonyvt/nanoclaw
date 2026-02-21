#!/usr/bin/env bash
set -euo pipefail

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCAL_SRC_GO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${NANOCLAW_GO_ENV_FILE:-$LOCAL_SRC_GO_DIR/.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

REMOTE_HOST="${NANOCLAW_REMOTE_HOST:-}"
REMOTE_WORKDIR="${NANOCLAW_REMOTE_WORKDIR:-/root/nanoclaw-buffalo}"
REMOTE_SRC_GO_DIR="${NANOCLAW_REMOTE_SRC_GO_DIR:-$REMOTE_WORKDIR/src-go}"

REMOTE_FIRECRACKER_BIN="${NANOCLAW_REMOTE_FIRECRACKER_BIN:-/opt/firecracker/bin/firecracker}"
REMOTE_KERNEL_IMAGE="${NANOCLAW_REMOTE_KERNEL_IMAGE:-/opt/firecracker/images/vmlinux.bin}"
REMOTE_ROOTFS_IMAGE="${NANOCLAW_REMOTE_ROOTFS_IMAGE:-/opt/firecracker/images/bionic.rootfs.ext4}"
REMOTE_VM_NET_MODE="${NANOCLAW_REMOTE_VM_NET_MODE:-none}"

usage() {
  cat <<EOF
Usage: scripts/remote-firecracker.sh <command>

Commands:
  doctor                  Check remote host prerequisites and paths
  setup                   Install remote dependencies + Firecracker + demo images
  sync                    Sync local src-go to remote host
  up                      Start remote services (firecracker backend)
  down                    Stop remote services
  restart                 Restart remote services
  status                  Show remote process/health status
  smoke                   Run remote smoke flow
  task [command]          Run one remote Telegram runtime task command
  logs [service|all]      Tail remote logs
  test                    Run remote go test ./...
  shell                   Open an interactive SSH shell

Environment loading:
  Auto-loads $LOCAL_SRC_GO_DIR/.env by default
  Override with NANOCLAW_GO_ENV_FILE=/path/to/custom.env

Remote target defaults:
  NANOCLAW_REMOTE_HOST=$REMOTE_HOST
  NANOCLAW_REMOTE_WORKDIR=$REMOTE_WORKDIR
  NANOCLAW_REMOTE_SRC_GO_DIR=$REMOTE_SRC_GO_DIR

Runtime defaults:
  NANOCLAW_REMOTE_HOST=${REMOTE_HOST:-<required>}
  NANOCLAW_REMOTE_FIRECRACKER_BIN=$REMOTE_FIRECRACKER_BIN
  NANOCLAW_REMOTE_KERNEL_IMAGE=$REMOTE_KERNEL_IMAGE
  NANOCLAW_REMOTE_ROOTFS_IMAGE=$REMOTE_ROOTFS_IMAGE
  NANOCLAW_REMOTE_VM_NET_MODE=$REMOTE_VM_NET_MODE
EOF
}

require_remote_host() {
  if [[ -z "${REMOTE_HOST}" ]]; then
    echo "NANOCLAW_REMOTE_HOST is required (set it in src-go/.env or your shell)." >&2
    exit 1
  fi
}

remote_exec() {
  require_remote_host
  ssh "$REMOTE_HOST" "$@"
}

remote_cli_smoke() {
  local subcommand="$1"
  shift || true
  local escaped_args=""
  for arg in "$@"; do
    escaped_args+=" $(printf '%q' "$arg")"
  done
  remote_exec "set -euo pipefail; cd '$REMOTE_SRC_GO_DIR'; \
    export NANOCLAW_GO_VM_BACKEND=firecracker; \
    export NANOCLAW_GO_FIRECRACKER_BIN='$REMOTE_FIRECRACKER_BIN'; \
    export NANOCLAW_GO_VM_KERNEL_IMAGE='$REMOTE_KERNEL_IMAGE'; \
    export NANOCLAW_GO_CLI_ROOTFS_IMAGE='$REMOTE_ROOTFS_IMAGE'; \
    export NANOCLAW_GO_VM_NET_MODE='$REMOTE_VM_NET_MODE'; \
    ./scripts/cli-smoke.sh '$subcommand'${escaped_args}"
}

cmd_doctor() {
  remote_exec "set -euo pipefail; \
    echo '== host =='; hostname; uname -a; \
    echo '== os =='; cat /etc/os-release || true; \
    echo '== kvm =='; ls -l /dev/kvm || true; \
    echo '== go =='; command -v go || true; go version || true; \
    echo '== git =='; command -v git || true; git --version || true; \
    echo '== firecracker =='; \
      if [ -x '$REMOTE_FIRECRACKER_BIN' ]; then '$REMOTE_FIRECRACKER_BIN' --version; else echo 'missing: $REMOTE_FIRECRACKER_BIN'; fi; \
    echo '== kernel image =='; ls -lh '$REMOTE_KERNEL_IMAGE' || true; \
    echo '== rootfs image =='; ls -lh '$REMOTE_ROOTFS_IMAGE' || true; \
    echo '== src-go =='; ls -la '$REMOTE_SRC_GO_DIR' || true"
}

cmd_setup() {
  require_cmd ssh
  remote_exec "set -euo pipefail; \
    export DEBIAN_FRONTEND=noninteractive; \
    apt-get update -y >/tmp/nanoclaw-remote-apt-update.log; \
    apt-get install -y curl jq git golang-go >/tmp/nanoclaw-remote-apt-install.log; \
    mkdir -p \$(dirname '$REMOTE_FIRECRACKER_BIN') \$(dirname '$REMOTE_KERNEL_IMAGE'); \
    if [ ! -x '$REMOTE_FIRECRACKER_BIN' ]; then \
      ARCH=\$(uname -m); \
      REL=\$(curl -fsSLI -o /dev/null -w %{url_effective} https://github.com/firecracker-microvm/firecracker/releases/latest | xargs basename); \
      curl -fL \"https://github.com/firecracker-microvm/firecracker/releases/download/\${REL}/firecracker-\${REL}-\${ARCH}.tgz\" -o /tmp/firecracker.tgz; \
      tar -xzf /tmp/firecracker.tgz -C /tmp; \
      cp \"/tmp/release-\${REL}-\${ARCH}/firecracker-\${REL}-\${ARCH}\" '$REMOTE_FIRECRACKER_BIN'; \
      chmod +x '$REMOTE_FIRECRACKER_BIN'; \
    fi; \
    if [ ! -f '$REMOTE_KERNEL_IMAGE' ]; then \
      curl -fL \"https://s3.amazonaws.com/spec.ccfc.min/img/quickstart_guide/\$(uname -m)/kernels/vmlinux.bin\" -o '$REMOTE_KERNEL_IMAGE'; \
    fi; \
    if [ ! -f '$REMOTE_ROOTFS_IMAGE' ]; then \
      curl -fL \"https://s3.amazonaws.com/spec.ccfc.min/img/quickstart_guide/\$(uname -m)/rootfs/bionic.rootfs.ext4\" -o '$REMOTE_ROOTFS_IMAGE'; \
    fi; \
    echo 'setup complete'; \
    go version; \
    '$REMOTE_FIRECRACKER_BIN' --version"
}

cmd_sync() {
  require_cmd ssh
  require_cmd tar
  COPYFILE_DISABLE=1 tar -C "$LOCAL_SRC_GO_DIR/.." -czf - src-go \
    | ssh "$REMOTE_HOST" "set -euo pipefail; mkdir -p '$REMOTE_WORKDIR'; rm -rf '$REMOTE_SRC_GO_DIR'; tar -xzf - -C '$REMOTE_WORKDIR'; chmod +x '$REMOTE_SRC_GO_DIR/scripts/cli-smoke.sh'; find '$REMOTE_SRC_GO_DIR' -name '._*' -type f -delete"
  echo "synced local src-go -> $REMOTE_HOST:$REMOTE_SRC_GO_DIR"
}

cmd_up() {
  remote_cli_smoke up
}

cmd_down() {
  remote_cli_smoke down
}

cmd_restart() {
  remote_cli_smoke down || true
  remote_cli_smoke up
}

cmd_status() {
  remote_cli_smoke status
}

cmd_smoke() {
  remote_cli_smoke smoke
}

cmd_task() {
  remote_cli_smoke task "${1:-telegram-agent --runtime microvm --source remote-firecracker}"
}

cmd_logs() {
  remote_cli_smoke logs "${1:-all}"
}

cmd_test() {
  remote_exec "set -euo pipefail; cd '$REMOTE_SRC_GO_DIR'; go test ./..."
}

cmd_shell() {
  exec ssh "$REMOTE_HOST"
}

main() {
  local cmd="${1:-help}"
  shift || true

  case "$cmd" in
    doctor) cmd_doctor "$@" ;;
    setup) cmd_setup "$@" ;;
    sync) cmd_sync "$@" ;;
    up) cmd_up "$@" ;;
    down) cmd_down "$@" ;;
    restart) cmd_restart "$@" ;;
    status) cmd_status "$@" ;;
    smoke) cmd_smoke "$@" ;;
    task) cmd_task "$@" ;;
    logs) cmd_logs "$@" ;;
    test) cmd_test "$@" ;;
    shell) cmd_shell "$@" ;;
    help|-h|--help) usage ;;
    *)
      echo "unknown command: $cmd" >&2
      usage
      exit 1
      ;;
  esac
}

main "$@"
