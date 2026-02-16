# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Architecture

Single Bun process (host) connects to Telegram, stores messages in SQLite, and spawns ephemeral Docker containers per message. Each container uses an adapter pattern to dispatch to either the Claude Agent SDK or OpenAI chat completions based on per-group `providerConfig`. Browse automation runs in a CUA desktop sandbox sidecar.

```
Telegram <-> Host (Bun) <-> SQLite
                |
                +-- Docker containers (ephemeral, per-message)
                |     \-- Adapter dispatch (per-group provider/model)
                |           +-- ClaudeAdapter (Claude Agent SDK + MCP tools)
                |           +-- OpenAIAdapter (chat completions + function calling)
                |
                +-- CUA desktop sandbox (persistent sidecar)
                |     \-- /cmd API + screenshot transport
                |
                +-- Voice call sidecar (pytgcalls, on-demand)
                      \-- FastAPI on :8100, host callback on :8101
```

## Key Files

### Host Process

| File                      | Purpose                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| `src/index.ts`            | Main app: message routing, IPC watcher (messages/tasks/browse)     |
| `src/config.ts`           | Constants, trigger pattern, paths, Telegram helpers                |
| `src/container-runner.ts` | Spawns Docker containers, credential resolution, volume mounts     |
| `src/task-scheduler.ts`   | Polls for due tasks, runs them in containers                       |
| `src/db.ts`               | SQLite operations (bun:sqlite): messages, chats, tasks, run logs   |
| `src/telegram.ts`         | grammY bot: text, voice, audio, photo, document handlers           |
| `src/media.ts`            | File download (Telegram API), audio transcription (Replicate), media cleanup |
| `src/browse-host.ts`      | Host-side browse bridge for CUA `/cmd` actions                     |
| `src/sandbox-manager.ts`  | CUA sandbox lifecycle: start/stop/idle timeout (Docker)            |
| `src/mount-security.ts`   | Validates additional mounts against external allowlist             |
| `src/replicate-client.ts` | Shared Replicate SDK singleton and `runModel()` helper             |
| `src/tts-qwen.ts`        | Qwen3-TTS client: voice profiles, HTTP synthesis via self-hosted server |
| `src/tts-replicate.ts`   | Replicate-hosted TTS: Qwen, Chatterbox, MiniMax provider adapters  |
| `src/tts-dispatch.ts`    | Unified TTS dispatcher: routes to self-hosted or Replicate by provider |
| `src/supermemory.ts`      | Optional Supermemory integration: retrieve/store long-term memory  |
| `src/types.ts`            | Shared TypeScript interfaces                                       |
| `src/logger.ts`           | Pino logger with pino-pretty                                       |
| `src/skills.ts`           | Skill loading utilities (per-group skill files)                    |
| `src/utils.ts`            | `loadJson` / `saveJson` helpers                                    |
| `src/voice-call.ts`      | Voice call manager: sidecar lifecycle, STT→Agent→TTS pipeline      |
| `src/voice-call-server.ts`| HTTP callback server (:8101) for voice sidecar utterances          |

### Voice Call Sidecar

| File                           | Purpose                                                        |
| ------------------------------ | -------------------------------------------------------------- |
| `voice-sidecar/Dockerfile`     | Python 3.11 + pytgcalls + silero-vad + FastAPI                 |
| `voice-sidecar/build.sh`       | Build script (`nanoclaw-voice-sidecar:latest`)                 |
| `voice-sidecar/server.py`      | FastAPI: `/join`, `/leave`, `/status`, `/play`, `/health`      |
| `voice-sidecar/vad.py`         | silero-vad speech endpoint detection (state machine)           |
| `voice-sidecar/audio.py`       | PCM/WAV conversion, 48kHz↔16kHz resampling                    |

### Agent Container

| File                                                  | Purpose                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------- |
| `container/Dockerfile`                                | Agent image: `oven/bun:1-debian` + Chromium + claude-code           |
| `container/build.sh`                                  | Build script for agent image (`nanoclaw-agent:latest`)              |
| `container/agent-runner/src/index.ts`                 | Reads JSON from stdin, dispatches to adapter, writes result to stdout |
| `container/agent-runner/src/types.ts`                 | Shared adapter interfaces (`ProviderAdapter`, `AdapterInput`, etc.) |
| `container/agent-runner/src/tool-registry.ts`         | Provider-agnostic tool definitions (22 tools with Zod schemas)      |
| `container/agent-runner/src/ipc-mcp.ts`               | Thin Claude SDK wrapper that maps tool-registry into MCP server     |
| `container/agent-runner/src/adapters/index.ts`        | `createAdapter()` factory: dispatches to Claude or OpenAI           |
| `container/agent-runner/src/adapters/claude-adapter.ts`| Claude Agent SDK `query()` with PreCompact hooks                   |
| `container/agent-runner/src/adapters/openai-adapter.ts`| OpenAI chat completions with function-calling loop (max 50 iter)   |
| `container/agent-runner/src/adapters/openai-session.ts`| OpenAI conversation history persistence (JSON files, auto-trim)    |
| `container/agent-runner/src/adapters/openai-tools.ts` | Zod-to-JSON Schema bridge for OpenAI function calling               |

### Per-Group

| File                           | Purpose                                             |
| ------------------------------ | --------------------------------------------------- |
| `groups/{name}/CLAUDE.md`      | Per-group agent instructions and memory             |
| `groups/{name}/SOUL.md`        | Per-group personality/behavior (optional)           |
| `groups/{name}/voice_profile.json` | Per-group TTS voice config (Qwen3-TTS)          |
| `groups/{name}/media/`         | Downloaded photos, voice, docs, screenshots         |
| `groups/{name}/conversations/` | Archived conversation transcripts (PreCompact hook) |
| `groups/{name}/skills/`        | Stored skill definitions (JSON, one per skill)      |
| `groups/{name}/logs/`          | Per-container run logs                              |
| `groups/global/CLAUDE.md`      | Global memory shared read-only to non-main groups   |

### SOUL.md

Per-group personality file. Read by the agent-runner at the start of every query and injected as a `<soul>` XML block before the user's messages. The agent can modify this file to update its own personality at the user's request.

If SOUL.md doesn't exist for a group, the agent is prompted to ask the user to define a personality. The file is freeform markdown. SOUL.md is NOT auto-loaded by the Claude Agent SDK's `settingSources: ['project']` mechanism (which only discovers CLAUDE.md) — the agent-runner manually reads and injects it.

## Credential Flow

Credentials are resolved with a fallback chain in `container-runner.ts:resolveCredentials()`:

1. **`.env` file** -- looks for `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`
2. **macOS Keychain** -- reads `Claude Code-credentials` via `security find-generic-password`
3. **`~/.claude/.credentials.json`** -- parses `claudeAiOauth.accessToken`

Non-auth API keys (`OPENAI_API_KEY`, `FIRECRAWL_API_KEY`) are always extracted from `.env` regardless of auth source.

Credentials are written to `data/env/env` and mounted read-only at `/workspace/env-dir/env`. The container entrypoint sources this file.

## Container Runtime

Uses **Docker CLI** (`docker run -i --rm`). The codebase was originally written for Apple Container and fully migrated to Docker. Some source comments still reference Apple Container (stale -- see `container-runner.ts:503`, `:544`).

- Image: `nanoclaw-agent:latest` (configurable via `CONTAINER_IMAGE`)
- Runs as non-root user `bun`
- Input: JSON on stdin, output: JSON on stdout (between sentinel markers)
- Timeout: 5 minutes default (`CONTAINER_TIMEOUT`)
- Max output: 10MB default (`CONTAINER_MAX_OUTPUT_SIZE`)
- Entrypoint: sources env from `/workspace/env-dir/env`, then runs `bun /app/dist/index.js`
- The env-dir mount (credentials as a file) was originally a workaround for an Apple Container bug with `-e` env vars when using `-i` stdin. Docker doesn't have this bug, but the pattern is harmless and still works.
- **The host process must NOT be containerized** -- it needs Docker socket access, macOS keychain access, and direct filesystem access.

### Volume Mounts

| Mount                             | Container Path            | Notes                       |
| --------------------------------- | ------------------------- | --------------------------- |
| `groups/{folder}/`                | `/workspace/group`        | Working directory           |
| `groups/global/`                  | `/workspace/global`       | Read-only (non-main only)   |
| Project root                      | `/workspace/project`      | Main group only             |
| `data/sessions/{folder}/.claude/` | `/home/bun/.claude`       | Per-group session isolation |
| `data/ipc/{folder}/`              | `/workspace/ipc`          | Per-group IPC namespace     |
| `data/env/`                       | `/workspace/env-dir`      | Read-only credentials       |
| Additional mounts                 | `/workspace/extra/{name}` | Validated against allowlist |

## Multimodal Input

Voice, audio, photos, and documents sent via Telegram are processed automatically:

- **Voice/Audio**: Downloaded, transcribed via Replicate GPT-4o-transcribe, stored as `[Voice message: ...]`
- **Photos**: Saved to `groups/{name}/media/`, path included in prompt (agent uses Claude's Read tool for vision)
- **Documents**: Saved to `groups/{name}/media/`, filename/caption included in prompt

Media path is translated from host path to container path in the XML prompt (`media_path` attribute). Requires `REPLICATE_API_TOKEN` for transcription. Old media cleaned up after 7 days on startup.

## Browser Sandbox

- **Sandbox image**: `trycua/cua-xfce:latest` (configurable by `CUA_SANDBOX_IMAGE`)
- **Command API**: host connects to `/cmd` on port `8000` (mapped by `CUA_SANDBOX_COMMAND_PORT`)
- **VNC**: `5901` (mapped by `CUA_SANDBOX_VNC_PORT`)
- **noVNC (browser live view)**: `6901` (mapped by `CUA_SANDBOX_NOVNC_PORT`)
- **Takeover web UI**: `7788` (mapped by `CUA_TAKEOVER_WEB_PORT`)
- **Lazy start**: Sandbox starts on first `browse_*` tool call
- **Idle timeout**: Stops after 30 min of no browse activity
- **Live URL in wait-for-user**: takeover URL `http://<tailscale-ip>:<CUA_TAKEOVER_WEB_PORT>/cua/takeover/<token>` (includes embedded noVNC + continue button; fallback `127.0.0.1`)
- **VNC authentication**: Random VNC password generated on sandbox start (`VNC_PW` env var). Password rotated per-takeover session — each `browse_wait_for_user` gets a fresh password, invalidated when control returns. noVNC iframe receives the password via URL parameter; direct noVNC URLs are never sent to chat.
- **Screenshot feedback**: `browse_screenshot` always saves to group media and is sent as Telegram photo
- **Persistence**: Sandbox state (browser sessions, cookies, installed software) persists across restarts by default. The container is stopped (not removed) on idle, and restarted on next use. A named Docker volume (`nanoclaw-cua-home`) backs `/home/cua` as a safety net for image updates. Disable with `CUA_SANDBOX_PERSIST=false`.

## IPC Patterns

### Fire-and-forget (messages, tasks)

Agent writes JSON to `/workspace/ipc/messages/` or `/workspace/ipc/tasks/`. Host polls every 1s, processes, deletes.

### Request/Response (browse)

Agent writes `req-{id}.json` to `/workspace/ipc/browse/`, polls for `res-{id}.json`. Host processes request, writes response (atomic: temp+rename). Agent cleans up both files.

### Authorization

Per-group IPC directories prevent cross-group access. Non-main groups can only send messages to their own chat and schedule tasks for themselves. Main group has full access.

## MCP Tools (available to agent)

### Communication

- `send_message` -- Send message to current chat
- `send_file` -- Send a file/document to current chat (path must be under /workspace/group/ or /workspace/global/)
- `send_voice` -- Send a voice message using Qwen3-TTS (primary) or Freya TTS (fallback). Voice characteristics from per-group `voice_profile.json`

### Audio Processing

- `download_audio` -- Download audio from URL via yt-dlp (YouTube, Twitch, SoundCloud, etc.). Returns path to downloaded WAV file.
- `convert_audio` -- Convert audio with ffmpeg (format, sample rate, mono, trim duration). Ideal for preparing voice clone reference audio (24kHz mono WAV, max 10s).
- `transcribe_audio` -- Transcribe an audio file to text using Replicate GPT-4o-transcribe (requires REPLICATE_API_TOKEN)

### Task Scheduling

- `schedule_task` -- Create cron/interval/once task (with context_mode: group or isolated)
- `list_tasks` -- List scheduled tasks (main sees all, others see own)
- `pause_task` / `resume_task` / `cancel_task` -- Task lifecycle

### Group Management

- `register_group` -- Register new Telegram chat (main only). Accepts optional `provider` (`anthropic`/`openai`), `model`, and `base_url` params for per-group AI configuration.

### Skills (Reusable Workflows)

- `store_skill` -- Save a reusable workflow as a Telegram /command. Agent extracts steps from conversation, validates name, writes to `groups/{folder}/skills/{name}.json`, and notifies host to re-register Telegram commands. Can use `memory_search` to enrich instructions with past workflow details.
- `list_skills` -- List all stored skills for the current group
- `delete_skill` -- Delete a stored skill and remove its Telegram command

Skills are stored as JSON files in `groups/{folder}/skills/`. When a user types `/{skill_name}` in Telegram, the host reads the skill file, wraps the instructions in a `<skill>` XML block, and injects it into the agent prompt. The agent then follows the stored instructions. Skills support parameters: text after the command (e.g., `/check_analytics last_week`) is passed to the agent.

### Browser Automation

- `browse_navigate` -- Go to URL
- `browse_snapshot` -- Accessibility tree / aria snapshot
- `browse_click` -- Click using description text (CSS-like selectors are treated as best-effort hints)
- `browse_click_xy` -- Click at exact pixel coordinates (fallback when browse_click fails)
- `browse_perform` -- Execute a sequence of desktop actions (click, double_click, right_click, key, type, scroll, drag, hover, wait). Use for keyboard shortcuts, double-clicking, and multi-step interactions. See examples below.
- `browse_fill` -- Fill form field (description-based element search + typing)
- `browse_type_at_xy` -- Click at coordinates then type text (fallback when browse_fill fails). Supports `clear_first: true` to Ctrl+A before typing.
- `browse_screenshot` -- Capture page (also sent as Telegram photo); use Read tool on path for visual inspection
- `browse_wait_for_user` -- Handoff to user via takeover web URL, wait until user returns control
- `browse_go_back` -- Browser back button
- `browse_extract_file` -- Extract a file from CUA sandbox to agent (for sending via `send_file`)
- `browse_upload_file` -- Upload a file from agent into CUA sandbox (e.g., Telegram attachment → browser)
- `browse_evaluate` -- Present for backward compatibility; currently unsupported in CUA mode
- `browse_close` -- Close browser page

#### `browse_perform` Examples

Edit a spreadsheet cell (double-click → select all → type → confirm):
```json
{ "steps": [
  { "action": "double_click", "x": 240, "y": 438 },
  { "action": "wait", "ms": 300 },
  { "action": "key", "key": "ctrl+a" },
  { "action": "type", "text": "17:00" },
  { "action": "key", "key": "enter" }
]}
```

Single keyboard shortcut: `{ "steps": [{ "action": "key", "key": "ctrl+s" }] }`

Supported actions: `click`, `double_click`, `right_click`, `key`, `type`, `scroll`, `drag`, `hover`, `wait`. Key combos use `+`: `ctrl+a`, `shift+enter`, `alt+tab`, `f2`, `delete`, `escape`, etc.

### Web Crawling (Firecrawl)

- `firecrawl_scrape` -- Single page to markdown (50KB max)
- `firecrawl_crawl` -- Multi-page crawl with depth/limit (100KB max)
- `firecrawl_map` -- Discover all URLs on a domain

### Long-term Memory (Supermemory)

- `memory_save` -- Explicitly save a note/fact to long-term memory
- `memory_search` -- Search past memories and conversations

Requires `SUPERMEMORY_API_KEY`. When enabled, memories are also automatically retrieved before each agent invocation and stored after each response.

### Built-in Claude Tools (Anthropic provider only)

- `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebSearch`, `WebFetch`

**Note:** When using the OpenAI provider, agents have access to IPC tools only (send_message, browse_*, firecrawl_*, memory_*, schedule_task, etc.) via function calling. Filesystem tools (Bash, Read, Write, Edit, etc.) are Claude Agent SDK-specific and not available with OpenAI.

## Skills

| Skill            | When to Use                                                    |
| ---------------- | -------------------------------------------------------------- |
| `/setup`         | First-time installation, authentication, service configuration |
| `/deploy`        | Deploy NanoClaw service on macOS (launchd) or Linux (systemd)  |
| `/customize`     | Adding channels, integrations, changing behavior               |
| `/commit`        | Commit/push with secret scanning and co-author credits         |
| `/pr`            | Create a pull request (branches off main if needed)            |
| `/restart`       | Restart the NanoClaw background service                        |
| `/logs`          | View recent logs, errors, or follow live output                |
| `/voice`         | Configure TTS voice (design, preset, or clone from audio)      |
| `/debug`         | Container issues, logs, troubleshooting                        |
| `/add-gmail`     | Add Gmail integration to a group                               |
| `/add-parallel`  | Add Parallel AI integration                                    |
| `/x-integration` | X (Twitter) integration                                        |

## Environment Variables

### Required

| Variable             | Purpose                       |
| -------------------- | ----------------------------- |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather     |
| `TELEGRAM_OWNER_ID`  | Your numeric Telegram user ID |

### AI Auth (choose one, or leave empty for keychain auto-detect)

| Variable                  | Purpose                                            |
| ------------------------- | -------------------------------------------------- |
| `ANTHROPIC_API_KEY`       | Standard API key from console.anthropic.com        |
| `CLAUDE_CODE_OAUTH_TOKEN` | OAuth token (auto-detected from keychain if empty) |

### AI Provider Defaults

| Variable           | Default      | Purpose                                                                 |
| ------------------ | ------------ | ----------------------------------------------------------------------- |
| `DEFAULT_PROVIDER` | `anthropic`  | Default provider for groups without explicit `providerConfig`            |
| `DEFAULT_MODEL`    | (empty)      | Default model override (e.g. `claude-sonnet-4-5-20250929`, `gpt-4o`)    |

### Optional

| Variable                    | Default                  | Purpose                                         |
| --------------------------- | ------------------------ | ------------------------------------------------ |
| `OPENAI_API_KEY`            | --                       | OpenAI provider API key                          |
| `OPENAI_BASE_URL`           | --                       | Custom OpenAI-compatible API endpoint            |
| `OPENAI_REASONING_EFFORT`   | `medium`                 | Reasoning effort for OpenAI reasoning models (`low`, `medium`, `high`) |
| `ANTHROPIC_BASE_URL`        | --                       | Custom Anthropic-compatible API endpoint         |
| `REPLICATE_API_TOKEN`       | --                       | Replicate API (transcription, TTS, OmniParser)   |
| `FIRECRAWL_API_KEY`         | --                       | Firecrawl web scraping                  |
| `SUPERMEMORY_API_KEY`       | --                       | Supermemory long-term memory (preferred) |
| `SUPERMEMORY_OPENCLAW_API_KEY` | --                    | Supermemory key alias (accepted fallback) |
| `SUPERMEMORY_CC_API_KEY`    | --                       | Supermemory key alias (accepted fallback) |
| `QWEN_TTS_ENABLED`         | `false`                  | Enable Qwen3-TTS (`true`)               |
| `QWEN_TTS_URL`             | --                       | TTS server URL (e.g. `http://100.x.x.x:8787`) |
| `QWEN_TTS_API_KEY`         | --                       | TTS server Bearer token                 |
| `QWEN_TTS_DEFAULT_LANGUAGE` | `English`                | Default TTS language                    |
| `QWEN_TTS_DEFAULT_SPEAKER`  | `Vivian`                 | Default preset speaker                  |
| `QWEN_TTS_RATE_LIMIT_PER_MIN`| `10`                   | Max TTS requests per minute             |
| `REPLICATE_TTS_ENABLED`     | `true`                   | Replicate-hosted TTS (set `false` to disable) |
| `REPLICATE_TTS_RATE_LIMIT_PER_MIN`| `10`               | Max Replicate TTS requests per minute   |
| `REPLICATE_TTS_TIMEOUT_MS`  | `120000`                 | Replicate TTS request timeout (ms)      |
| `REPLICATE_TTS_DEFAULT_PROVIDER`| `qwen/qwen3-tts`     | Default Replicate TTS provider          |
| `REPLICATE_TTS_DEFAULT_SPEAKER`| `Vivian`               | Default Replicate TTS preset speaker    |
| `FREYA_TTS_ENABLED`         | `false`                  | Enable Freya TTS fallback               |
| `FREYA_API_KEY`             | --                       | Freya TTS voice synthesis (archived)    |
| `FREYA_CHARACTER_ID`        | `Amika2`                 | Freya TTS character voice               |
| `FREYA_LANGUAGE`            | `English`                | Freya TTS language                      |
| `ASSISTANT_NAME`            | `Andy`                   | Bot trigger name (`@Name`)              |
| `CONTAINER_IMAGE`           | `nanoclaw-agent:latest`  | Docker image for agent containers       |
| `CONTAINER_TIMEOUT`         | `300000` (5 min)         | Container execution timeout (ms)        |
| `CONTAINER_MAX_OUTPUT_SIZE` | `10485760` (10MB)        | Max container stdout/stderr             |
| `SANDBOX_IDLE_TIMEOUT_MS`   | `1800000`                | Sandbox auto-stop timeout               |
| `SANDBOX_TAILSCALE_ENABLED` | `true`                   | Use Tailscale IP for wait-for-user URLs |
| `CUA_TAKEOVER_WEB_ENABLED`  | `true`                   | Enable CUA takeover web UI              |
| `CUA_TAKEOVER_WEB_PORT`     | `7788`                   | Host port for CUA takeover web UI       |
| `CUA_SANDBOX_IMAGE`         | `trycua/cua-xfce:latest` | CUA Docker image                        |
| `CUA_SANDBOX_PLATFORM`      | `linux/amd64`            | Docker platform for CUA image pull/run  |
| `CUA_SANDBOX_COMMAND_PORT`  | `8000`                   | Host port for CUA `/cmd` API            |
| `CUA_SANDBOX_VNC_PORT`      | `5901`                   | Host port for CUA VNC                   |
| `CUA_SANDBOX_NOVNC_PORT`    | `6901`                   | Host port for CUA noVNC live view       |
| `CUA_SANDBOX_SCREEN_WIDTH`  | `1024`                   | CUA desktop width                       |
| `CUA_SANDBOX_SCREEN_HEIGHT` | `768`                    | CUA desktop height                      |
| `CUA_SANDBOX_SCREEN_DEPTH`  | `24`                     | CUA desktop color depth                 |
| `CUA_SANDBOX_SHM_SIZE`      | `512m`                   | Shared memory for Chromium stability    |
| `CUA_SANDBOX_PERSIST`       | `true`                   | Persist sandbox state across restarts   |
| `CUA_SANDBOX_HOME_VOLUME`   | `nanoclaw-cua-home`      | Docker volume for CUA home dir          |
| `CUA_API_KEY`               | --                       | Optional CUA API key passed to sandbox  |
| `OMNIPARSER_ENABLED`        | `false`                  | Enable OmniParser vision-based element detection (replaces a11y tree) |
| `OMNIPARSER_BOX_THRESHOLD`  | `0.05`                   | Detection confidence threshold          |
| `OMNIPARSER_IOU_THRESHOLD`  | `0.1`                    | IOU threshold for box deduplication     |
| `OMNIPARSER_TIMEOUT_MS`     | `10000`                  | Request timeout (ms), falls back to a11y tree on timeout |
| `MAX_THINKING_TOKENS`       | `10000`                  | Claude extended thinking token budget   |
| `VOICE_CALL_ENABLED`        | `false`                  | Enable voice call support               |
| `VOICE_SIDECAR_IMAGE`       | `nanoclaw-voice-sidecar:latest` | Docker image for voice sidecar    |
| `VOICE_SIDECAR_CONTAINER_NAME`| `nanoclaw-voice-sidecar` | Docker container name for sidecar     |
| `VOICE_SIDECAR_API_PORT`    | `8100`                   | Host port for sidecar FastAPI           |
| `VOICE_CALLBACK_PORT`       | `8101`                   | Host port for utterance callbacks       |
| `VOICE_CALL_IDLE_TIMEOUT_MS`| `600000`                 | Auto-leave after inactivity (10 min)    |
| `VOICE_VAD_SILENCE_MS`      | `1500`                   | Silence threshold for speech detection  |
| `TELEGRAM_API_ID`           | --                       | MTProto API ID (https://my.telegram.org)|
| `TELEGRAM_API_HASH`         | --                       | MTProto API hash                        |
| `LOG_LEVEL`                 | `info`                   | Pino log level                          |
| `TZ`                        | system                   | Timezone for scheduled tasks            |

## Data Directory Structure

```
data/
  sessions/{group}/.claude/   # Per-group Claude SDK sessions
  ipc/{group}/                # Per-group IPC namespaces
    messages/                 # Outgoing message files
    tasks/                    # Task scheduling files
    browse/                   # Browse request/response files
    current_tasks.json        # Tasks snapshot (host writes, agent reads)
    available_groups.json     # Groups snapshot (main only)
  env/env                     # Resolved credentials for containers
  router_state.json           # Last timestamp cursors
  sessions.json               # Session ID mapping per group
  registered_groups.json      # Group registration data
store/
  messages.db                 # SQLite database
logs/
  nanoclaw.log                # stdout (launchd)
  nanoclaw.error.log          # stderr (launchd)
```

## Group Isolation

- Each group gets its own folder, session directory, and IPC namespace
- Non-main groups: read-only access to `groups/global/`, no project root access
- Main group: full project root mounted, can register groups and schedule cross-group tasks
- IPC authorization: host verifies source group directory before processing

## Development

Run commands directly -- don't tell the user to run them.

```bash
bun dev                      # Run with hot reload (--watch)
bun run build                # Compile TypeScript
./container/build.sh         # Rebuild agent container
docker pull --platform linux/amd64 trycua/cua-xfce:latest # Pull/update CUA sandbox image
bun run setup:tts            # Set up TTS server (uv sync)
bun run dev:tts              # Run TTS server locally (uv run)
./tts-server/deploy.sh user@host  # Deploy TTS to remote machine
```

### TTS Server (`tts-server/`)

Python FastAPI server managed with [uv](https://docs.astral.sh/uv/). Uses `pyproject.toml` for dependencies — no manual venv management needed.

```bash
bun run setup:tts            # Equivalent to: cd tts-server && uv sync
bun run dev:tts              # Equivalent to: cd tts-server && uv run server.py
```

Service management (production via launchd):

```bash
# Template at launchd/com.nanoclaw.plist (replace {{placeholders}})
# Install to ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
```

## Message Format

Messages are formatted as XML for the agent prompt:

```xml
<messages>
<message sender="Name" time="2026-02-07T..." media_type="photo" media_path="/workspace/group/media/file.jpg">content</message>
</messages>
```

Content is XML-escaped. Media attributes are optional. Bot's own messages (prefixed with `ASSISTANT_NAME:`) are filtered out.
