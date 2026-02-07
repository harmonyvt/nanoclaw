# NanoClaw Security Model

## Trust Model

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Main group | Trusted | Private self-chat, admin control |
| Non-main groups | Untrusted | Other users may be malicious |
| Container agents | Sandboxed | Isolated execution environment |
| Messages | User input | Potential prompt injection |

## Security Boundaries

### 1. Container Isolation (Primary Boundary)

Agents execute in Apple Container (lightweight Linux VMs), providing:
- **Process isolation** - Container processes cannot affect the host
- **Filesystem isolation** - Only explicitly mounted directories are visible
- **Non-root execution** - Runs as unprivileged `node` user (uid 1000)
- **Ephemeral containers** - Fresh environment per invocation (`--rm`)

This is the primary security boundary. Rather than relying on application-level permission checks, the attack surface is limited by what's mounted.

### 2. Mount Security

**External Allowlist** - Mount permissions stored at `~/.config/nanoclaw/mount-allowlist.json`, which is:
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

Each group has isolated Claude sessions at `data/sessions/{group}/.claude/`:
- Groups cannot see other groups' conversation history
- Session data includes full message history and file contents read
- Prevents cross-group information disclosure

### 4. IPC Authorization

Messages and task operations are verified against group identity:

| Operation | Main Group | Non-Main Group |
|-----------|------------|----------------|
| Send message to own chat | ✓ | ✓ |
| Send message to other chats | ✓ | ✗ |
| Schedule task for self | ✓ | ✓ |
| Schedule task for others | ✓ | ✗ |
| View all tasks | ✓ | Own only |
| Manage other groups | ✓ | ✗ |

### 5. Credential Handling

Credential behavior now depends on runtime mode:

**Default Mode (`SECRETLESS_MODE=false`)**
- Claude auth tokens may be mounted read-only for in-container Claude auth.

**Secretless Mode (`SECRETLESS_MODE=true`)**
- No API keys or auth tokens are mounted into agent containers.
- Secret-bearing API calls are routed through a host-side capability gateway over IPC.
- Container networking is disabled by default (`CONTAINER_NETWORK_MODE=none`).

**NOT Mounted:**
- Mount allowlist - external, never mounted
- Any credentials matching blocked patterns

**Host Capability Gateway (Secretless Mode):**
- Firecrawl tools execute on host using host `FIRECRAWL_API_KEY`
- Supermemory tools execute on host using host `SUPERMEMORY_*` key
- Anthropic messages execute on host using host `ANTHROPIC_API_KEY` or Claude Code OAuth credentials
- OpenAI chat completions execute on host using host `OPENAI_API_KEY`
- Container receives only request results, never raw secrets

## Privilege Comparison

| Capability | Main Group | Non-Main Group |
|------------|------------|----------------|
| Project root access | `/workspace/project` (rw) | None |
| Group folder | `/workspace/group` (rw) | `/workspace/group` (rw) |
| Global memory | Implicit via project | `/workspace/global` (ro) |
| Additional mounts | Configurable | Read-only unless allowed |
| Network access | Configurable (`default` or `none`) | Configurable (`default` or `none`) |
| MCP tools | All | All |

## Security Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED ZONE                             │
│  Messages (potentially malicious)                                 │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Trigger check, input escaping
┌──────────────────────────────────────────────────────────────────┐
│                     HOST PROCESS (TRUSTED)                        │
│  • Message routing                                                │
│  • IPC authorization                                              │
│  • Mount validation (external allowlist)                          │
│  • Container lifecycle                                            │
│  • Credential filtering                                           │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Explicit mounts only
┌──────────────────────────────────────────────────────────────────┐
│                CONTAINER (ISOLATED/SANDBOXED)                     │
│  • Agent execution                                                │
│  • Bash commands (sandboxed)                                      │
│  • File operations (limited to mounts)                            │
│  • Network access (unrestricted)                                  │
│  • Cannot modify security config                                  │
└──────────────────────────────────────────────────────────────────┘
```
