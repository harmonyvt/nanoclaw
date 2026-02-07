---
name: debug
description: Debug NanoClaw runtime issues across Docker containers, CUA sandbox automation, and service deployments on macOS/Linux.
---

# NanoClaw Debugging (Docker + CUA)

## Architecture Snapshot

- Host process: `src/index.ts`
- Agent runtime: Docker containers from `nanoclaw-agent:latest`
- Browser runtime: CUA sandbox container (`trycua/cua-sandbox:latest`)
- Service managers:
  - macOS: launchd (`com.nanoclaw`)
  - Linux: systemd user service (`com.nanoclaw.service`)

## 1. Fast Health Check

```bash
bun run docker:requirements
```

This catches most install/runtime prerequisites quickly.

## 2. Service Status

### macOS

```bash
launchctl list | grep com.nanoclaw
```

### Linux

```bash
systemctl --user status com.nanoclaw.service --no-pager
```

## 3. Host Logs

### File logs (works for launchd and foreground runs)

```bash
tail -100 logs/nanoclaw.log
tail -100 logs/nanoclaw.error.log
```

### Linux systemd journal

```bash
journalctl --user -u com.nanoclaw.service -n 100 --no-pager
```

## 4. Agent Container Debugging

```bash
# Active agent containers
docker ps --filter "ancestor=nanoclaw-agent:latest"

# Recent per-run logs
ls -t groups/*/logs/container-*.log | head -5
```

If image missing:

```bash
./container/build.sh
```

## 5. CUA Sandbox Debugging

```bash
# Is CUA sandbox container running?
docker ps --filter "name=nanoclaw-cua-sandbox"

# Is CUA command server reachable?
curl -sf http://localhost:8000/ >/dev/null && echo "CUA API OK" || echo "CUA API NOT REACHABLE"

# View sandbox logs
docker logs --tail 100 nanoclaw-cua-sandbox
```

If needed, restart sandbox:

```bash
docker stop nanoclaw-cua-sandbox 2>/dev/null || true
docker rm nanoclaw-cua-sandbox 2>/dev/null || true
# It will auto-start on next browse action
```

If image missing:

```bash
docker pull trycua/cua-sandbox:latest
```

## 6. Common Failure Patterns

### Docker daemon unavailable

Symptoms:

- startup fails before Telegram loop
- `docker info` errors

Fix:

- Start Docker Desktop (macOS) or docker daemon (Linux)
- rerun `bun run docker:requirements`

### Agent image missing

Symptoms:

- startup error: missing `nanoclaw-agent:latest`

Fix:

```bash
./container/build.sh
```

### CUA sandbox not responding

Symptoms:

- browse tools timeout/fail
- no screenshot delivery

Fix:

1. Check container status/logs.
2. Pull latest image.
3. Retry browse action.

### Telegram no-response

Check:

- `.env` has `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_ID`
- `data/registered_groups.json` has active chat
- host logs for routing errors

## 7. Rebuild + Redeploy

After code changes that affect runtime:

```bash
bun run build
```

macOS:

```bash
bun run deploy:macos
```

Linux:

```bash
bun run deploy:linux
```
