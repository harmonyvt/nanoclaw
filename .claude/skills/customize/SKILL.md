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

### Host Process

| File                      | Purpose                                                           |
| ------------------------- | ----------------------------------------------------------------- |
| `src/config.ts`           | Runtime config: triggers, Docker/CUA sandbox env vars, provider defaults |
| `src/index.ts`            | Message routing, startup checks, IPC processing, provider resolution |
| `src/container-runner.ts` | Agent container lifecycle, mounts, passes provider/model to container |
| `src/types.ts`            | Shared interfaces including `ProviderConfig`, `RegisteredGroup`   |
| `src/browse-host.ts`      | CUA browser action bridge                                         |
| `src/sandbox-manager.ts`  | CUA sandbox lifecycle                                             |
| `src/db.ts`               | Persistent state (messages/tasks/chats)                           |
| `groups/*/CLAUDE.md`      | Persona/memory behavior by group                                  |
| `scripts/*.sh`            | Deployment and Docker prerequisite automation                     |

### Agent Container

| File                                                   | Purpose                                                    |
| ------------------------------------------------------ | ---------------------------------------------------------- |
| `container/agent-runner/src/tool-registry.ts`          | Provider-agnostic tool definitions (22 tools, Zod schemas) |
| `container/agent-runner/src/ipc-mcp.ts`                | Thin Claude SDK wrapper mapping tools to MCP server        |
| `container/agent-runner/src/adapters/index.ts`         | `createAdapter()` factory (anthropic/openai dispatch)      |
| `container/agent-runner/src/adapters/claude-adapter.ts`| Claude Agent SDK adapter                                   |
| `container/agent-runner/src/adapters/openai-adapter.ts`| OpenAI chat completions + function calling adapter         |
| `container/agent-runner/src/adapters/openai-tools.ts`  | Zod-to-JSON Schema bridge for OpenAI function calling      |

## Common Customizations

### Behavior and Trigger Changes

- Trigger/name: update `.env` (`ASSISTANT_NAME`) and/or group memory files.
- Response behavior/persona: update `groups/main/CLAUDE.md` and `groups/global/CLAUDE.md`.

### AI Provider/Model Changes

- Global defaults: set `DEFAULT_PROVIDER` and `DEFAULT_MODEL` in `.env` / `src/config.ts`.
- Per-group config: set `providerConfig: { provider, model }` in `data/registered_groups.json` or via the `register_group` tool.
- Anthropic provider: uses Claude Agent SDK with full tool access (Bash, Read, Write, Edit, etc. + IPC tools).
- OpenAI provider: uses chat completions with function calling. IPC tools only (send_message, browse_*, firecrawl_*, memory_*, schedule_task, etc.).
- Adding a new provider: implement `ProviderAdapter` interface in `container/agent-runner/src/adapters/`, register in `createAdapter()` factory.

### New Integrations/Tools

- Add tool definitions in `container/agent-runner/src/tool-registry.ts` (provider-agnostic, Zod schemas).
- The tool is automatically available to both Claude (via `ipc-mcp.ts` MCP wrapper) and OpenAI (via `openai-tools.ts` function calling bridge).
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
