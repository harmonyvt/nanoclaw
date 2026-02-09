# NanoClaw Security Model

## Trust Model

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Main group | Trusted | Private self-chat, admin control |
| Non-main groups | Untrusted | Other users may be malicious |
| Container agents | Sandboxed | Isolated execution environment |
| CUA sandbox | Shared sidecar | Shared browser environment across groups |
| Dashboard | Owner-only | Authenticated via Telegram HMAC |
| Messages | User input | Potential prompt injection |

## Security Boundaries

### 1. Container Isolation (Primary Boundary)

Agents execute in Docker containers, providing:
- **Process isolation** - Container processes cannot affect the host
- **Filesystem isolation** - Only explicitly mounted directories are visible
- **Non-root execution** - Runs as unprivileged `bun` user (uid 1000)
- **Ephemeral containers** - Fresh environment per invocation (`--rm`)

This is the primary security boundary. Rather than relying on application-level permission checks, the attack surface is limited by what's mounted.

**Persistent container mode** reuses a long-lived container per group for lower latency. The same isolation guarantees apply — mounts and user are identical to one-shot mode. Idle containers are cleaned up automatically.

### 2. Mount Security

**External Allowlist** — Mount permissions stored at `~/.config/nanoclaw/mount-allowlist.json`, which is:
- Outside project root
- Never mounted into containers
- Cannot be modified by agents

**Default Blocked Patterns:**
```
.ssh, .gnupg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .bunfig.toml, bunfig.toml, bun.lock, bun.lockb, id_rsa, id_ed25519,
private_key, .secret
```

**Protections:**
- Symlink resolution before validation (prevents traversal attacks)
- Container path validation (rejects `..` and absolute paths)
- `nonMainReadOnly` option forces read-only for non-main groups

### 3. Session Isolation

Each group has isolated sessions at `data/sessions/{group}/.claude/`:
- Groups cannot see other groups' conversation history
- Session data includes full message history and file contents read
- Prevents cross-group information disclosure

OpenAI adapter sessions are stored in the group directory itself (`.openai-sessions/`), also isolated per group.

### 4. IPC Authorization

Messages and task operations are verified against group identity:

| Operation | Main Group | Non-Main Group |
|-----------|------------|----------------|
| Send message to own chat | ✓ | ✓ |
| Send message to other chats | ✓ | ✗ |
| Schedule task for self | ✓ | ✓ |
| Schedule task for others | ✓ | ✗ |
| View all tasks | ✓ | Own only |
| Register new groups | ✓ | ✗ |
| Manage other groups | ✓ | ✗ |

### 5. Credential Handling

**Credential Resolution Chain** (in `container-runner.ts:resolveCredentials()`):

1. `.env` file — looks for `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`
2. macOS Keychain — reads `Claude Code-credentials` via `security find-generic-password`
3. `~/.claude/.credentials.json` — parses `claudeAiOauth.accessToken`

OAuth tokens are automatically refreshed before expiry using the stored `refreshToken`.

**Mounted Credentials:**
- AI auth token (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`) — written to `data/env/env`, mounted read-only
- Integration API keys from `.env`: `OPENAI_API_KEY`, `FIRECRAWL_API_KEY`, `SUPERMEMORY_API_KEY`, `SUPERMEMORY_OPENCLAW_API_KEY`, `SUPERMEMORY_CC_API_KEY`

**NOT Mounted:**
- Mount allowlist (`~/.config/nanoclaw/mount-allowlist.json`) — external, never mounted
- `FREYA_API_KEY` — used by host TTS process only, not passed to containers
- `CUA_API_KEY` — used by host sandbox manager only, not passed to containers
- `TELEGRAM_BOT_TOKEN` — used by host Telegram connection only
- Any credentials matching blocked patterns in the mount allowlist

> **Note:** AI auth credentials are mounted so that Claude Code can authenticate when the agent runs. This means the agent can discover these credentials via Bash or file operations. Ideally, Claude Code would authenticate without exposing credentials to the agent's execution environment. **PRs welcome** if you have ideas for credential isolation.

### 6. Dashboard Authentication

The web dashboard is accessible only to the bot owner:

1. **HMAC Validation** — Telegram Mini App sends `initData` to `POST /api/auth`. The server validates the HMAC-SHA256 signature using the bot token, following [Telegram's WebApp validation spec](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app).
2. **Owner Check** — The `user.id` from validated initData must match `TELEGRAM_OWNER_ID`.
3. **Time Window** — `auth_date` must be within 1 hour to prevent replay attacks.
4. **Session Tokens** — On success, a UUID bearer token is issued with 24-hour TTL. All API calls require `Authorization: Bearer <token>` or `?token=` query parameter.
5. **Timing-Safe Comparison** — HMAC comparison uses `crypto.timingSafeEqual` to prevent timing attacks.

### 7. CUA Desktop Sandbox

The CUA sandbox is a shared Docker container (one per NanoClaw instance, not per group):

- **Shared state** — All groups that use `browse_*` tools interact with the same desktop. A non-main group could potentially see browser state left by another group.
- **Network isolation** — The sandbox runs in Docker with mapped ports (8000 for commands, 5901 for VNC, 6901 for noVNC).
- **File transfer** — `browse_extract_file` and `browse_upload_file` move files between the agent container and the CUA sandbox via the host. Paths are validated.
- **Takeover web UI** — `browse_wait_for_user` generates a token-protected URL for the owner to interact with the desktop directly. The URL includes the Tailscale IP (or localhost fallback) and a random token.
- **Idle timeout** — Sandbox auto-stops after 30 minutes of inactivity to limit exposure.

**Mitigation for shared state:** In practice, only the main group (trusted) typically uses browser automation. Non-main groups have the same browse tools available but the shared nature means cross-group browser state leakage is possible.

### 8. Tailscale Considerations

When `SANDBOX_TAILSCALE_ENABLED=true` (default), the dashboard and CUA takeover UI are exposed via Tailscale serve (HTTPS reverse proxy):

- **Access control** — Tailscale ACLs and device authorization control who can reach the HTTPS endpoints.
- **TLS** — Tailscale serve provides automatic TLS certificates (required for Telegram Mini Apps).
- **Fallback** — If Tailscale is unavailable, URLs fall back to `127.0.0.1` (localhost only).

## Privilege Comparison

| Capability | Main Group | Non-Main Group |
|------------|------------|----------------|
| Project root access | `/workspace/project` (rw) | None |
| Group folder | `/workspace/group` (rw) | `/workspace/group` (rw) |
| Global memory | Implicit via project | `/workspace/global` (ro) |
| Additional mounts | Configurable | Read-only unless allowed |
| Network access | Unrestricted | Unrestricted |
| IPC tools | All | All except register_group |
| CUA sandbox | Shared access | Shared access |
| Filesystem tools (Claude) | Yes | Yes |
| Filesystem tools (OpenAI) | None | None |

## Security Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED ZONE                             │
│  Messages (potentially malicious)                                 │
└────────────────────────────────────┬─────────────────────────────┘
                                     │
                                     ▼ Trigger check, input escaping
┌──────────────────────────────────────────────────────────────────┐
│                     HOST PROCESS (TRUSTED)                        │
│  • Message routing                                                │
│  • IPC authorization                                              │
│  • Mount validation (external allowlist)                          │
│  • Container lifecycle                                            │
│  • Credential filtering & OAuth refresh                           │
│  • Dashboard auth (Telegram HMAC + owner check)                   │
│  • CUA sandbox management                                         │
│  • Tailscale serve (HTTPS reverse proxy)                          │
└────────────────┬──────────────────────────┬──────────────────────┘
                 │                          │
                 ▼ Explicit mounts only     ▼ HTTP /cmd API
┌────────────────────────────────┐  ┌──────────────────────────────┐
│    AGENT CONTAINER (SANDBOXED) │  │  CUA SANDBOX (SHARED SIDECAR)│
│  • Agent execution             │  │  • Desktop automation         │
│  • Bash commands (sandboxed)   │  │  • Chromium browser           │
│  • File operations (mounts)    │  │  • VNC/noVNC access           │
│  • IPC tools (file-based)      │  │  • Idle auto-stop             │
│  • Network access              │  │  • Shared across groups       │
│  • Cannot modify security cfg  │  │                               │
└────────────────────────────────┘  └──────────────────────────────┘
```
