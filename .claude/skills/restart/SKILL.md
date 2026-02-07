---
name: restart
description: Restart NanoClaw background service on macOS (launchd) or Linux (systemd user service). Use when user asks to restart/reload/bounce the service.
---

# Restart NanoClaw Service

## 1. Build if code changed

```bash
bun run build
```

## 2. Restart by platform

### macOS (launchd)

```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
sleep 2
launchctl list | grep com.nanoclaw
```

### Linux (systemd user service)

```bash
systemctl --user restart com.nanoclaw.service
sleep 2
systemctl --user status com.nanoclaw.service --no-pager
```

## 3. If Linux service missing

Deploy it first:

```bash
bun run deploy:linux
```

## 4. Report status

- Running: confirm success
- Failed: show relevant logs and next fix
  - macOS: `tail -100 logs/nanoclaw.error.log`
  - Linux: `journalctl --user -u com.nanoclaw.service -n 100 --no-pager`
