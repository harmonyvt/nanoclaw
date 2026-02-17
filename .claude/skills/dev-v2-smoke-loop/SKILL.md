---
name: dev-v2-smoke-loop
description: Run a fast repeatable smoke-test loop for NanoClaw v2 using simulation mode, including startup check, one-message interaction, and clean shutdown.
---

# NanoClaw v2 Smoke Loop

Use this for quick confidence checks after code changes.

## 1. Fast Validation

```bash
bun test src-v2/__tests__/dev-smoke.test.ts
```

## 2. Launch Sim Runtime

```bash
bun run dev:v2:sim
```

Wait for the `you>` prompt.

## 3. Send One Real Message

Type:

```text
hello from smoke loop
```

Verify in output:

- group processing log from `GroupCoordinator`
- container run start log
- status message(s)
- assistant response line

## 4. Shutdown Cleanly

Type:

```text
/exit
```

Verify shutdown logs include:

- signal received
- graceful cleanup message
- clean shutdown complete

## 5. If Smoke Fails

Run `dev-v2-triage` immediately and capture:

- first fatal/error line
- last 100 runtime lines
- whether failure happened before or after `Starting message router...`

