---
name: deploy
description: Deploy NanoClaw as a background service with Docker prerequisites validated. Use when user asks to deploy, install service, set up launchd/systemd, or make production startup reliable.
---

# Deploy NanoClaw

Use platform-specific deployment scripts. Always validate Docker requirements first.

## 1. Prerequisites

```bash
bun run docker:requirements
```

This validates:

- Docker CLI installed
- Docker daemon running
- Agent image exists (`CONTAINER_IMAGE`)
- CUA sandbox image exists/pulled (`CUA_SANDBOX_IMAGE`)

## 2. Build

```bash
bun run build
```

## 3. Deploy by Platform

### macOS (launchd)

```bash
bun run deploy:macos
```

What it does:

- Renders `launchd/com.nanoclaw.plist` with absolute paths
- Reloads `~/Library/LaunchAgents/com.nanoclaw.plist`
- Leaves logs in `logs/nanoclaw.log` and `logs/nanoclaw.error.log`

Verify:

```bash
launchctl list | grep com.nanoclaw
```

### Linux (systemd user service)

```bash
bun run deploy:linux
```

What it does:

- Renders `systemd/com.nanoclaw.service` to `~/.config/systemd/user/com.nanoclaw.service`
- Runs `systemctl --user daemon-reload`
- Enables/starts `com.nanoclaw.service`

Verify:

```bash
systemctl --user status com.nanoclaw.service --no-pager
```

## 4. Post-deploy Checks

1. Confirm service is running.
2. Confirm Telegram bot responds in your main chat.
3. Trigger a browse task and confirm screenshot roundtrip.

## 5. Troubleshooting

- Docker daemon down: start Docker and rerun deploy.
- Missing agent image: run `./container/build.sh`.
- Missing CUA image: run `docker pull trycua/cua-sandbox:latest`.
- Linux user service not starting: inspect journal logs and ensure user systemd is active.

Linux logs:

```bash
journalctl --user -u com.nanoclaw.service -n 100 --no-pager
```
