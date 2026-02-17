---
name: dev-v2-triage
description: Triage NanoClaw v2 runtime failures in dev/sim mode by checking Docker health, image availability, startup logs, IPC state, and persistent container behavior.
---

# NanoClaw v2 Triage

Use this when `bun run dev:v2` or `bun run dev:v2:sim` fails, hangs, or returns no assistant reply.

## 1. Prerequisites

```bash
bun run docker:requirements
```

If this fails, fix Docker first.

## 2. Build + Targeted Checks

```bash
bun run build:v2
```

```bash
bun test src-v2/__tests__/dev-smoke.test.ts
```

```bash
bun run typecheck:v2
```

Note: if typecheck fails only in known unrelated files, treat as baseline noise and continue runtime triage.

## 3. Runtime Startup Signals

Start sim mode:

```bash
bun run dev:v2:sim
```

Confirm this sequence appears:

1. `Docker is running`
2. `Agent image ready`
3. `Scheduler started`
4. `IPC watcher started`
5. `Starting message router...`

If it stops before this, capture the first fatal line and fix that layer dependency first.

## 4. Container + IPC Inspection

In another shell:

```bash
docker ps --filter "label=com.nanoclaw.role=agent"
```

```bash
find data/ipc -maxdepth 3 -type f | sort
```

For a target group (usually `main`), check:

- heartbeat file exists: `data/ipc/main/agent-heartbeat`
- rpc socket appears when persistent container is ready: `data/ipc/main/agent.sock`

## 5. Logs for Common Failure Modes

Look for these patterns in live output:

- `Persistent mode failed, falling back to one-shot`
- `Persistent transport failed, falling back to one-shot`
- timeout messages
- credential/env write errors

Then decide:

- one-shot fallback but successful output: degraded but functional
- repeated fallback + no output: inspect IPC/socket lifecycle and container logs

## 6. Hard Reset of Agent Containers (Safe Cleanup)

```bash
docker ps -q --filter "label=com.nanoclaw.role=agent" | xargs -r docker rm -f
```

Then rerun `bun run dev:v2:sim` and retest.

