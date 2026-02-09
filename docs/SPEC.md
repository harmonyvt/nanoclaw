# NanoClaw Specification

A personal AI assistant accessible via Telegram, with persistent memory per conversation, multi-provider support (Anthropic/OpenAI), scheduled tasks, browser automation, and long-term memory.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Folder Structure](#folder-structure)
3. [Configuration](#configuration)
4. [Memory System](#memory-system)
5. [Personality System](#personality-system)
6. [Session Management](#session-management)
7. [Message Flow](#message-flow)
8. [Multi-Provider Support](#multi-provider-support)
9. [Commands](#commands)
10. [Scheduled Tasks](#scheduled-tasks)
11. [Agent Tools](#agent-tools)
12. [Browser Automation (CUA)](#browser-automation-cua)
13. [Dashboard](#dashboard)
14. [Deployment](#deployment)
15. [Security Considerations](#security-considerations)
16. [Troubleshooting](#troubleshooting)

---

## Architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│                          HOST (macOS / Linux)                          │
│                         (Main Bun Process)                             │
├───────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  ┌──────────────┐                     ┌────────────────────┐          │
│  │  Telegram    │────────────────────▶│   SQLite Database  │          │
│  │  (grammY)    │◀────────────────────│   (messages.db)    │          │
│  └──────────────┘   store/send        └─────────┬──────────┘          │
│                                                  │                     │
│  ┌──────────────────┐  ┌──────────────────┐  ┌───────────────┐       │
│  │  Message Loop    │  │  Scheduler Loop  │  │  IPC Watcher  │       │
│  │  (polls SQLite)  │  │  (checks tasks)  │  │  (file-based) │       │
│  └────────┬─────────┘  └────────┬─────────┘  └───────┬───────┘       │
│           │                     │                     │                │
│  ┌────────┴─────────────────────┴─────────────────────┘               │
│  │                                                                     │
│  │  ┌───────────────┐  ┌───────────────────┐  ┌──────────────────┐   │
│  │  │  Dashboard    │  │  Supermemory      │  │  Tailscale Serve │   │
│  │  │  (Web UI)     │  │  (long-term mem)  │  │  (HTTPS proxy)   │   │
│  │  └───────────────┘  └───────────────────┘  └──────────────────┘   │
│  │                                                                     │
│  └─────────┬──────────────────────────────────┬───────────────────────┘
│            │ spawns container                  │ HTTP /cmd API
│            ▼                                   ▼
├────────────────────────────────┬──────────────────────────────────────┤
│    DOCKER CONTAINER            │    CUA SANDBOX (SHARED SIDECAR)     │
│    (per-group, ephemeral)      │    (trycua/cua-xfce:latest)         │
├────────────────────────────────┤──────────────────────────────────────┤
│  AGENT RUNNER                  │  • XFCE desktop environment         │
│                                │  • Chromium browser                  │
│  Adapter dispatch:             │  • VNC/noVNC live view               │
│  ├── ClaudeAdapter (SDK)       │  • /cmd API on port 8000             │
│  └── OpenAIAdapter (chat API)  │  • Takeover web UI (port 7788)      │
│                                │  • Idle auto-stop (30 min)           │
│  Volume mounts:                │                                      │
│  • /workspace/group (rw)       │                                      │
│  • /workspace/global (ro)      │                                      │
│  • /workspace/project (main)   │                                      │
│  • /workspace/ipc              │                                      │
│  • /workspace/env-dir (ro)     │                                      │
│  • /workspace/extra/* (opt)    │                                      │
│                                │                                      │
│  26+ IPC tools via MCP/fn-call │                                      │
└────────────────────────────────┴──────────────────────────────────────┘
```

### Technology Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| Runtime | Bun | Host process, TypeScript compilation |
| Telegram | grammY | Bot API client, message handling |
| Storage | SQLite (bun:sqlite) | Messages, tasks, logs |
| Container Runtime | Docker | Isolated agent execution |
| Agent (Anthropic) | @anthropic-ai/claude-agent-sdk | Claude Code with full tool access |
| Agent (OpenAI) | openai SDK | Chat completions with function calling |
| Browser Automation | CUA sandbox (Docker) | Desktop automation, Chromium, VNC |
| Web Crawling | Firecrawl API | URL scraping, multi-page crawl, sitemap |
| Long-term Memory | Supermemory API | Cross-session memory retrieval/storage |
| Voice Synthesis | Freya TTS API | Text-to-speech with emotion |
| Network Proxy | Tailscale serve | HTTPS for dashboard and CUA takeover |
| Logging | Pino + pino-pretty | Structured logging with dashboard sync |

---

## Folder Structure

```
nanoclaw/
├── CLAUDE.md                      # Project context for Claude Code
├── README.md                      # User documentation
├── CONTRIBUTING.md                # Contribution guidelines
├── package.json                   # Dependencies and scripts
├── tsconfig.json                  # TypeScript configuration
├── .env.example                   # Environment variable template
├── .gitignore
│
├── docs/
│   ├── SPEC.md                    # This specification document
│   ├── REQUIREMENTS.md            # Architecture decisions
│   ├── SECURITY.md                # Security model
│   ├── TOOLS.md                   # Agent tool reference
│   ├── ADAPTERS.md                # Multi-provider adapter system
│   └── DASHBOARD.md               # Dashboard documentation
│
├── src/
│   ├── index.ts                   # Main app: message routing, IPC watcher, lifecycle
│   ├── config.ts                  # Configuration constants and paths
│   ├── types.ts                   # TypeScript interfaces
│   ├── utils.ts                   # loadJson/saveJson helpers
│   ├── logger.ts                  # Pino logger with multistream
│   ├── db.ts                      # SQLite schema, queries, migrations
│   ├── telegram.ts                # grammY bot: text, voice, photo, document handlers
│   ├── media.ts                   # Telegram file download, Whisper transcription
│   ├── container-runner.ts        # Docker container spawning, credentials, mounts
│   ├── task-scheduler.ts          # Polls for due tasks, runs in containers
│   ├── mount-security.ts          # External allowlist validation for mounts
│   ├── supermemory.ts             # Long-term memory retrieval/storage
│   ├── tts.ts                     # Freya TTS with emotion detection
│   ├── sandbox-manager.ts         # CUA sandbox lifecycle (start/stop/idle)
│   ├── browse-host.ts             # Browser IPC bridge (request/response)
│   ├── cua-client.ts              # HTTP client for CUA /cmd API
│   ├── cua-takeover-server.ts     # Web UI for user browser handoff
│   ├── dashboard-server.ts        # Web dashboard (Telegram Mini App)
│   ├── dashboard-auth.ts          # Telegram HMAC auth + session tokens
│   ├── log-sync.ts                # Pino → SQLite log persistence
│   └── tailscale-serve.ts         # Tailscale HTTPS reverse proxy
│
├── container/
│   ├── Dockerfile                 # Agent image: bun + Chromium + claude-code
│   ├── build.sh                   # Build nanoclaw-agent:latest
│   └── agent-runner/
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts           # Entry point: one-shot and persistent modes
│           ├── types.ts           # ProviderAdapter, AgentEvent, NanoTool interfaces
│           ├── tool-registry.ts   # 26+ provider-agnostic tool definitions
│           ├── ipc-mcp.ts         # MCP server wrapping tool-registry for Claude SDK
│           └── adapters/
│               ├── index.ts       # createAdapter() factory
│               ├── claude-adapter.ts   # Claude Agent SDK wrapper
│               ├── openai-adapter.ts   # OpenAI chat completions + fn calling
│               ├── openai-session.ts   # OpenAI conversation persistence
│               └── openai-tools.ts     # Zod → JSON Schema bridge
│
├── container/sandbox/
│   ├── Dockerfile                 # CUA sandbox (rarely modified, uses pre-built image)
│   ├── build.sh
│   └── start.sh
│
├── scripts/
│   ├── deploy-launchd.sh          # macOS deployment automation
│   ├── deploy-systemd.sh          # Linux deployment automation
│   ├── ensure-docker-requirements.sh  # Docker validation and setup
│   ├── self-update.sh             # Automated updates with Telegram notify
│   ├── check-supermemory.ts       # Supermemory API validation
│   └── setup-envs.ts              # Environment file setup utility
│
├── launchd/
│   └── com.nanoclaw.plist         # macOS service template ({{placeholders}})
│
├── systemd/
│   └── com.nanoclaw.service       # Linux systemd user service template
│
├── .claude/
│   └── skills/                    # Claude Code skills (community-extensible)
│       ├── setup/SKILL.md
│       ├── deploy/SKILL.md
│       ├── customize/SKILL.md
│       ├── debug/SKILL.md
│       ├── restart/SKILL.md
│       ├── logs/SKILL.md
│       ├── commit/SKILL.md
│       ├── pr/SKILL.md
│       ├── add-gmail/SKILL.md
│       └── x-integration/SKILL.md
│
├── groups/
│   ├── CLAUDE.md                  # Global memory (all groups read, main writes)
│   ├── global/
│   │   └── CLAUDE.md              # Global agent instructions (read-only to non-main)
│   ├── main/
│   │   ├── CLAUDE.md              # Main channel memory
│   │   ├── SOUL.md                # Main channel personality (optional)
│   │   ├── logs/                  # Container execution logs
│   │   ├── media/                 # Downloaded photos, voice, documents
│   │   └── conversations/         # Archived transcripts (PreCompact)
│   └── {group-name}/              # Per-group folders (created on registration)
│       ├── CLAUDE.md              # Group-specific memory
│       ├── SOUL.md                # Group personality (optional)
│       ├── skills/                # Stored skills (reusable workflows as JSON)
│       ├── logs/
│       ├── media/
│       └── conversations/
│
├── store/                         # Local data (gitignored)
│   └── messages.db                # SQLite: messages, chats, scheduled_tasks, task_run_logs, logs
│
├── data/                          # Application state (gitignored)
│   ├── sessions.json              # Group → Claude SDK session ID mapping
│   ├── registered_groups.json     # Group JID → metadata (name, folder, provider, mounts)
│   ├── router_state.json          # Last processed timestamps
│   ├── env/env                    # Resolved credentials for container mounting
│   ├── sessions/{group}/.claude/  # Per-group Claude SDK session files
│   └── ipc/{group}/              # Per-group IPC namespaces
│       ├── messages/              # Outgoing message queue
│       ├── tasks/                 # Task scheduling requests
│       ├── browse/                # Browser request/response files
│       ├── agent-input/           # Persistent mode input
│       ├── agent-output/          # Persistent mode output
│       ├── status/                # Status event files
│       ├── current_tasks.json     # Tasks snapshot (host → agent)
│       └── available_groups.json  # Groups snapshot (main only)
│
└── logs/                          # Runtime logs (gitignored)
    ├── nanoclaw.log               # stdout (launchd) / journal (systemd)
    └── nanoclaw.error.log         # stderr (launchd)
```

---

## Configuration

Configuration constants live in `src/config.ts`. All settings can be overridden via environment variables.

### Core Settings

| Constant | Default | Env Var | Purpose |
|----------|---------|---------|---------|
| `ASSISTANT_NAME` | `Andy` | `ASSISTANT_NAME` | Trigger word (`@Name`) |
| `POLL_INTERVAL` | `2000` ms | — | Message polling frequency |
| `SCHEDULER_POLL_INTERVAL` | `60000` ms | — | Task scheduler frequency |
| `IPC_POLL_INTERVAL` | `1000` ms | — | IPC file watcher frequency |

### Container Settings

| Constant | Default | Env Var | Purpose |
|----------|---------|---------|---------|
| `CONTAINER_IMAGE` | `nanoclaw-agent:latest` | `CONTAINER_IMAGE` | Docker image for agents |
| `CONTAINER_TIMEOUT` | `300000` (5 min) | `CONTAINER_TIMEOUT` | Execution timeout (ms) |
| `CONTAINER_MAX_OUTPUT_SIZE` | `10485760` (10 MB) | `CONTAINER_MAX_OUTPUT_SIZE` | Max stdout/stderr |

### CUA Sandbox Settings

| Constant | Default | Env Var | Purpose |
|----------|---------|---------|---------|
| `CUA_SANDBOX_IMAGE` | `trycua/cua-xfce:latest` | `CUA_SANDBOX_IMAGE` | Desktop sandbox Docker image |
| `CUA_SANDBOX_COMMAND_PORT` | `8000` | `CUA_SANDBOX_COMMAND_PORT` | `/cmd` API port |
| `CUA_SANDBOX_VNC_PORT` | `5901` | `CUA_SANDBOX_VNC_PORT` | VNC port |
| `CUA_SANDBOX_NOVNC_PORT` | `6901` | `CUA_SANDBOX_NOVNC_PORT` | noVNC browser viewer port |
| `CUA_TAKEOVER_WEB_PORT` | `7788` | `CUA_TAKEOVER_WEB_PORT` | Takeover web UI port |
| `CUA_SANDBOX_PERSIST` | `true` | `CUA_SANDBOX_PERSIST` | Persist sandbox state across restarts |
| `CUA_SANDBOX_HOME_VOLUME` | `nanoclaw-cua-home` | `CUA_SANDBOX_HOME_VOLUME` | Docker volume for persistent `/home/cua` |
| `SANDBOX_IDLE_TIMEOUT_MS` | `1800000` (30 min) | `SANDBOX_IDLE_TIMEOUT_MS` | Idle auto-stop |
| `MAX_THINKING_TOKENS` | `10000` | `MAX_THINKING_TOKENS` | Max extended thinking tokens for Claude (0 to disable) |

### Per-Group Container Configuration

Groups can have additional directories mounted via `containerConfig` in `data/registered_groups.json`:

```json
{
  "tg:1234567890": {
    "name": "Dev Team",
    "folder": "dev-team",
    "trigger": "@Andy",
    "added_at": "2026-01-31T12:00:00Z",
    "providerConfig": {
      "provider": "openai",
      "model": "gpt-4o"
    },
    "containerConfig": {
      "additionalMounts": [
        {
          "hostPath": "~/projects/webapp",
          "containerPath": "webapp",
          "readonly": false
        }
      ],
      "timeout": 600000
    }
  }
}
```

Additional mounts appear at `/workspace/extra/{containerPath}` inside the container. All mounts are validated against the external allowlist at `~/.config/nanoclaw/mount-allowlist.json`.

### Authentication

Credential resolution follows a fallback chain (in `container-runner.ts`):

1. `.env` file — `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`
2. macOS Keychain — `Claude Code-credentials` entry
3. `~/.claude/.credentials.json` — cached `claudeAiOauth.accessToken`

OAuth tokens are automatically refreshed before expiry. Non-auth API keys (`OPENAI_API_KEY`, `FIRECRAWL_API_KEY`, `SUPERMEMORY_API_KEY`, etc.) are always read from `.env`.

---

## Memory System

NanoClaw uses a hierarchical memory system based on CLAUDE.md files.

### Memory Hierarchy

| Level | Location | Read By | Written By | Purpose |
|-------|----------|---------|------------|---------|
| **Global** | `groups/CLAUDE.md` | All groups | Main only | Preferences, facts, shared context |
| **Global Instructions** | `groups/global/CLAUDE.md` | Non-main groups | Main only | Agent instructions for non-main groups |
| **Group** | `groups/{name}/CLAUDE.md` | That group | That group | Group-specific context, conversation memory |
| **Files** | `groups/{name}/*.md` | That group | That group | Notes, research, documents |

### How Memory Works

1. **Agent Context Loading**
   - Agent runs with `cwd` set to `groups/{group-name}/`
   - Claude Agent SDK with `settingSources: ['project']` automatically loads CLAUDE.md files
   - Non-main groups get `groups/global/CLAUDE.md` mounted read-only at `/workspace/global/`

2. **Writing Memory**
   - Agent writes to `./CLAUDE.md` in the group folder
   - Main channel can write to `../CLAUDE.md` (global memory)
   - Agent can create arbitrary files in the group folder

3. **Long-term Memory (Supermemory)**
   - When `SUPERMEMORY_API_KEY` is set, memories are retrieved before each agent invocation and stored after each response
   - Agent can explicitly save/search memories via `memory_save` and `memory_search` tools
   - Memories persist across sessions and context compaction

---

## Personality System

Each group can have a `SOUL.md` file defining the agent's personality.

### How SOUL.md Works

1. The agent-runner reads `SOUL.md` from the group's working directory at the start of every query
2. Contents are injected as a `<soul>` XML block before the user's messages
3. The agent can modify `SOUL.md` to update its own personality at the user's request
4. If `SOUL.md` doesn't exist, the agent is prompted to ask the user to define a personality

SOUL.md is freeform markdown. It is **not** auto-loaded by the Claude Agent SDK's `settingSources` mechanism — the agent-runner manually reads and injects it.

---

## Session Management

Sessions enable conversation continuity.

### Claude Sessions (Anthropic Provider)

- Each group has a session ID stored in `data/sessions.json`
- Session ID is passed to Claude Agent SDK's `resume` option
- SDK manages context compaction via PreCompact hook (archives transcripts to `conversations/`)

### OpenAI Sessions

- Each group stores conversation history in `.openai-sessions/{sessionId}.json`
- History auto-trims: keeps system prompt + last 99 messages when exceeding 100

---

## Message Flow

### Incoming Message Flow

```
1. User sends Telegram message
   │
   ▼
2. grammY receives message via Telegram Bot API
   │  (text, voice, photo, or document)
   │
   ▼
3. Media processing (if applicable):
   ├── Voice/Audio → Whisper transcription → "[Voice message: ...]"
   ├── Photo → saved to groups/{folder}/media/
   └── Document → saved to groups/{folder}/media/
   │
   ▼
4. Message stored in SQLite (store/messages.db)
   │
   ▼
5. Message loop polls SQLite (every 2 seconds)
   │
   ▼
6. Router checks:
   ├── Is chat_jid in registered_groups.json? → No: ignore
   └── Does message start with @Assistant? → No: ignore (main is exempt)
   │
   ▼
7. Router catches up conversation:
   ├── Fetch all messages since last agent interaction
   ├── Format as XML with timestamp, sender, media attributes
   └── Retrieve Supermemory context (if enabled)
   │
   ▼
8. Spawn Docker container:
   ├── Resolve credentials (env → keychain → cached)
   ├── Build volume mounts (group, global, session, IPC, env)
   ├── Send JSON input via stdin (or IPC file in persistent mode)
   └── Adapter dispatch based on group's providerConfig
   │
   ▼
9. Agent processes message:
   ├── Reads CLAUDE.md + SOUL.md for context
   ├── Uses tools as needed (browse, search, file ops, etc.)
   └── Returns result via stdout JSON (between sentinel markers)
   │
   ▼
10. Host processes response:
    ├── Send text response via Telegram
    ├── Send voice message if Freya TTS enabled and response is short
    ├── Update session ID
    └── Store interaction to Supermemory (async, non-blocking)

During agent execution, the host shows live progress in Telegram:
- Tool activity and thinking snippets are displayed as an italic status message
- The status message is updated in-place (edited) as the agent works
- Thinking display can be toggled per-chat via /thinking command
- Verbose tool details can be toggled via /verbose command
```

### Message Format (XML)

Messages are formatted as XML for the agent prompt:

```xml
<messages>
<message sender="John" time="2026-02-07T14:32:00Z">hey everyone</message>
<message sender="Sarah" time="2026-02-07T14:33:00Z" media_type="photo" media_path="/workspace/group/media/photo.jpg">check this out</message>
</messages>
```

### Trigger Word Matching

Messages must start with the trigger pattern (default: `@Andy`):
- `@Andy what's the weather?` — triggers agent
- `@andy help me` — triggers (case insensitive)
- `Hey @Andy` — ignored (trigger not at start)
- `What's up?` — ignored (no trigger)

The main channel (self-chat) is exempt from trigger requirements.

---

## Multi-Provider Support

NanoClaw supports multiple AI providers via an adapter pattern. See [ADAPTERS.md](ADAPTERS.md) for full details.

### Provider Configuration

Each group can use a different provider:

```json
{
  "providerConfig": {
    "provider": "openai",
    "model": "gpt-4o"
  }
}
```

**Resolution chain:** group `providerConfig` → `DEFAULT_PROVIDER` / `DEFAULT_MODEL` env vars → `anthropic`

### Provider Differences

| Feature | Anthropic (Claude) | OpenAI |
|---------|-------------------|--------|
| Filesystem tools | Bash, Read, Write, Edit, Glob, Grep | None |
| Web tools | WebSearch, WebFetch | None |
| IPC tools | Via MCP server | Via function calling |
| Session management | Claude SDK sessions | JSON file persistence |
| Context compaction | SDK PreCompact hook | Manual trim (100 messages) |

---

## Commands

### Telegram Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | List all available commands |
| `/new` | Start a new conversation thread |
| `/clear` | Clear conversation history and reset session |
| `/status` | Show session info, message count, uptime |
| `/stop` | Interrupt a running agent mid-response |
| `/tasks` | List scheduled tasks and automations |
| `/runtask <id>` | Trigger a task immediately |
| `/skills` | List stored skills (reusable workflows) |
| `/thinking` | Toggle display of agent thinking/reasoning status |
| `/verbose` | Toggle verbose tool-activity status messages |
| `/update` | Check for updates; requires `/update confirm` within 30 seconds (also rebuilds agent container) |
| `/rebuild` | Re-install dependencies and rebuild agent container (no git pull) |
| `/dashboard` | Open the web dashboard (Telegram Mini App) |
| `/follow` | Open the CUA Follow page to watch agent browser activity live |
| `/takeover` | Get URL for manual browser control |

The trigger word (`@Andy`) is used for natural language messages. Slash commands work without the trigger.

### Telegram Skills (Custom Commands)

Agents can create reusable workflows stored as Telegram slash commands. Users teach the agent a workflow conversationally, then say "store this as a skill called `<name>`". The agent calls `store_skill` to persist it.

- Skills are stored as JSON files in `groups/{folder}/skills/{name}.json`
- Each skill contains: name, description, instructions, optional parameters
- Skills appear as Telegram slash commands (auto-registered via `setMyCommands`)
- When invoked, the skill instructions guide a fresh agent session through the workflow
- Use `/skills` to list stored skills, or the `delete_skill` tool to remove one

---

## Scheduled Tasks

### How Scheduling Works

1. Agent calls `schedule_task` tool with prompt, schedule type, and value
2. Host stores task in SQLite with `next_run` timestamp
3. Scheduler loop checks for due tasks every 60 seconds
4. Due tasks spawn a container agent with the task's prompt
5. Results logged; next run calculated (cron/interval) or task completed (once)

### Schedule Types

| Type | Value Format | Example |
|------|-------------|---------|
| `cron` | Cron expression | `0 9 * * 1` (Mondays at 9am) |
| `interval` | Milliseconds | `3600000` (every hour) |
| `once` | ISO timestamp | `2026-02-10T09:00:00Z` |

### Context Modes

| Mode | Behavior |
|------|----------|
| `group` | Uses the group's current session (conversation context preserved) |
| `isolated` | Fresh session each run (no memory of past runs) |

---

## Agent Tools

NanoClaw provides 26+ IPC tools to agents. See [TOOLS.md](TOOLS.md) for the full reference.

### Tool Categories

| Category | Tools | IPC Pattern |
|----------|-------|-------------|
| Communication | `send_message`, `send_file`, `send_voice` | Fire-and-forget |
| Task Scheduling | `schedule_task`, `list_tasks`, `pause_task`, `resume_task`, `cancel_task` | Fire-and-forget |
| Group Management | `register_group` | Fire-and-forget |
| Skills | `store_skill`, `list_skills`, `delete_skill` | Fire-and-forget |
| Web Crawling | `firecrawl_scrape`, `firecrawl_crawl`, `firecrawl_map` | Direct API call |
| Long-term Memory | `memory_save`, `memory_search` | Direct API call |
| Browser Automation | 14 `browse_*` tools | Request/response |

### Built-in Claude Tools (Anthropic only)

Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch — provided by the Claude Agent SDK, not available with OpenAI.

---

## Browser Automation (CUA)

The CUA desktop sandbox provides full browser automation via a Docker container running an XFCE desktop with Chromium.

### Architecture

- **Lazy start** — Sandbox only starts on first `browse_*` tool call
- **Shared sidecar** — One sandbox per NanoClaw instance, shared across groups
- **Persistent storage** — When `CUA_SANDBOX_PERSIST=true` (default), a named Docker volume (`CUA_SANDBOX_HOME_VOLUME`) persists `/home/cua` across container restarts. The container is stopped (not removed) on idle/shutdown.
- **Idle auto-stop** — Stops after 30 minutes of inactivity
- **No step limits** — Agents can perform unlimited browse actions per session
- **Ports**: 8000 (command API), 5901 (VNC), 6901 (noVNC), 7788 (takeover UI)

### User Handoff (`browse_wait_for_user`)

The agent can pause and present the user with a takeover URL:
1. Agent calls `browse_wait_for_user` with a reason message
2. Host generates a token-protected URL with embedded noVNC desktop view
3. URL sent to user via Telegram (uses Tailscale IP or localhost fallback)
4. User interacts with the desktop directly
5. User clicks "Return control" button
6. Agent resumes with the updated browser state

### Screenshot Feedback

`browse_screenshot` captures the desktop, saves to `groups/{name}/media/`, and sends the image to the Telegram chat. The agent can use Claude's Read tool on the saved path for visual analysis.

---

## Dashboard

See [DASHBOARD.md](DASHBOARD.md) for full documentation.

The web dashboard is a Telegram Mini App providing:
- Live log streaming (SSE)
- Container execution log viewer
- Task monitoring and management
- File management for agent groups and CUA sandbox
- Authenticated via Telegram HMAC (`TELEGRAM_OWNER_ID` only)

Access via the `/dashboard` command or the Telegram menu button.

---

## Deployment

NanoClaw runs as a background service on macOS (launchd) or Linux (systemd).

### Prerequisites

- **Bun** runtime installed
- **Docker** daemon running
- `nanoclaw-agent:latest` image built (`./container/build.sh`)
- CUA sandbox image pulled (optional, for browser automation)
- `.env` file with `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_ID`

### macOS (launchd)

```bash
bun run deploy:macos
# or manually:
scripts/deploy-launchd.sh
```

This builds the agent image, substitutes placeholders in `launchd/com.nanoclaw.plist`, copies to `~/Library/LaunchAgents/`, and loads the service.

```bash
# Managing the service
launchctl list | grep nanoclaw          # Check status
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist  # Stop
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist    # Start
```

### Linux (systemd)

```bash
bun run deploy:linux
# or manually:
scripts/deploy-systemd.sh
```

This builds the agent image, substitutes placeholders in `systemd/com.nanoclaw.service`, installs as a user service, and starts it.

```bash
# Managing the service
systemctl --user status com.nanoclaw    # Check status
systemctl --user restart com.nanoclaw   # Restart
journalctl --user -u com.nanoclaw -f    # Follow logs
```

### Startup Sequence

When NanoClaw starts:
1. Initializes SQLite database (schema migrations)
2. Loads state (registered groups, sessions, router state)
3. Cleans up old media files (>7 days) and orphan persistent containers
4. Connects to Telegram
5. Starts message polling loop (every 2s)
6. Starts scheduler loop (every 60s)
7. Starts IPC watcher for container messages/tasks/browse
8. Starts dashboard server (if enabled)
9. Sets up Tailscale serve (if available)

---

## Security Considerations

See [SECURITY.md](SECURITY.md) for the full security model.

### Key Points

- **Container isolation** (primary boundary) — Agents run in Docker with explicit mounts only, non-root `bun` user
- **External mount allowlist** — `~/.config/nanoclaw/mount-allowlist.json`, never mounted into containers
- **Session isolation** — Each group gets separate session directory and IPC namespace
- **IPC authorization** — Host verifies group identity; non-main groups restricted from cross-group operations
- **Credential filtering** — Only specific env vars exposed to containers
- **Dashboard auth** — Telegram HMAC validation + `TELEGRAM_OWNER_ID` check

### Prompt Injection Mitigations

- Container isolation limits blast radius
- Only registered groups are processed
- Trigger word required (reduces accidental processing)
- Agents can only access their group's mounted directories
- Claude's built-in safety training

---

## Troubleshooting

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| No response to messages | Service not running | Check `launchctl list \| grep nanoclaw` (macOS) or `systemctl --user status com.nanoclaw` (Linux) |
| Container exits with error | Docker not running | Ensure Docker daemon is started |
| Container exits with error | Image not built | Run `./container/build.sh` |
| Session not continuing | Session ID not saved | Check `data/sessions.json` |
| "No groups registered" | Haven't added groups | Use `@Andy add group "Name"` in main |
| CUA sandbox not starting | Docker image missing | Run `docker pull --platform linux/amd64 trycua/cua-xfce:latest` |
| Dashboard not loading | HTTPS required by Telegram | Configure Tailscale serve or TLS certs |
| OpenAI adapter errors | Missing API key | Set `OPENAI_API_KEY` in `.env` |
| Firecrawl tools failing | Missing API key | Set `FIRECRAWL_API_KEY` in `.env` |

### Log Locations

| Log | Location |
|-----|----------|
| Host stdout | `logs/nanoclaw.log` (launchd) or `journalctl --user -u com.nanoclaw` (systemd) |
| Host stderr | `logs/nanoclaw.error.log` (launchd) |
| Container logs | `groups/{folder}/logs/container-*.log` |
| Dashboard logs | Available via dashboard SSE stream |

### Debug Mode

```bash
bun dev          # Run with hot reload (--watch)
LOG_LEVEL=debug bun dev   # Verbose output
```
