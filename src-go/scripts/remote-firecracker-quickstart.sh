#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="remote-firecracker-quickstart"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_GO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$SRC_GO_DIR/.env"
ENV_EXAMPLE="$SRC_GO_DIR/.env.example"
REMOTE_HELPER="$SRC_GO_DIR/scripts/remote-firecracker.sh"

timestamp_utc() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

log_info() {
  printf '[%s][%s][INFO] %s\n' "$SCRIPT_NAME" "$(timestamp_utc)" "$*" >&2
}

log_warn() {
  printf '[%s][%s][WARN] %s\n' "$SCRIPT_NAME" "$(timestamp_utc)" "$*" >&2
}

log_error() {
  printf '[%s][%s][ERROR] %s\n' "$SCRIPT_NAME" "$(timestamp_utc)" "$*" >&2
}

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
      log_error "$key is required"
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

run_optional_remote_step() {
  local label="$1"
  local command="$2"
  log_info "running remote step: $label"
  if "$REMOTE_HELPER" "$command"; then
    log_info "remote step succeeded: $label"
  else
    log_warn "remote step failed but continuing: $label"
  fi
}

main() {
  if [[ ! -f "$ENV_EXAMPLE" ]]; then
    log_error "missing template: $ENV_EXAMPLE"
    exit 1
  fi
  if [[ ! -x "$REMOTE_HELPER" ]]; then
    log_error "missing helper script: $REMOTE_HELPER"
    exit 1
  fi

  log_info "starting quickstart"
  log_info "target env file: $ENV_FILE"

  if [[ -f "$ENV_FILE" ]] && ! yes_no ".env already exists. Overwrite it"; then
    log_warn "aborted by user"
    exit 0
  fi

  local vm_backend vm_net_mode remote_host remote_workdir remote_src_dir
  local remote_firecracker_bin remote_kernel_image remote_rootfs_image remote_vm_net_mode remote_admin_token_file

  vm_backend="$(prompt_var "NANOCLAW_GO_VM_BACKEND" "VM backend (recommended: firecracker)" "$(default_for NANOCLAW_GO_VM_BACKEND firecracker)" true)"
  vm_net_mode="$(prompt_var "NANOCLAW_GO_VM_NET_MODE" "VM net mode (none|tap)" "$(default_for NANOCLAW_GO_VM_NET_MODE none)" true)"
  remote_host="$(prompt_var "NANOCLAW_REMOTE_HOST" "Remote SSH host (example root@100.64.0.10)" "$(default_for NANOCLAW_REMOTE_HOST)" true)"
  remote_workdir="$(prompt_var "NANOCLAW_REMOTE_WORKDIR" "Remote working directory" "$(default_for NANOCLAW_REMOTE_WORKDIR /root/nanoclaw-buffalo)" true)"
  remote_src_dir="$(prompt_var "NANOCLAW_REMOTE_SRC_GO_DIR" "Remote src-go path" "$(default_for NANOCLAW_REMOTE_SRC_GO_DIR "$remote_workdir/src-go")" true)"
  remote_firecracker_bin="$(prompt_var "NANOCLAW_REMOTE_FIRECRACKER_BIN" "Remote Firecracker binary path" "$(default_for NANOCLAW_REMOTE_FIRECRACKER_BIN /opt/firecracker/bin/firecracker)" true)"
  remote_kernel_image="$(prompt_var "NANOCLAW_REMOTE_KERNEL_IMAGE" "Remote kernel image path" "$(default_for NANOCLAW_REMOTE_KERNEL_IMAGE /opt/firecracker/images/vmlinux.bin)" true)"
  remote_rootfs_image="$(prompt_var "NANOCLAW_REMOTE_ROOTFS_IMAGE" "Remote rootfs image path" "$(default_for NANOCLAW_REMOTE_ROOTFS_IMAGE /opt/firecracker/images/bionic.rootfs.ext4)" true)"
  remote_vm_net_mode="$(prompt_var "NANOCLAW_REMOTE_VM_NET_MODE" "Remote VM net mode (none|tap)" "$(default_for NANOCLAW_REMOTE_VM_NET_MODE none)" true)"
  remote_admin_token_file="$(prompt_var "NANOCLAW_REMOTE_ADMIN_TOKEN_FILE" "Remote admin token file path" "$(default_for NANOCLAW_REMOTE_ADMIN_TOKEN_FILE "$remote_workdir/.secrets/admin-token")" true)"

  log_info "resolved configuration:"
  log_info "NANOCLAW_GO_VM_BACKEND=$vm_backend"
  log_info "NANOCLAW_GO_VM_NET_MODE=$vm_net_mode"
  log_info "NANOCLAW_REMOTE_HOST=$remote_host"
  log_info "NANOCLAW_REMOTE_WORKDIR=$remote_workdir"
  log_info "NANOCLAW_REMOTE_SRC_GO_DIR=$remote_src_dir"
  log_info "NANOCLAW_REMOTE_FIRECRACKER_BIN=$remote_firecracker_bin"
  log_info "NANOCLAW_REMOTE_KERNEL_IMAGE=$remote_kernel_image"
  log_info "NANOCLAW_REMOTE_ROOTFS_IMAGE=$remote_rootfs_image"
  log_info "NANOCLAW_REMOTE_VM_NET_MODE=$remote_vm_net_mode"
  log_info "NANOCLAW_REMOTE_ADMIN_TOKEN_FILE=$remote_admin_token_file"

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
NANOCLAW_REMOTE_ADMIN_TOKEN_FILE=$remote_admin_token_file
EOF

  log_info "wrote $ENV_FILE"

  if yes_no "Run remote doctor now"; then
    run_optional_remote_step "doctor" "doctor"
  else
    log_info "skipped remote doctor"
  fi
  if yes_no "Run remote setup now"; then
    run_optional_remote_step "setup" "setup"
  else
    log_info "skipped remote setup"
  fi
  if yes_no "Sync local src-go to remote now"; then
    run_optional_remote_step "sync" "sync"
  else
    log_info "skipped remote sync"
  fi

  cat <<EOF

Next commands:
  cd "$SRC_GO_DIR"
  ./scripts/remote-firecracker.sh up
  ./scripts/remote-firecracker.sh smoke
  ./scripts/remote-firecracker.sh down
EOF
  log_info "quickstart complete"
}

main "$@"
