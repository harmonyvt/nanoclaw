---
name: deploy-tts
description: Deploy or redeploy the Qwen3-TTS server for voice synthesis. Use when user wants to set up TTS, deploy to a GPU machine, test voice synthesis, or update the running TTS service.
---

# Deploy Qwen3-TTS Server

Deploy the self-hosted Qwen3-TTS server to a local or remote machine. Run commands directly.

## 1. Choose Target

Ask the user where to deploy:
- **Local**: Run directly on this machine
- **Remote**: Deploy via SSH to another machine (e.g. a Tailscale node with a GPU)

## 2a. Local Deploy

```bash
cd tts-server
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Optional (CUDA only):
```bash
pip install flash-attn --no-build-isolation
```

Start the server:
```bash
export TTS_API_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')
echo "API Key: $TTS_API_KEY"
python server.py
```

## 2b. Remote Deploy via SSH

```bash
./tts-server/deploy.sh user@hostname [optional-api-key]
```

This script:
1. Rsyncs `tts-server/` to `~/nanoclaw-tts/` on the target
2. Creates Python venv + installs dependencies
3. Installs flash-attn on CUDA systems automatically
4. Installs ffmpeg if missing
5. Sets up launchd (macOS) or systemd (Linux) service
6. Generates an API key if not provided

## 3. Configure NanoClaw

After deploy, set in `.env`:

```
QWEN_TTS_ENABLED=true
QWEN_TTS_URL=http://<host-ip>:8787
QWEN_TTS_API_KEY=<key-from-deploy-output>
```

## 4. Test

Health check:
```bash
curl http://<host-ip>:8787/health
```

Synthesize test audio:
```bash
curl -X POST http://<host-ip>:8787/synthesize \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <api-key>" \
  -d '{"text":"Hello! This is a test.","mode":"custom_voice","speaker":"Vivian"}' \
  -o /tmp/test.ogg
```

## 5. Restart NanoClaw

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw 2>/dev/null || echo "Service not installed (use /deploy)"

# Or foreground: bun dev
```

## Troubleshooting

### Server not responding
Check service status:
```bash
# macOS
launchctl list | grep nanoclaw-tts

# Linux
systemctl --user status nanoclaw-tts
```

Check logs:
```bash
# macOS
tail -50 ~/nanoclaw-tts/logs/tts.log

# Linux
journalctl --user -u nanoclaw-tts -n 50
```

### GPU not detected
Check `/health` endpoint — `device` field shows `cuda`, `mps`, or `cpu`. If wrong device, ensure PyTorch is installed with the correct backend.

### Redeploy after changes
Re-run the deploy script. It rsyncs updated files and restarts the service automatically.
