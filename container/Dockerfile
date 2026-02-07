# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation
# Supports two modes:
# - One-shot (stdin): receives JSON via stdin, processes, outputs to stdout, exits
# - Persistent (NANOCLAW_PERSISTENT=1): watches IPC dir for input files, loops

FROM oven/bun:1-debian

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser and claude-code globally
# Runs as root; make /root traversable so bun user can follow symlinks in /usr/local/bin
RUN bun install -g agent-browser @anthropic-ai/claude-code \
    && chmod o+x /root \
    && chmod -R o+rX /root/.bun

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package.json agent-runner/bun.lockb ./

# Install dependencies
RUN bun install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN bun run build

# Create workspace directories (including persistent mode IPC dirs)
RUN mkdir -p /workspace/group /workspace/global /workspace/extra \
    /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/browse \
    /workspace/ipc/agent-input /workspace/ipc/agent-output

# Create entrypoint script that supports both modes:
# - If NANOCLAW_PERSISTENT=1: run agent-runner directly (it will enter persistent mode)
# - Otherwise: pipe stdin to agent-runner (one-shot mode, backward compatible)
RUN printf '#!/bin/bash\nset -e\nif [ -f /workspace/env-dir/env ]; then\n  set -a\n  source /workspace/env-dir/env\n  set +a\nfi\nif [ "${NANOCLAW_PERSISTENT}" = "1" ]; then\n  exec bun /app/dist/index.js\nelse\n  cat > /tmp/input.json\n  bun /app/dist/index.js < /tmp/input.json\nfi\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to bun user (non-root) for writable directories
RUN chown -R bun:bun /workspace

# Switch to non-root user (required for --dangerously-skip-permissions)
USER bun

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point handles both one-shot (stdin) and persistent (file-watching) modes
ENTRYPOINT ["/app/entrypoint.sh"]
