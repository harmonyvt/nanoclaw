# Remote Firecracker Workflow

This guide describes how to run `src-go` against a remote Linux host with KVM
using the helper script:

- `scripts/remote-firecracker.sh`

It covers:

1. one-time setup
2. syncing local code to remote
3. running/debugging services remotely from local CLI
4. troubleshooting

## Prerequisites

Local machine:

- `ssh`
- `tar`
- network access to remote host over SSH

Remote machine:

- Linux host with `/dev/kvm` available
- root access (or equivalent privileges for setup/install steps)

## 1) Configure local `.env`

From `src-go`:

```bash
cp .env.example .env
```

Or use the interactive quickstart:

```bash
./scripts/remote-firecracker-quickstart.sh
```

Edit `.env` and set at least:

- `NANOCLAW_REMOTE_HOST` (required, for example `root@your-host`)
- `NANOCLAW_REMOTE_WORKDIR` (default `/root/nanoclaw-buffalo`)
- `NANOCLAW_REMOTE_FIRECRACKER_BIN`
- `NANOCLAW_REMOTE_KERNEL_IMAGE`
- `NANOCLAW_REMOTE_ROOTFS_IMAGE`

Notes:

- `src-go/.env` is gitignored (`.gitignore` includes `.env` and `src-go/.env`).
- `.env.example` is safe to commit; `.env` is local-only.

## 2) One-time remote setup

Run from local machine:

```bash
cd src-go
./scripts/remote-firecracker.sh doctor
./scripts/remote-firecracker.sh setup
```

What `setup` does:

- installs remote dependencies (`curl`, `jq`, `git`, `go`)
- downloads latest Firecracker release binary if missing
- downloads demo kernel/rootfs images if missing

## 3) Sync code to remote

```bash
cd src-go
./scripts/remote-firecracker.sh sync
```

This pushes local `src-go` to remote `NANOCLAW_REMOTE_SRC_GO_DIR`.

## 4) Operate services remotely

Start/inspect:

```bash
cd src-go
./scripts/remote-firecracker.sh up
./scripts/remote-firecracker.sh status
./scripts/remote-firecracker.sh logs nanoclawd
```

Run smoke validation:

```bash
cd src-go
./scripts/remote-firecracker.sh smoke
```

Stop:

```bash
cd src-go
./scripts/remote-firecracker.sh down
```

Extra helpers:

```bash
./scripts/remote-firecracker.sh task "echo hello"
./scripts/remote-firecracker.sh test
./scripts/remote-firecracker.sh shell
```

## Typical development loop

```bash
cd src-go
./scripts/remote-firecracker.sh sync
./scripts/remote-firecracker.sh restart
./scripts/remote-firecracker.sh smoke
```

## Troubleshooting

`NANOCLAW_REMOTE_HOST is required`

- set `NANOCLAW_REMOTE_HOST` in `src-go/.env`

`ssh: connect ... Operation not permitted`

- verify local network/firewall/SSH routing
- confirm host/port and SSH key access manually:
  - `ssh <user>@<host>`

`/dev/kvm` missing or inaccessible

- remote host is not KVM-ready (or permission issue)
- validate with:
  - `ls -l /dev/kvm`
  - `groups`

`Boot source error: kernel file cannot be opened`

- verify `NANOCLAW_REMOTE_KERNEL_IMAGE` points to an existing file on remote
- run `./scripts/remote-firecracker.sh doctor` to confirm paths

Snapshot error while running microVM

- some hosts/configs do not allow live snapshot in current mode
- stop first, then snapshot (helper flow already does this in supervisor lifecycle)
