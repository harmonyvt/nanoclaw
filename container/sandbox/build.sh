#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
docker build -t nanoclaw-sandbox:latest .
echo "Sandbox image built: nanoclaw-sandbox:latest"
