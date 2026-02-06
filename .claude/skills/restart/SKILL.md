---
name: restart
description: Restart the NanoClaw background service. Unloads and reloads the launchd plist. Use when user says "restart", "restart service", "reload", or "bounce the service".
---

# Restart NanoClaw Service

## 1. Check Current Status

```bash
launchctl list | grep com.nanoclaw
```

If the service is not loaded, skip the unload step.

## 2. Rebuild (if needed)

If there are uncommitted TypeScript changes or the user just made code changes, build first:

```bash
bun run build
```

Only rebuild if source files changed since the last build. Check with:

```bash
ls -lt src/*.ts dist/index.js 2>/dev/null | head -5
```

## 3. Restart

```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

## 4. Verify

Wait a couple seconds, then confirm it's running:

```bash
sleep 2
launchctl list | grep com.nanoclaw
```

A `0` exit status in the output means it's running. A non-zero status or missing entry means it failed to start — check logs with `/logs`.

Report the result to the user.
