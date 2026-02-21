---
name: remote-admin-token
description: Manage NanoClaw Go admin API tokens on a remote host over SSH using src-go/scripts/remote-firecracker.sh. Use when asked to fetch the current admin token, ensure token persistence across remote sync/deploy cycles, rotate a compromised token, or get the remote token file path.
---

# Remote Admin Token

Use the remote Firecracker helper to keep the admin token on the remote host (outside synced `src-go/`) and retrieve it when needed.

## Quick Commands

```bash
cd src-go

# Ensure token file exists and print its remote path
./scripts/remote-firecracker.sh admin-token ensure

# Fetch current token value
./scripts/remote-firecracker.sh admin-token show

# Rotate token and print new value
./scripts/remote-firecracker.sh admin-token rotate

# Print configured remote token file path
./scripts/remote-firecracker.sh admin-token path
```

## Standard Workflow

1. Confirm `src-go/.env` includes `NANOCLAW_REMOTE_HOST`, `NANOCLAW_REMOTE_WORKDIR`, and `NANOCLAW_REMOTE_ADMIN_TOKEN_FILE` (recommended under `NANOCLAW_REMOTE_WORKDIR/.secrets/`).

2. Ensure token exists:

```bash
cd src-go
./scripts/remote-firecracker.sh admin-token ensure
```

3. Fetch token only when required for an authenticated call:

```bash
cd src-go
TOKEN="$(./scripts/remote-firecracker.sh admin-token show)"
```

4. Use token for protected endpoints:

```bash
curl -H "Authorization: Bearer ${TOKEN}" http://127.0.0.1:8088/admin/config.json
```

5. Rotate token immediately if exposed:

```bash
cd src-go
NEW_TOKEN="$(./scripts/remote-firecracker.sh admin-token rotate)"
```

## Notes

- Token persistence is handled remotely via `NANOCLAW_REMOTE_ADMIN_TOKEN_FILE`, so it survives repeated `sync` operations.
- `up`, `status`, `task`, and related remote helper flows automatically load/export the remote token.
- Avoid pasting token values into chat logs unless explicitly requested.
