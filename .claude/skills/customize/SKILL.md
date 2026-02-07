---
name: customize
description: Add new capabilities or modify NanoClaw behavior. Use when user wants to add channels/integrations, change triggers/persona/tools, or adjust deployment/runtime behavior across macOS/Linux.
---

# NanoClaw Customization

Use AskUserQuestion for ambiguous product decisions. Then implement directly in code.

## Workflow

1. Understand exactly what changes are desired.
2. Confirm platform/deployment constraints (macOS launchd vs Linux systemd).
3. Implement minimal, testable code changes.
4. Build and verify.
5. If runtime/deploy behavior changed, redeploy service.

## Key Files

| File                      | Purpose                                               |
| ------------------------- | ----------------------------------------------------- |
| `src/config.ts`           | Runtime config: triggers, Docker/CUA sandbox env vars |
| `src/index.ts`            | Message routing, startup checks, IPC processing       |
| `src/container-runner.ts` | Agent container lifecycle and mounts                  |
| `src/browse-host.ts`      | CUA browser action bridge                             |
| `src/sandbox-manager.ts`  | CUA sandbox lifecycle                                 |
| `src/db.ts`               | Persistent state (messages/tasks/chats)               |
| `groups/*/CLAUDE.md`      | Persona/memory behavior by group                      |
| `scripts/*.sh`            | Deployment and Docker prerequisite automation         |

## Common Customizations

### Behavior and Trigger Changes

- Trigger/name: update `.env` (`ASSISTANT_NAME`) and/or group memory files.
- Response behavior/persona: update `groups/main/CLAUDE.md` and `groups/global/CLAUDE.md`.

### New Integrations/Tools

- Add tool wiring in `container/agent-runner/src/ipc-mcp.ts`.
- Add host processing in `src/index.ts` or dedicated modules.
- Keep authorization boundaries between main vs non-main groups.

### Sandbox/Browser Changes (CUA)

- Keep actions in `src/browse-host.ts` command-based (`/cmd`).
- Preserve screenshot feedback path to Telegram.
- Ensure `wait_for_user` always sends a usable noVNC URL.
- Keep `browse_evaluate` explicitly unsupported unless you also add safe JS-eval support in the CUA bridge.

### Deployment/Runtime Changes

Questions to ask:

- Which OS targets are required? (macOS, Linux, both)
- Service mode? (launchd, systemd user service, foreground)
- Any restricted environment assumptions? (headless server, no Tailscale, custom Docker registry)

Implement with:

- `scripts/ensure-docker-requirements.sh`
- `scripts/deploy-launchd.sh`
- `scripts/deploy-systemd.sh`

## Verification Checklist

```bash
bun run build
bun test
```

If deploy/runtime impacted:

```bash
bun run docker:requirements
# macOS:
bun run deploy:macos
# Linux:
bun run deploy:linux
```

Then verify:

- Service is active
- Telegram message flow works
- At least one browse screenshot roundtrip works

## Safety Notes

- Do not hardcode platform-specific paths when cross-platform behavior is required.
- Prefer environment variables over magic constants for deploy/runtime details.
- Keep Docker and CUA assumptions explicit in docs/skills when changed.
