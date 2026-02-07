---
name: remove
description: Fully remove NanoClaw background service from the system. Stops the service and deletes its registration so it won't auto-start. Does not delete project files or data. Use when user asks to remove, uninstall, or deregister the service.
---

# Remove NanoClaw Service

Stops the service and removes its registration file. Project files, data, and Docker images are left intact.

## macOS (launchd)

```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist 2>/dev/null || true
rm -f ~/Library/LaunchAgents/com.nanoclaw.plist
```

Verify removal:

```bash
launchctl list | grep com.nanoclaw
ls ~/Library/LaunchAgents/com.nanoclaw.plist 2>/dev/null && echo "plist still exists" || echo "plist removed"
```

## Linux (systemd user service)

```bash
systemctl --user stop com.nanoclaw.service 2>/dev/null || true
systemctl --user disable com.nanoclaw.service 2>/dev/null || true
rm -f ~/.config/systemd/user/com.nanoclaw.service
systemctl --user daemon-reload
```

Verify removal:

```bash
systemctl --user status com.nanoclaw.service --no-pager 2>&1 | head -5
```

## Report status

- Confirm the service is stopped and the registration file is deleted.
- To reinstall later: use `/deploy`.
