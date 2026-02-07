---
name: debug
description: Debug container agent issues. Use when things aren't working, container fails, authentication problems, or to understand how the container system works. Covers logs, environment variables, mounts, and common issues.
---

# NanoClaw Container Debugging

This guide covers debugging the containerized agent execution system.

## Architecture Overview

```
Host (macOS)                          Container (Linux, Docker)
─────────────────────────────────────────────────────────────
src/container-runner.ts               container/agent-runner/
    │                                      │
    │ spawns Docker container              │ runs Claude Agent SDK
    │ with volume mounts                   │ with MCP servers
    │                                      │
    ├── data/env/env ──────────────> /workspace/env-dir/env
    ├── groups/{folder} ───────────> /workspace/group
    ├── data/ipc/{folder} ────────> /workspace/ipc
    ├── data/sessions/{folder}/.claude/ ──> /home/bun/.claude/ (isolated per-group)
    └── (main only) project root ──> /workspace/project
```

**Important:** The container runs as user `bun` with `HOME=/home/bun`. Session files must be mounted to `/home/bun/.claude/` (not `/root/.claude/`) for session resumption to work.

## Container Modes

NanoClaw runs agents in two modes:

### Persistent Mode (default)
Long-lived Docker containers per group. Agent process stays alive between messages, eliminating ~3s startup overhead.

- Container started on first message, kept alive for 10 minutes of inactivity
- Communication via file-based IPC: host writes `agent-input/req-*.json`, agent writes `agent-output/res-*.json`
- Health monitored via heartbeat file at `data/ipc/{group}/agent-heartbeat`
- Falls back to one-shot mode if persistent container fails to start

### One-Shot Mode (fallback)
Spawns a new `docker run -i --rm` per message via stdin/stdout. Used when `NANOCLAW_ONESHOT=1` or persistent mode fails.

## Log Locations

| Log | Location | Content |
|-----|----------|---------|
| **Main app logs** | `logs/nanoclaw.log` | Host-side routing, message handling, container spawning |
| **Main app errors** | `logs/nanoclaw.error.log` | Host-side errors |
| **Container run logs** | `groups/{folder}/logs/container-*.log` | Per-run: input, mounts, stderr, stdout |
| **Container live logs** | `docker logs <container-id>` | Real-time container stderr |

## Enabling Debug Logging

Set `LOG_LEVEL=debug` for verbose output:

```bash
# For development
LOG_LEVEL=debug bun dev

# For launchd service, add to plist EnvironmentVariables:
<key>LOG_LEVEL</key>
<string>debug</string>
```

Debug level shows:
- Full mount configurations
- Container command arguments
- Real-time container stderr
- IPC file operations

## Persistent Container Debugging

### Check running containers
```bash
# List NanoClaw agent containers
docker ps --filter "ancestor=nanoclaw-agent:latest"

# List all NanoClaw containers (including sandbox)
docker ps --filter "name=nanoclaw"
```

### Check heartbeat
```bash
# Is the agent process alive?
cat data/ipc/main/agent-heartbeat
# Should show recent timestamp (< 30 seconds old)
```

### Check IPC directories
```bash
# Pending input files (host -> agent)
ls -la data/ipc/main/agent-input/

# Pending output files (agent -> host)
ls -la data/ipc/main/agent-output/

# Status events (agent -> host, for /verbose mode)
ls -la data/ipc/main/status/
```

### View container logs
```bash
# Get container ID
CONTAINER_ID=$(docker ps -q --filter "ancestor=nanoclaw-agent:latest" | head -1)

# View live logs
docker logs -f $CONTAINER_ID

# View last 50 lines
docker logs --tail 50 $CONTAINER_ID
```

### Force one-shot mode
```bash
# If persistent containers are misbehaving
NANOCLAW_ONESHOT=1 bun dev
```

## Browser Sandbox Debugging

The browser sandbox is a persistent Docker sidecar running Chromium on a virtual display.

### Check sandbox status
```bash
# Is sandbox running?
docker ps --filter "name=nanoclaw-sandbox"

# Check CDP endpoint
curl -s http://localhost:9222/json/version | jq .

# Check noVNC
curl -sf http://localhost:6080 > /dev/null && echo "noVNC OK" || echo "noVNC not reachable"
```

### View sandbox logs
```bash
docker logs nanoclaw-sandbox
docker logs --tail 50 nanoclaw-sandbox
```

### Restart sandbox
```bash
docker stop nanoclaw-sandbox
docker rm nanoclaw-sandbox
# Sandbox will auto-start on next browse_* tool call
```

### Rebuild sandbox
```bash
./container/sandbox/build.sh
```

### Access via noVNC
Open `http://localhost:6080` (or Tailscale IP) in your browser to see the virtual display.

## Common Issues

### 1. "Claude Code process exited with code 1"

**Check the container log file** in `groups/{folder}/logs/container-*.log`

Common causes:

#### Missing Authentication
```
Invalid API key · Please run /login
```
**Fix:** NanoClaw resolves credentials in this order:

1. **Auto-detected (recommended):** Log in to Claude Code on the host — NanoClaw reads `~/.claude/.credentials.json` automatically:
   ```bash
   claude login
   ```
2. **Manual `.env`:** Set either OAuth token or API key in `.env`:
   ```bash
   cat .env  # Should show one of:
   # CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...  (subscription)
   # ANTHROPIC_API_KEY=sk-ant-api03-...        (pay-per-use)
   ```

Check which source NanoClaw is using:
```bash
grep "credentials resolved" logs/nanoclaw.log | tail -3
```

#### Root User Restriction
```
--dangerously-skip-permissions cannot be used with root/sudo privileges
```
**Fix:** Container must run as non-root user. Check Dockerfile has `USER bun`.

### 2. Environment Variables Not Passing

The system extracts auth variables (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`) and utility keys (`OPENAI_API_KEY`, `FIRECRAWL_API_KEY`) from `.env` and writes them to `data/env/env`, which is mounted read-only into the container.

To verify env vars are reaching the container:
```bash
docker run --rm \
  --mount type=bind,source=$(pwd)/data/env,target=/workspace/env-dir,readonly \
  --entrypoint /bin/bash nanoclaw-agent:latest \
  -c 'source /workspace/env-dir/env; echo "OAuth: ${#CLAUDE_CODE_OAUTH_TOKEN} chars, API: ${#ANTHROPIC_API_KEY} chars"'
```

### 3. Mount Issues

To check what's mounted inside a container:
```bash
docker run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c 'ls -la /workspace/'
```

Expected structure:
```
/workspace/
├── env-dir/env           # Environment file (credentials)
├── group/                # Current group folder (cwd)
├── project/              # Project root (main channel only)
├── global/               # Global CLAUDE.md (non-main only, read-only)
├── ipc/                  # Inter-process communication
│   ├── messages/         # Outgoing messages
│   ├── tasks/            # Scheduled task commands
│   ├── status/           # Agent status events (for /verbose)
│   ├── agent-input/      # Persistent mode: host -> agent
│   ├── agent-output/     # Persistent mode: agent -> host
│   ├── browse/           # Browse request/response
│   ├── current_tasks.json    # Read-only: scheduled tasks
│   └── available_groups.json # Read-only: groups (main only)
└── extra/                # Additional custom mounts
```

### 4. Permission Issues

The container runs as user `bun` (uid 1000). Check ownership:
```bash
docker run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c '
  whoami
  ls -la /workspace/
  ls -la /app/
'
```

### 5. Session Not Resuming

The SDK looks for sessions at `$HOME/.claude/projects/`. Inside the container, `HOME=/home/bun`.

```bash
# Verify sessions mount
docker run --rm --entrypoint /bin/bash \
  -v $(pwd)/data/sessions/main/.claude:/home/bun/.claude \
  nanoclaw-agent:latest -c '
echo "HOME=$HOME"
ls -la $HOME/.claude/projects/ 2>&1 | head -5
'
```

### 6. Sandbox CDP Connection Fails

```
Failed to connect to sandbox CDP after 10 attempts
```

**Debug steps:**
```bash
# 1. Check if sandbox is running
docker ps --filter "name=nanoclaw-sandbox"

# 2. Check CDP directly
curl -s http://localhost:9222/json/version

# 3. Check sandbox logs for errors
docker logs --tail 30 nanoclaw-sandbox

# 4. Restart sandbox
docker stop nanoclaw-sandbox && docker rm nanoclaw-sandbox

# 5. Rebuild if needed
./container/sandbox/build.sh
```

## Manual Container Testing

### Test the full agent flow:
```bash
mkdir -p data/env groups/test data/ipc/test/{messages,tasks,agent-input,agent-output,status}

echo '{"prompt":"What is 2+2?","groupFolder":"test","chatJid":"tg:-100000000","isMain":false}' | \
  docker run -i --rm \
  --mount "type=bind,source=$(pwd)/data/env,target=/workspace/env-dir,readonly" \
  -v $(pwd)/groups/test:/workspace/group \
  -v $(pwd)/data/ipc/test:/workspace/ipc \
  nanoclaw-agent:latest
```

### Interactive shell in container:
```bash
docker run --rm -it --entrypoint /bin/bash nanoclaw-agent:latest
```

## Rebuilding After Changes

```bash
# Rebuild main app
bun run build

# Rebuild agent container
./container/build.sh

# Rebuild sandbox container
./container/sandbox/build.sh

# Force full rebuild (no cache)
docker builder prune -af
./container/build.sh
```

## Quick Diagnostic Script

Run this to check common issues:

```bash
echo "=== NanoClaw Diagnostic ==="

echo -e "\n1. Authentication configured?"
if [ -f .env ] && (grep -q "CLAUDE_CODE_OAUTH_TOKEN=sk-" .env || grep -q "ANTHROPIC_API_KEY=sk-" .env); then
  echo "  OK (from .env)"
elif security find-generic-password -s "Claude Code-credentials" -w &>/dev/null; then
  echo "  OK (from macOS keychain)"
elif [ -f ~/.claude/.credentials.json ] && grep -q '"accessToken"' ~/.claude/.credentials.json 2>/dev/null; then
  echo "  OK (from ~/.claude/.credentials.json)"
else
  echo "  MISSING - run 'claude login' or add credentials to .env"
fi

echo -e "\n2. Docker running?"
docker info &>/dev/null && echo "  OK" || echo "  NOT RUNNING"

echo -e "\n3. Agent image exists?"
docker image inspect nanoclaw-agent:latest &>/dev/null && echo "  OK" || echo "  MISSING - run ./container/build.sh"

echo -e "\n4. Sandbox image exists?"
docker image inspect nanoclaw-sandbox:latest &>/dev/null && echo "  OK" || echo "  MISSING - run ./container/sandbox/build.sh"

echo -e "\n5. Persistent containers running?"
AGENTS=$(docker ps -q --filter "ancestor=nanoclaw-agent:latest" | wc -l | tr -d ' ')
echo "  Agent containers: $AGENTS"
SANDBOX=$(docker ps -q --filter "name=nanoclaw-sandbox" | wc -l | tr -d ' ')
echo "  Sandbox: $SANDBOX"

echo -e "\n6. CDP reachable?"
curl -sf http://localhost:9222/json/version &>/dev/null && echo "  OK" || echo "  NOT REACHABLE (sandbox may be stopped)"

echo -e "\n7. Session mount path correct?"
grep -q "/home/bun/.claude" src/container-runner.ts 2>/dev/null && echo "  OK" || echo "  CHECK container-runner.ts"

echo -e "\n8. Groups directory?"
ls -d groups/*/ 2>/dev/null | head -5 || echo "  No groups found"

echo -e "\n9. Recent container logs?"
ls -t groups/*/logs/container-*.log 2>/dev/null | head -3 || echo "  No container logs"

echo -e "\n10. Heartbeat status?"
for hb in data/ipc/*/agent-heartbeat; do
  if [ -f "$hb" ]; then
    GROUP=$(basename $(dirname "$hb"))
    AGE=$(($(date +%s) - $(python3 -c "import json; print(int(json.load(open('$hb'))['timestamp']/1000))" 2>/dev/null || echo 0)))
    echo "  $GROUP: ${AGE}s ago"
  fi
done
[ ! -f data/ipc/*/agent-heartbeat ] 2>/dev/null && echo "  No active heartbeats"
```
