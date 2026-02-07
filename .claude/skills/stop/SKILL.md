---
name: stop
description: Stop NanoClaw background service without removing it. Use when user asks to stop, halt, or shut down the service. Can be restarted later with /restart or /deploy.
---

# Stop NanoClaw Service

## macOS (launchd)

```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist 2>/dev/null || true
sleep 1
launchctl list | grep com.nanoclaw
```

If `launchctl list` returns nothing, the service is stopped.

## Linux (systemd user service)

```bash
systemctl --user stop com.nanoclaw.service
sleep 1
systemctl --user status com.nanoclaw.service --no-pager
```

## Report status

- Stopped: confirm success. Note the service will **not** auto-start on next login since `launchctl unload` deregisters it (macOS) / `stop` leaves it enabled but inactive (Linux).
- To restart later: use `/restart` or `/deploy`.
- To permanently remove the service: use `/remove`.
