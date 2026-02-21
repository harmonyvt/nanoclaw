#!/usr/bin/env bash
set -euo pipefail

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    log_error "missing required command: $1"
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
REMOTE_ADMIN_TOKEN_FILE="${NANOCLAW_REMOTE_ADMIN_TOKEN_FILE:-$REMOTE_WORKDIR/.secrets/admin-token}"
REMOTE_TASK_RUNTIME="${NANOCLAW_GO_TASK_RUNTIME:-bun}"
SYNC_AUTO_RESTART="${NANOCLAW_REMOTE_SYNC_AUTO_RESTART:-1}"
SYNC_BUILD="${NANOCLAW_REMOTE_SYNC_BUILD:-1}"
SYNC_BUILD_GO="${NANOCLAW_REMOTE_SYNC_BUILD_GO:-1}"
SYNC_BUILD_FRONTEND="${NANOCLAW_REMOTE_SYNC_BUILD_FRONTEND:-1}"
SYNC_FRONTEND_INSTALL="${NANOCLAW_REMOTE_SYNC_FRONTEND_INSTALL:-1}"

timestamp_utc() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

log_info() {
  printf '[remote-firecracker][%s] %s\n' "$(timestamp_utc)" "$*" >&2
}

log_warn() {
  printf '[remote-firecracker][%s][WARN] %s\n' "$(timestamp_utc)" "$*" >&2
}

log_error() {
  printf '[remote-firecracker][%s][ERROR] %s\n' "$(timestamp_utc)" "$*" >&2
}

is_truthy() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

usage() {
  cat <<EOF
Usage: scripts/remote-firecracker.sh <command>

Commands:
  info                    Print resolved local/remote configuration
  doctor                  Check remote host prerequisites and paths
  setup                   Install remote dependencies + Firecracker + demo images
  sync                    Sync local src-go, build artifacts, and optionally restart
  up                      Start remote services (firecracker backend)
  down                    Stop remote services
  restart                 Restart remote services
  status                  Show remote process/health status
  smoke                   Run remote smoke flow
  task [command]          Run one remote Telegram runtime task command
  logs [service|all]      Tail remote logs
  test                    Run remote go test ./...
  admin-token [action]    Manage remote admin token (show|ensure|rotate|path)
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
  NANOCLAW_REMOTE_ADMIN_TOKEN_FILE=$REMOTE_ADMIN_TOKEN_FILE
  NANOCLAW_GO_TASK_RUNTIME=$REMOTE_TASK_RUNTIME
  NANOCLAW_REMOTE_SYNC_AUTO_RESTART=$SYNC_AUTO_RESTART
  NANOCLAW_REMOTE_SYNC_BUILD=$SYNC_BUILD
  NANOCLAW_REMOTE_SYNC_BUILD_GO=$SYNC_BUILD_GO
  NANOCLAW_REMOTE_SYNC_BUILD_FRONTEND=$SYNC_BUILD_FRONTEND
  NANOCLAW_REMOTE_SYNC_FRONTEND_INSTALL=$SYNC_FRONTEND_INSTALL
EOF
}

require_remote_host() {
  if [[ -z "${REMOTE_HOST}" ]]; then
    log_error "NANOCLAW_REMOTE_HOST is required (set it in src-go/.env or your shell)"
    exit 1
  fi
}

remote_exec() {
  require_remote_host
  ssh "$REMOTE_HOST" "$@"
}

remote_admin_token() {
  local action="${1:-show}"
  remote_exec "bash -s -- '$REMOTE_ADMIN_TOKEN_FILE' '$action'" <<'EOF'
set -euo pipefail

token_file="$1"
action="$2"

generate_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return 0
  fi
  # Fallback when openssl is unavailable.
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  printf '\n'
}

ensure_token() {
  mkdir -p "$(dirname "$token_file")"
  if [[ ! -s "$token_file" ]]; then
    generate_token > "$token_file"
    chmod 600 "$token_file"
  fi
}

case "$action" in
  show)
    ensure_token
    tr -d '\r\n' < "$token_file"
    printf '\n'
    ;;
  ensure)
    ensure_token
    printf '%s\n' "$token_file"
    ;;
  rotate)
    mkdir -p "$(dirname "$token_file")"
    generate_token > "$token_file"
    chmod 600 "$token_file"
    tr -d '\r\n' < "$token_file"
    printf '\n'
    ;;
  path)
    printf '%s\n' "$token_file"
    ;;
  *)
    echo "unsupported admin token action: $action" >&2
    exit 1
    ;;
esac
EOF
}

remote_cli_smoke() {
  local subcommand="$1"
  shift || true
  local escaped_args=""
  for arg in "$@"; do
    escaped_args+=" $(printf '%q' "$arg")"
  done
  remote_exec "set -euo pipefail; \
    TOKEN_FILE='$REMOTE_ADMIN_TOKEN_FILE'; \
    mkdir -p \$(dirname \"\$TOKEN_FILE\"); \
    if [ ! -s \"\$TOKEN_FILE\" ]; then \
      if command -v openssl >/dev/null 2>&1; then \
        openssl rand -hex 32 > \"\$TOKEN_FILE\"; \
      else \
        head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > \"\$TOKEN_FILE\"; \
        printf '\\n' >> \"\$TOKEN_FILE\"; \
      fi; \
      chmod 600 \"\$TOKEN_FILE\"; \
    fi; \
    export NANOCLAW_GO_ADMIN_TOKEN=\$(tr -d '\r\n' < \"\$TOKEN_FILE\"); \
    cd '$REMOTE_SRC_GO_DIR'; \
    export NANOCLAW_GO_VM_BACKEND=firecracker; \
    export NANOCLAW_GO_FIRECRACKER_BIN='$REMOTE_FIRECRACKER_BIN'; \
    export NANOCLAW_GO_VM_KERNEL_IMAGE='$REMOTE_KERNEL_IMAGE'; \
    export NANOCLAW_GO_CLI_ROOTFS_IMAGE='$REMOTE_ROOTFS_IMAGE'; \
    export NANOCLAW_GO_VM_NET_MODE='$REMOTE_VM_NET_MODE'; \
    ./scripts/cli-smoke.sh '$subcommand'${escaped_args}"
}

remote_service_pid_snapshot() {
  remote_exec "bash -s" <<'EOF'
set -euo pipefail
for svc in nanoclawd sessiond vm-supervisor; do
  pids="$(pgrep -x "$svc" 2>/dev/null | paste -sd, - || true)"
  if [[ -z "$pids" ]]; then
    pids="none"
  fi
  printf '%s=%s\n' "$svc" "$pids"
done
EOF
}

remote_any_service_running() {
  remote_exec "bash -s" <<'EOF'
set -euo pipefail
for svc in nanoclawd sessiond vm-supervisor; do
  if pgrep -x "$svc" >/dev/null 2>&1; then
    exit 0
  fi
done
exit 1
EOF
}

snapshot_inline() {
  printf '%s\n' "${1:-}" | tr '\n' ';' | sed -e 's/;$//'
}

snapshot_pids_only() {
  printf '%s\n' "${1:-}" | grep -Eo '[0-9]+' | paste -sd' ' - || true
}

remote_alive_pids() {
  local pids="${1:-}"
  if [[ -z "$pids" ]]; then
    echo ""
    return 0
  fi
  remote_exec "bash -s -- $pids" <<'EOF'
set -euo pipefail
alive=()
for pid in "$@"; do
  if kill -0 "$pid" >/dev/null 2>&1; then
    alive+=("$pid")
  fi
done
printf '%s\n' "${alive[*]}"
EOF
}

remote_build_after_sync() {
  if ! is_truthy "$SYNC_BUILD"; then
    log_info "sync build step skipped (NANOCLAW_REMOTE_SYNC_BUILD=$SYNC_BUILD)"
    return 0
  fi
  log_info "sync build step starting: go=$SYNC_BUILD_GO frontend=$SYNC_BUILD_FRONTEND frontend_install=$SYNC_FRONTEND_INSTALL"
  remote_exec "bash -s -- '$REMOTE_SRC_GO_DIR' '$SYNC_BUILD_GO' '$SYNC_BUILD_FRONTEND' '$SYNC_FRONTEND_INSTALL'" <<'EOF'
set -euo pipefail

src_go_dir="$1"
build_go="$2"
build_frontend="$3"
frontend_install="$4"

is_truthy() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

if [[ ! -d "$src_go_dir" ]]; then
  echo "missing src-go dir: $src_go_dir" >&2
  exit 1
fi

if is_truthy "$build_go"; then
  echo "== sync build: go =="
  cd "$src_go_dir"
  command -v go >/dev/null 2>&1 || { echo "missing go on remote" >&2; exit 1; }
  go version
  go build ./cmd/nanoclawd ./cmd/sessiond ./cmd/vm-supervisor
fi

if is_truthy "$build_frontend"; then
  echo "== sync build: frontend =="
  admin_dir="$src_go_dir/web/admin"
  if [[ ! -d "$admin_dir" ]]; then
    echo "missing admin frontend dir: $admin_dir" >&2
    exit 1
  fi
  cd "$admin_dir"

  if command -v bun >/dev/null 2>&1; then
    echo "frontend package manager=bun"
    if is_truthy "$frontend_install"; then
      bun install --frozen-lockfile
    fi
    bun run build
  elif command -v npm >/dev/null 2>&1; then
    echo "frontend package manager=npm"
    if is_truthy "$frontend_install"; then
      npm install
    fi
    npm run build
  else
    echo "missing bun/npm on remote; cannot build frontend" >&2
    exit 1
  fi

  if [[ ! -f "$admin_dir/dist/index.html" ]]; then
    echo "frontend build did not produce dist/index.html" >&2
    exit 1
  fi
  ls -lh "$admin_dir/dist/index.html"
fi
EOF
  log_info "sync build step complete"
}

cmd_info() {
  cat <<EOF
Resolved configuration:
  ENV_FILE=$ENV_FILE
  NANOCLAW_REMOTE_HOST=${REMOTE_HOST:-<required>}
  NANOCLAW_REMOTE_WORKDIR=$REMOTE_WORKDIR
  NANOCLAW_REMOTE_SRC_GO_DIR=$REMOTE_SRC_GO_DIR
  NANOCLAW_REMOTE_FIRECRACKER_BIN=$REMOTE_FIRECRACKER_BIN
  NANOCLAW_REMOTE_KERNEL_IMAGE=$REMOTE_KERNEL_IMAGE
  NANOCLAW_REMOTE_ROOTFS_IMAGE=$REMOTE_ROOTFS_IMAGE
  NANOCLAW_REMOTE_VM_NET_MODE=$REMOTE_VM_NET_MODE
  NANOCLAW_REMOTE_ADMIN_TOKEN_FILE=$REMOTE_ADMIN_TOKEN_FILE
  NANOCLAW_GO_TASK_RUNTIME=$REMOTE_TASK_RUNTIME
  NANOCLAW_REMOTE_SYNC_AUTO_RESTART=$SYNC_AUTO_RESTART
  NANOCLAW_REMOTE_SYNC_BUILD=$SYNC_BUILD
  NANOCLAW_REMOTE_SYNC_BUILD_GO=$SYNC_BUILD_GO
  NANOCLAW_REMOTE_SYNC_BUILD_FRONTEND=$SYNC_BUILD_FRONTEND
  NANOCLAW_REMOTE_SYNC_FRONTEND_INSTALL=$SYNC_FRONTEND_INSTALL
EOF
}

cmd_doctor() {
  log_info "running doctor on ${REMOTE_HOST:-<unset>}"
  remote_exec "bash -s -- '$REMOTE_SRC_GO_DIR' '$REMOTE_FIRECRACKER_BIN' '$REMOTE_KERNEL_IMAGE' '$REMOTE_ROOTFS_IMAGE' '$REMOTE_ADMIN_TOKEN_FILE' '$REMOTE_VM_NET_MODE'" <<'EOF'
set -euo pipefail

src_go_dir="$1"
firecracker_bin="$2"
kernel_image="$3"
rootfs_image="$4"
admin_token_file="$5"
vm_net_mode="$6"

echo "== host =="
hostname
date -u
uname -a
echo

echo "== os =="
cat /etc/os-release || true
echo

echo "== paths =="
echo "src_go_dir=$src_go_dir"
echo "firecracker_bin=$firecracker_bin"
echo "kernel_image=$kernel_image"
echo "rootfs_image=$rootfs_image"
echo "admin_token_file=$admin_token_file"
echo "vm_net_mode=$vm_net_mode"
echo

echo "== prerequisites =="
echo "-- kvm --"
ls -l /dev/kvm || true
echo "-- go --"
command -v go || true
go version || true
echo "-- git --"
command -v git || true
git --version || true
echo "-- firecracker --"
if [[ -x "$firecracker_bin" ]]; then
  "$firecracker_bin" --version
else
  echo "missing executable: $firecracker_bin"
fi
echo

echo "== frontend toolchain =="
echo "-- bun --"
command -v bun || true
bun --version 2>/dev/null || true
echo "-- node --"
command -v node || true
node --version 2>/dev/null || true
echo "-- npm --"
command -v npm || true
npm --version 2>/dev/null || true
echo

echo "== image files =="
ls -lh "$kernel_image" || true
ls -lh "$rootfs_image" || true
echo

echo "== admin token file =="
if [[ -s "$admin_token_file" ]]; then
  stat -c '%A %U:%G %s %n' "$admin_token_file" 2>/dev/null || ls -lh "$admin_token_file"
  token_len="$(tr -d '\r\n' < "$admin_token_file" | wc -c | tr -d ' ')"
  echo "token_len=$token_len"
else
  echo "missing or empty: $admin_token_file"
fi
echo

echo "== src-go state =="
if [[ -d "$src_go_dir" ]]; then
  ls -la "$src_go_dir" | sed -n '1,40p'
  if command -v git >/dev/null 2>&1; then
    git -C "$src_go_dir" rev-parse --short HEAD 2>/dev/null || true
    git -C "$src_go_dir" status --short 2>/dev/null | sed -n '1,40p' || true
  fi
else
  echo "missing directory: $src_go_dir"
fi
echo

echo "== admin dist state =="
admin_dist="$src_go_dir/web/admin/dist"
if [[ -d "$admin_dist" ]]; then
  ls -lah "$admin_dist" | sed -n '1,40p'
  if [[ -f "$admin_dist/index.html" ]]; then
    stat -c 'index.html mtime=%y size=%s path=%n' "$admin_dist/index.html" 2>/dev/null || true
  else
    echo "missing: $admin_dist/index.html"
  fi
else
  echo "missing directory: $admin_dist"
fi
echo

echo "== pid files =="
pid_dir="$src_go_dir/.tmp/cli-smoke/pids"
for svc in nanoclawd sessiond vm-supervisor; do
  pid_file="$pid_dir/$svc.pid"
  if [[ -f "$pid_file" ]]; then
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    alive="no"
    cmd=""
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      alive="yes"
      cmd="$(ps -p "$pid" -o args= 2>/dev/null || true)"
    fi
    echo "$svc pid_file=$pid_file pid=${pid:-<empty>} alive=$alive cmd=${cmd:-<none>}"
  else
    echo "$svc pid_file=missing ($pid_file)"
  fi
done
echo

echo "== processes =="
ps -eo pid,ppid,lstart,args | grep -E 'nanoclawd|sessiond|vm-supervisor|go run ./cmd' | grep -v grep || true
echo

echo "== listeners (18088/18089/18090) =="
if command -v ss >/dev/null 2>&1; then
  ss -ltnp | grep -E ':(18088|18089|18090)[[:space:]]' || true
elif command -v lsof >/dev/null 2>&1; then
  lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(18088|18089|18090)' || true
else
  echo "neither ss nor lsof found"
fi
echo

echo "== local endpoint checks =="
for url in \
  "http://127.0.0.1:18088/healthz" \
  "http://127.0.0.1:18088/admin" \
  "http://127.0.0.1:18088/admin/login" \
  "http://127.0.0.1:18089/healthz" \
  "http://127.0.0.1:18090/healthz"
do
  status="$(curl -sS -o /tmp/remote-firecracker-doctor.body -w '%{http_code}' "$url" || true)"
  echo "$url status=$status"
done
echo

echo "== nanoclawd env snapshot =="
nanoclawd_pid="$(pgrep -x nanoclawd | head -n1 || true)"
if [[ -n "$nanoclawd_pid" ]] && [[ -r "/proc/$nanoclawd_pid/environ" ]]; then
  tr '\0' '\n' < "/proc/$nanoclawd_pid/environ" \
    | awk -F= '
      $1 ~ /^NANOCLAW_GO_(API|SESSION|SUPERVISOR|VM|STATE|ADMIN|WEB)/ {
        if ($1 == "NANOCLAW_GO_ADMIN_TOKEN") {
          printf "%s=<redacted len=%d>\n", $1, length($2)
        } else {
          print
        }
      }
    ' || true
else
  echo "nanoclawd process/env not available"
fi
echo

echo "== cli-smoke status =="
if [[ -x "$src_go_dir/scripts/cli-smoke.sh" ]]; then
  (
    set +e
    export NANOCLAW_GO_VM_BACKEND=firecracker
    export NANOCLAW_GO_FIRECRACKER_BIN="$firecracker_bin"
    export NANOCLAW_GO_VM_KERNEL_IMAGE="$kernel_image"
    export NANOCLAW_GO_CLI_ROOTFS_IMAGE="$rootfs_image"
    export NANOCLAW_GO_VM_NET_MODE="$vm_net_mode"
    if [[ -s "$admin_token_file" ]]; then
      export NANOCLAW_GO_ADMIN_TOKEN="$(tr -d '\r\n' < "$admin_token_file")"
    fi
    cd "$src_go_dir"
    ./scripts/cli-smoke.sh status || true
  )
else
  echo "missing: $src_go_dir/scripts/cli-smoke.sh"
fi
echo

echo "== recent logs =="
for svc in nanoclawd sessiond vm-supervisor; do
  log_file="$src_go_dir/.tmp/cli-smoke/logs/$svc.log"
  echo "-- $log_file --"
  if [[ -f "$log_file" ]]; then
    tail -n 20 "$log_file"
  else
    echo "missing"
  fi
done
EOF
}

cmd_setup() {
  require_cmd ssh
  require_remote_host
  log_info "running setup on $REMOTE_HOST"
  remote_exec "bash -s -- '$REMOTE_FIRECRACKER_BIN' '$REMOTE_KERNEL_IMAGE' '$REMOTE_ROOTFS_IMAGE'" <<'EOF'
set -euo pipefail

firecracker_bin="$1"
kernel_image="$2"
rootfs_image="$3"

export DEBIAN_FRONTEND=noninteractive

run_apt_with_retry() {
  local log_file="$1"
  shift
  local attempt=1
  while true; do
    if "$@" >"$log_file" 2>&1; then
      return 0
    fi
    local status=$?
    if [[ "$status" -ne 100 ]]; then
      cat "$log_file" >&2 || true
      return "$status"
    fi
    if [[ "$attempt" -ge 30 ]]; then
      cat "$log_file" >&2 || true
      return "$status"
    fi
    echo "apt locked, retrying in 2s (attempt $attempt/30)" >&2
    attempt=$((attempt + 1))
    sleep 2
  done
}

run_apt_with_retry /tmp/nanoclaw-remote-apt-update.log apt-get update -y
run_apt_with_retry /tmp/nanoclaw-remote-apt-install.log apt-get install -y curl jq git golang-go nodejs npm ca-certificates unzip

# Install Bun if unavailable (official installer provided by bun.sh).
if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
fi
if [[ -x "$HOME/.bun/bin/bun" ]]; then
  export PATH="$HOME/.bun/bin:$PATH"
  ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun || true
fi

mkdir -p "$(dirname "$firecracker_bin")" "$(dirname "$kernel_image")"
if [[ ! -x "$firecracker_bin" ]]; then
  arch="$(uname -m)"
  rel="$(curl -fsSLI -o /dev/null -w %{url_effective} https://github.com/firecracker-microvm/firecracker/releases/latest | xargs basename)"
  curl -fL "https://github.com/firecracker-microvm/firecracker/releases/download/${rel}/firecracker-${rel}-${arch}.tgz" -o /tmp/firecracker.tgz
  tar -xzf /tmp/firecracker.tgz -C /tmp
  cp "/tmp/release-${rel}-${arch}/firecracker-${rel}-${arch}" "$firecracker_bin"
  chmod +x "$firecracker_bin"
fi
if [[ ! -f "$kernel_image" ]]; then
  curl -fL "https://s3.amazonaws.com/spec.ccfc.min/img/quickstart_guide/$(uname -m)/kernels/vmlinux.bin" -o "$kernel_image"
fi
if [[ ! -f "$rootfs_image" ]]; then
  curl -fL "https://s3.amazonaws.com/spec.ccfc.min/img/quickstart_guide/$(uname -m)/rootfs/bionic.rootfs.ext4" -o "$rootfs_image"
fi

echo "setup complete"
go version
"$firecracker_bin" --version
bun --version || true
node --version || true
npm --version || true
EOF
}

cmd_sync() {
  require_cmd ssh
  require_cmd tar
  require_remote_host
  log_info "sync start: local=$LOCAL_SRC_GO_DIR remote=$REMOTE_HOST:$REMOTE_SRC_GO_DIR"
  supports_tar_flag() {
    local flag="$1"
    tar "$flag" -cf /dev/null --files-from /dev/null >/dev/null 2>&1
  }
  local -a tar_cmd=(tar)
  if supports_tar_flag "--no-mac-metadata"; then
    tar_cmd+=(--no-mac-metadata)
  fi
  if supports_tar_flag "--disable-copyfile"; then
    tar_cmd+=(--disable-copyfile)
  fi
  if supports_tar_flag "--no-xattrs"; then
    tar_cmd+=(--no-xattrs)
  fi
  tar_cmd+=(-C "$LOCAL_SRC_GO_DIR/.." -czf - src-go)
  log_info "sync tar options: ${tar_cmd[*]}"
  COPYFILE_DISABLE=1 COPY_EXTENDED_ATTRIBUTES_DISABLE=1 "${tar_cmd[@]}" \
    | ssh "$REMOTE_HOST" "set -euo pipefail; mkdir -p '$REMOTE_WORKDIR'; rm -rf '$REMOTE_SRC_GO_DIR'; tar -xzf - -C '$REMOTE_WORKDIR'; chmod +x '$REMOTE_SRC_GO_DIR/scripts/cli-smoke.sh'; find '$REMOTE_SRC_GO_DIR' -name '._*' -type f -delete"
  log_info "sync complete: $REMOTE_HOST:$REMOTE_SRC_GO_DIR"
  remote_build_after_sync

  if is_truthy "$SYNC_AUTO_RESTART"; then
    log_info "auto-restart enabled (NANOCLAW_REMOTE_SYNC_AUTO_RESTART=$SYNC_AUTO_RESTART)"
    cmd_restart
    log_info "auto-restart complete"
  else
    log_info "auto-restart skipped (NANOCLAW_REMOTE_SYNC_AUTO_RESTART=$SYNC_AUTO_RESTART)"
  fi
}

cmd_up() {
  log_info "starting remote services"
  remote_cli_smoke up
  log_info "remote services started"
}

cmd_down() {
  log_info "stopping remote services"
  remote_cli_smoke down
  log_info "remote services stopped"
}

cmd_restart() {
  log_info "restarting remote services"
  local before_snapshot
  before_snapshot="$(remote_service_pid_snapshot)"
  log_info "restart pid snapshot (before): $(snapshot_inline "$before_snapshot")"
  remote_cli_smoke down || true
  remote_cli_smoke up
  local after_snapshot
  after_snapshot="$(remote_service_pid_snapshot)"
  log_info "restart pid snapshot (after): $(snapshot_inline "$after_snapshot")"

  local old_pids
  old_pids="$(snapshot_pids_only "$before_snapshot")"
  if [[ -n "$old_pids" ]]; then
    local lingering
    lingering="$(remote_alive_pids "$old_pids")"
    lingering="$(echo "$lingering" | xargs || true)"
    if [[ -n "$lingering" ]]; then
      log_warn "restart check: old pids still alive after restart: $lingering"
      log_warn "attempting forced cleanup of lingering old pids"
      remote_exec "bash -s -- $lingering" <<'EOF'
set -euo pipefail
for pid in "$@"; do
  kill "$pid" >/dev/null 2>&1 || true
done
sleep 1
for pid in "$@"; do
  kill -9 "$pid" >/dev/null 2>&1 || true
done
EOF
      remote_cli_smoke up
      after_snapshot="$(remote_service_pid_snapshot)"
      log_info "restart pid snapshot (after forced cleanup): $(snapshot_inline "$after_snapshot")"
      local still_lingering
      still_lingering="$(remote_alive_pids "$lingering")"
      still_lingering="$(echo "$still_lingering" | xargs || true)"
      if [[ -n "$still_lingering" ]]; then
        log_error "restart check failed: old pids still alive after forced cleanup: $still_lingering"
        return 1
      fi
    fi
  fi
  log_info "remote services restarted"
}

cmd_status() {
  log_info "collecting remote status"
  remote_cli_smoke status
}

cmd_smoke() {
  log_info "running remote smoke flow"
  remote_cli_smoke smoke
  log_info "remote smoke flow completed"
}

cmd_task() {
  log_info "running remote task command=${1:-telegram-agent --runtime $REMOTE_TASK_RUNTIME --source remote-firecracker}"
  remote_cli_smoke task "${1:-telegram-agent --runtime $REMOTE_TASK_RUNTIME --source remote-firecracker}"
}

cmd_logs() {
  log_info "tailing remote logs service=${1:-all}"
  remote_cli_smoke logs "${1:-all}"
}

cmd_test() {
  log_info "running remote go test ./..."
  remote_exec "set -euo pipefail; cd '$REMOTE_SRC_GO_DIR'; go test ./..."
  log_info "remote go test completed"
}

cmd_admin_token() {
  local action="${1:-show}"
  case "$action" in
    show|ensure|rotate|path) ;;
    *)
      log_error "unsupported admin-token action: $action"
      log_error "supported actions: show, ensure, rotate, path"
      exit 1
      ;;
  esac
  if [[ "$action" == "rotate" ]]; then
    local restart_required=0
    if remote_any_service_running; then
      restart_required=1
    fi
    remote_admin_token "$action"
    if [[ "$restart_required" -eq 1 ]]; then
      log_info "admin token rotated; restarting remote services so the new token is active now"
      cmd_restart
    else
      log_info "admin token rotated; services are not running so restart is skipped"
    fi
    return 0
  fi
  remote_admin_token "$action"
}

cmd_shell() {
  log_info "opening interactive shell to $REMOTE_HOST"
  exec ssh "$REMOTE_HOST"
}

main() {
  local cmd="${1:-help}"
  shift || true

  case "$cmd" in
    info) cmd_info "$@" ;;
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
    admin-token) cmd_admin_token "$@" ;;
    shell) cmd_shell "$@" ;;
    help|-h|--help) usage ;;
    *)
      log_error "unknown command: $cmd"
      usage
      exit 1
      ;;
  esac
}

main "$@"
