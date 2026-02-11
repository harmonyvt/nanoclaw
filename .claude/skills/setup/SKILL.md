---
name: setup
description: Run initial NanoClaw setup. Use when user wants to install dependencies, configure Telegram, register their main channel, or deploy/start the background service. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup (Docker + CUA)

Run commands directly. Pause only when user action is required.

## 1. Install Dependencies

```bash
bun install
```

## 2. Validate Docker Requirements

Run the built-in prerequisite checker:

```bash
./scripts/ensure-docker-requirements.sh
```

This verifies:

- Docker CLI installed
- Docker daemon running
- Agent image exists (`CONTAINER_IMAGE` / `nanoclaw-agent:latest`)
- CUA sandbox image exists or is pulled (`CUA_SANDBOX_IMAGE` / `trycua/cua-xfce:latest`)

If this fails, help the user install/start Docker and rerun the command.

## 3. Configure Authentication

Check if Claude Code credentials exist:

```bash
[ -f ~/.claude/.credentials.json ] && echo "FOUND" || echo "NOT_FOUND"
```

If found, explain NanoClaw auto-detects Claude OAuth tokens for the Anthropic provider.

If not found, ask user whether to use:

1. Claude subscription (recommended): `claude login`
2. Anthropic API key in `.env`

## 4. Configure `.env`

Create `.env` if missing:

```bash
[ -f .env ] || cp .env.example .env
```

Ensure these are set:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_OWNER_ID`

### AI Provider Configuration

Ask if they want to use a non-default AI provider or model. NanoClaw supports two providers:

- **Anthropic** (default) -- Uses Claude Agent SDK. Full tool access including Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, plus all IPC tools.
- **OpenAI** -- Uses chat completions with function calling. Access to IPC tools only (send_message, browse_*, firecrawl_*, memory_*, schedule_task, etc.).

Optional provider settings:

- `DEFAULT_PROVIDER` -- `anthropic` (default) or `openai`
- `DEFAULT_MODEL` -- Model override. Examples:
  - Anthropic: `claude-sonnet-4-5-20250929`, `claude-opus-4-20250514`, `claude-haiku-4-5-20251001`
  - OpenAI: `gpt-4o`, `o3`, `gpt-4o-mini`
- `OPENAI_API_KEY` -- Required if using OpenAI provider or Whisper transcription

Per-group provider/model can also be configured later when registering groups (the `register_group` tool accepts optional `provider` and `model` params).

### Qwen3-TTS Voice Synthesis (optional)

Ask if they want voice messages enabled. If yes:

1. Verify Modal is set up: `modal profile current`
2. Create HF token secret if needed: `modal secret create hf-token HF_TOKEN=hf_xxx`
3. Deploy the TTS app: `modal deploy modal/qwen3_tts_app.py`
4. Test it works: `modal run modal/qwen3_tts_app.py`
5. Get Modal credentials from `~/.modal.toml` and set in `.env`:
   - `QWEN_TTS_ENABLED=true`
   - `MODAL_TOKEN_ID=ak-...`
   - `MODAL_TOKEN_SECRET=as-...`

Voice profiles are auto-generated when SOUL.md is created. Users can customize via `/design_voice` in Telegram.

### Optional CUA tuning

- `CUA_SANDBOX_IMAGE`
- `CUA_SANDBOX_PLATFORM`
- `CUA_SANDBOX_COMMAND_PORT`
- `CUA_SANDBOX_VNC_PORT`
- `CUA_SANDBOX_NOVNC_PORT`
- `CUA_SANDBOX_SCREEN_WIDTH`
- `CUA_SANDBOX_SCREEN_HEIGHT`
- `CUA_SANDBOX_SCREEN_DEPTH`
- `CUA_SANDBOX_SHM_SIZE`
- `CUA_API_KEY`

## 5. Configure Assistant Name (optional)

Ask what trigger name they want (default `Andy`).
If changed, update:

- `ASSISTANT_NAME` in `.env`
- copy text in `groups/main/CLAUDE.md` if they want the persona name changed there too

## 6. Register Main Channel

Ask user to send any message to the bot from their intended main channel.

Capture and inspect recent chats:

```bash
timeout 10 bun dev || true
sqlite3 store/messages.db "SELECT DISTINCT chat_jid FROM messages WHERE chat_jid LIKE 'tg:%' ORDER BY timestamp DESC LIMIT 5"
```

Write `data/registered_groups.json` with chosen JID:

```json
{
  "JID_HERE": {
    "name": "main",
    "folder": "main",
    "trigger": "@ASSISTANT_NAME",
    "added_at": "CURRENT_ISO_TIMESTAMP"
  }
}
```

Ensure folder exists:

```bash
mkdir -p groups/main/logs
```

## 7. Configure Mount Allowlist (optional)

If they want external directories, create `~/.config/nanoclaw/mount-allowlist.json`.
If they do not, create an explicit empty allowlist:

```bash
mkdir -p ~/.config/nanoclaw
cat > ~/.config/nanoclaw/mount-allowlist.json << 'JSON'
{
  "allowedRoots": [],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
JSON
```

## 8. Deploy Service

### macOS (launchd)

Use the deployment script:

```bash
./scripts/deploy-launchd.sh
```

This runs Docker checks, builds TypeScript, writes plist from template, reloads launchd.

### Linux

Use the Linux deploy script:

```bash
bun run deploy:linux
```

This runs Docker checks, builds TypeScript, writes a user-level systemd unit, then enables/starts `com.nanoclaw.service`.

## 9. Verify

1. `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status com.nanoclaw.service` (Linux)
2. `tail -f logs/nanoclaw.log`
3. Send `@ASSISTANT_NAME hello` in Telegram
4. Test browser flow with `browse_screenshot` and confirm Telegram image arrives
5. Test `browse_wait_for_user` and confirm the returned URL opens noVNC

## Troubleshooting

- Docker daemon unavailable: start Docker Desktop (macOS) or `sudo systemctl start docker` (Linux)
- Agent image missing: `./container/build.sh`
- CUA image missing: `docker pull --platform linux/amd64 trycua/cua-xfce:latest`
- Service not running: check `logs/nanoclaw.error.log`
- No Telegram responses: validate `.env` values and `data/registered_groups.json`
