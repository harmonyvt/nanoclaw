---
name: dev-v2-sim-runner
description: Run NanoClaw v2 locally in terminal simulation mode (no Telegram), send interactive test messages, and verify end-to-end routing through GroupCoordinator and container runner.
---

# Run NanoClaw v2 in Simulation Mode

Use this when you want to run v2 yourself without Telegram.

## 1. Preflight

Ensure dependencies and required env are present:

```bash
bun install
```

```bash
[ -f .env ] || cp .env.example .env
```

```bash
grep -E '^TELEGRAM_OWNER_ID=' .env || echo 'TELEGRAM_OWNER_ID='
```

If `TELEGRAM_OWNER_ID` is empty, set it in `.env` (any numeric value is fine for local sim).

## 2. Start v2 Sim Runtime

```bash
bun run dev:v2:sim
```

Expected startup signals:

- `Local simulation mode enabled`
- `Starting message router...`
- `[sim] Telegram simulation mode enabled`
- prompt: `you>`

## 3. Use the Terminal Chat

At the `you>` prompt:

- Type plain text to send a user message.
- `/help` shows simulator commands.
- `/chat <id|jid>` switches active chat.
- `/name <sender>` changes simulated sender display name.
- `/exit` performs graceful shutdown.

## 4. Confirm End-to-End Behavior

After sending a test message, verify you see:

- auto-registration of owner chat to `main` (first run)
- coordinator started for group
- `Running container`
- assistant output printed as `[assistant:telegram:...] ...`

If assistant output does not arrive, switch to `dev-v2-triage`.

