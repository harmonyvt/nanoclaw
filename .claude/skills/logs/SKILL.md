---
name: logs
description: View NanoClaw service logs. Shows recent output, errors, or follows live logs. Use when user says "logs", "show logs", "check logs", "what happened", or "tail logs".
---

# View NanoClaw Logs

Log files are in the project `logs/` directory:

| File | Contents |
|------|----------|
| `logs/nanoclaw.log` | Stdout — all pino-formatted application logs |
| `logs/nanoclaw.error.log` | Stderr — crashes, unhandled errors |

## Default: Show Recent Logs

Show the last 50 lines of the main log:

```bash
tail -50 logs/nanoclaw.log
```

If the user asks about errors specifically, show the error log:

```bash
tail -50 logs/nanoclaw.error.log
```

## Follow Live Logs

If the user says "follow", "watch", or "live":

```bash
tail -f logs/nanoclaw.log
```

Note: this blocks — let the user know they can Ctrl+C to stop.

## Search Logs

If the user asks about a specific event, grep for it:

```bash
grep -i "<search term>" logs/nanoclaw.log | tail -30
```

## Common Patterns

- **Startup issues:** Look for early errors in `logs/nanoclaw.error.log`
- **Telegram connection:** `grep -i telegram logs/nanoclaw.log | tail -20`
- **Container runs:** `grep -i container logs/nanoclaw.log | tail -20`
- **Scheduler:** `grep -i scheduler logs/nanoclaw.log | tail -20`
- **Check if service is running:** `launchctl list | grep com.nanoclaw`

## Log Rotation

If logs are very large, the user may want to rotate them:

```bash
> logs/nanoclaw.log
> logs/nanoclaw.error.log
```

Then restart the service with `/restart` to begin fresh logging.
