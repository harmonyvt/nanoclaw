# Qwen3-TTS Server

Self-hosted TTS inference server. Loads both Qwen3-TTS models (VoiceDesign + CustomVoice) and exposes an HTTP API. Auto-detects CUDA, MPS (Apple Silicon), or CPU.

## Quick Start (Local)

```bash
cd tts-server
uv sync

# Optional: install flash-attn on CUDA machines for faster inference
# uv pip install flash-attn --no-build-isolation

export TTS_API_KEY=your-secret-key
uv run server.py
```

Models are downloaded from HuggingFace on first run (~3.5GB each).

## Remote Deploy

```bash
./deploy.sh user@your-tailscale-host
```

This rsyncs the server, installs uv + dependencies, and sets up a launchd (macOS) or systemd (Linux) service.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `TTS_API_KEY` | (none) | Bearer token for auth. If unset, auth is disabled |
| `TTS_PORT` | `8787` | Server port |
| `TTS_HOST` | `0.0.0.0` | Bind address |

## API

### `GET /health`

Returns server status, device info, and available speakers/languages.

### `POST /synthesize`

Returns OGG/Opus audio bytes.

```json
{
  "text": "Hello world",
  "mode": "custom_voice",
  "language": "English",
  "speaker": "Vivian",
  "instruct": "",
  "voice_description": ""
}
```

**Modes:**
- `custom_voice` — use a preset speaker (Vivian, Serena, Dylan, Eric, Ryan, Aiden, Ono_Anna, Sohee, Uncle_Fu)
- `voice_design` — describe the voice in natural language via `voice_description`

**Auth:** `Authorization: Bearer <TTS_API_KEY>` header (required when `TTS_API_KEY` is set).

```bash
curl -X POST http://localhost:8787/synthesize \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-secret-key" \
  -d '{"text":"Hello!","mode":"custom_voice","speaker":"Vivian"}' \
  -o test.ogg
```
