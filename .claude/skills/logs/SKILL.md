---
name: logs
description: View NanoClaw logs on macOS/Linux. Supports file logs and Linux systemd journal logs.
---

# View NanoClaw Logs

## Default file logs

```bash
tail -50 logs/nanoclaw.log
tail -50 logs/nanoclaw.error.log
```

## Follow live logs

```bash
tail -f logs/nanoclaw.log
```

## Search logs

```bash
grep -i "<search term>" logs/nanoclaw.log | tail -30
```

## Linux systemd logs

Use this when deployed with `bun run deploy:linux`:

```bash
journalctl --user -u com.nanoclaw.service -n 100 --no-pager
```

Follow live journal logs:

```bash
journalctl --user -u com.nanoclaw.service -f
```

## Service checks

macOS:

```bash
launchctl list | grep com.nanoclaw
```

Linux:

```bash
systemctl --user status com.nanoclaw.service --no-pager
```
