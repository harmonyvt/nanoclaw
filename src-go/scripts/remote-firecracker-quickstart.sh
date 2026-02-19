#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_GO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$SRC_GO_DIR/.env"
ENV_EXAMPLE="$SRC_GO_DIR/.env.example"
REMOTE_HELPER="$SRC_GO_DIR/scripts/remote-firecracker.sh"

read_key_from_file() {
  local key="$1"
  local file="$2"
  if [[ ! -f "$file" ]]; then
    return 1
  fi
  local line
  line="$(grep -E "^${key}=" "$file" | tail -n 1 || true)"
  if [[ -z "$line" ]]; then
    return 1
  fi
  printf '%s' "${line#*=}"
  return 0
}

default_for() {
  local key="$1"
  local fallback="${2:-}"
  local value=""
  if value="$(read_key_from_file "$key" "$ENV_FILE")"; then
    printf '%s' "$value"
    return 0
  fi
  if value="$(read_key_from_file "$key" "$ENV_EXAMPLE")"; then
    printf '%s' "$value"
    return 0
  fi
  printf '%s' "$fallback"
}

prompt_var() {
  local key="$1"
  local prompt="$2"
  local default_value="$3"
  local required="${4:-false}"
  local value=""
  while true; do
    if [[ -n "$default_value" ]]; then
      read -r -p "$prompt [$default_value]: " value
      if [[ -z "$value" ]]; then
        value="$default_value"
      fi
    else
      read -r -p "$prompt: " value
    fi
    if [[ "$required" == "true" && -z "$value" ]]; then
      echo "$key is required." >&2
      continue
    fi
    printf '%s' "$value"
    return 0
  done
}

yes_no() {
  local prompt="$1"
  local answer=""
  read -r -p "$prompt [y/N]: " answer
  case "${answer,,}" in
    y|yes) return 0 ;;
    *) return 1 ;;
  esac
}

main() {
  if [[ ! -f "$ENV_EXAMPLE" ]]; then
    echo "missing template: $ENV_EXAMPLE" >&2
    exit 1
  fi
  if [[ ! -x "$REMOTE_HELPER" ]]; then
    echo "missing helper script: $REMOTE_HELPER" >&2
    exit 1
  fi

  echo "Remote Firecracker quickstart"
  echo "This will create/update: $ENV_FILE"
  echo

  if [[ -f "$ENV_FILE" ]] && ! yes_no ".env already exists. Overwrite it"; then
    echo "aborted"
    exit 0
  fi

  local vm_backend vm_net_mode remote_host remote_workdir remote_src_dir
  local remote_firecracker_bin remote_kernel_image remote_rootfs_image remote_vm_net_mode

  vm_backend="$(prompt_var "NANOCLAW_GO_VM_BACKEND" "Local default VM backend (simulated|firecracker)" "$(default_for NANOCLAW_GO_VM_BACKEND simulated)" true)"
  vm_net_mode="$(prompt_var "NANOCLAW_GO_VM_NET_MODE" "Local VM net mode (none|tap)" "$(default_for NANOCLAW_GO_VM_NET_MODE none)" true)"
  remote_host="$(prompt_var "NANOCLAW_REMOTE_HOST" "Remote SSH host (example root@100.64.0.10)" "$(default_for NANOCLAW_REMOTE_HOST)" true)"
  remote_workdir="$(prompt_var "NANOCLAW_REMOTE_WORKDIR" "Remote working directory" "$(default_for NANOCLAW_REMOTE_WORKDIR /root/nanoclaw-buffalo)" true)"
  remote_src_dir="$(prompt_var "NANOCLAW_REMOTE_SRC_GO_DIR" "Remote src-go path" "$(default_for NANOCLAW_REMOTE_SRC_GO_DIR "$remote_workdir/src-go")" true)"
  remote_firecracker_bin="$(prompt_var "NANOCLAW_REMOTE_FIRECRACKER_BIN" "Remote Firecracker binary path" "$(default_for NANOCLAW_REMOTE_FIRECRACKER_BIN /opt/firecracker/bin/firecracker)" true)"
  remote_kernel_image="$(prompt_var "NANOCLAW_REMOTE_KERNEL_IMAGE" "Remote kernel image path" "$(default_for NANOCLAW_REMOTE_KERNEL_IMAGE /opt/firecracker/images/vmlinux.bin)" true)"
  remote_rootfs_image="$(prompt_var "NANOCLAW_REMOTE_ROOTFS_IMAGE" "Remote rootfs image path" "$(default_for NANOCLAW_REMOTE_ROOTFS_IMAGE /opt/firecracker/images/bionic.rootfs.ext4)" true)"
  remote_vm_net_mode="$(prompt_var "NANOCLAW_REMOTE_VM_NET_MODE" "Remote VM net mode (none|tap)" "$(default_for NANOCLAW_REMOTE_VM_NET_MODE none)" true)"

  cat > "$ENV_FILE" <<EOF
NANOCLAW_GO_VM_BACKEND=$vm_backend
NANOCLAW_GO_VM_NET_MODE=$vm_net_mode

NANOCLAW_REMOTE_HOST=$remote_host
NANOCLAW_REMOTE_WORKDIR=$remote_workdir
NANOCLAW_REMOTE_SRC_GO_DIR=$remote_src_dir

NANOCLAW_REMOTE_FIRECRACKER_BIN=$remote_firecracker_bin
NANOCLAW_REMOTE_KERNEL_IMAGE=$remote_kernel_image
NANOCLAW_REMOTE_ROOTFS_IMAGE=$remote_rootfs_image
NANOCLAW_REMOTE_VM_NET_MODE=$remote_vm_net_mode
EOF

  echo
  echo "Wrote $ENV_FILE"
  echo

  if yes_no "Run remote doctor now"; then
    "$REMOTE_HELPER" doctor || true
  fi
  if yes_no "Run remote setup now"; then
    "$REMOTE_HELPER" setup || true
  fi
  if yes_no "Sync local src-go to remote now"; then
    "$REMOTE_HELPER" sync || true
  fi

  cat <<EOF

Next commands:
  cd "$SRC_GO_DIR"
  ./scripts/remote-firecracker.sh up
  ./scripts/remote-firecracker.sh smoke
  ./scripts/remote-firecracker.sh down
EOF
}

main "$@"

