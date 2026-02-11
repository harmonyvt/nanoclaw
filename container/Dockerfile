# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux container
# Supports two modes:
# - One-shot (stdin): receives JSON via stdin, processes, outputs to stdout, exits
# - Persistent (NANOCLAW_PERSISTENT=1): watches IPC dir for input files, loops

# ── Build stage: compile TypeScript, install all deps ────────────────────────
FROM oven/bun:1-debian AS builder

WORKDIR /app

COPY agent-runner/package.json agent-runner/bun.lockb ./
RUN bun install --frozen-lockfile

COPY agent-runner/ ./
RUN bun run build

# Re-install without devDependencies for the final image
RUN rm -rf node_modules && bun install --frozen-lockfile --production

# ── Final stage: runtime only ────────────────────────────────────────────────
FROM oven/bun:1-debian

# System deps + yt-dlp in a single layer
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    ffmpeg \
    python3 \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
       -o /usr/local/bin/yt-dlp && chmod +x /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*

# Install claude-code globally (required by Claude Agent SDK query())
# Make /root traversable so bun user can follow symlinks in /usr/local/bin
RUN bun install -g @anthropic-ai/claude-code \
    && chmod o+x /root \
    && chmod -R o+rX /root/.bun

# Copy compiled app + production-only node_modules from builder
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Create workspace directories (including persistent mode IPC dirs)
RUN mkdir -p /workspace/group /workspace/global /workspace/extra \
    /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/browse \
    /workspace/ipc/agent-input /workspace/ipc/agent-output

COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Set ownership to bun user (non-root) for writable directories
RUN chown -R bun:bun /workspace

# Switch to non-root user (required for --dangerously-skip-permissions)
USER bun

# Set working directory to group workspace
WORKDIR /workspace/group

ENTRYPOINT ["/app/entrypoint.sh"]
