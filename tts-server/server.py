"""
Qwen3-TTS Server — Self-hosted GPU inference for voice synthesis.

Loads both VoiceDesign (natural language voice descriptions) and CustomVoice
(9 preset speakers) models. Auto-detects CUDA / MPS / CPU. Returns OGG/Opus audio.

Run locally:
    python server.py

Run with uvicorn:
    uvicorn server:app --host 0.0.0.0 --port 8787

Environment variables:
    TTS_API_KEY     — Required. Bearer token for auth.
    TTS_PORT        — Server port (default: 8787)
    TTS_HOST        — Server bind address (default: 0.0.0.0)
"""

import os
import subprocess
import tempfile
import time
from contextlib import asynccontextmanager

import torch
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Device auto-detection
# ---------------------------------------------------------------------------

if torch.cuda.is_available():
    DEVICE = "cuda:0"
    DTYPE = torch.bfloat16
    DEVICE_NAME = f"cuda ({torch.cuda.get_device_name(0)})"
elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
    DEVICE = "mps"
    DTYPE = torch.float16  # MPS bfloat16 support is spotty
    DEVICE_NAME = "mps (Apple Silicon)"
else:
    DEVICE = "cpu"
    DTYPE = torch.float32
    DEVICE_NAME = "cpu"

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

API_KEY = os.environ.get("TTS_API_KEY", "")
PORT = int(os.environ.get("TTS_PORT", "8787"))
HOST = os.environ.get("TTS_HOST", "0.0.0.0")

VALID_SPEAKERS = {
    "Vivian", "Serena", "Uncle_Fu", "Dylan",
    "Eric", "Ryan", "Aiden", "Ono_Anna", "Sohee",
}

VALID_LANGUAGES = {
    "Chinese", "English", "Japanese", "Korean", "German",
    "French", "Russian", "Portuguese", "Spanish", "Italian",
}

# ---------------------------------------------------------------------------
# Models (loaded at startup)
# ---------------------------------------------------------------------------

voice_design_model = None
custom_voice_model = None
start_time = 0.0


@asynccontextmanager
async def lifespan(app: FastAPI):
    global voice_design_model, custom_voice_model, start_time
    from qwen_tts import Qwen3TTSModel

    print(f"Device: {DEVICE_NAME} (dtype={DTYPE})")
    print(f"Auth: {'enabled' if API_KEY else 'DISABLED (no TTS_API_KEY set)'}")

    print("Loading VoiceDesign model...")
    voice_design_model = Qwen3TTSModel.from_pretrained(
        "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
        device_map=DEVICE,
        dtype=DTYPE,
    )

    print("Loading CustomVoice model...")
    custom_voice_model = Qwen3TTSModel.from_pretrained(
        "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
        device_map=DEVICE,
        dtype=DTYPE,
    )

    start_time = time.time()
    print("Models loaded. Server ready.")

    yield

    print("Shutting down.")


app = FastAPI(title="Qwen3-TTS Server", lifespan=lifespan)

# ---------------------------------------------------------------------------
# Auth middleware
# ---------------------------------------------------------------------------


def verify_auth(request: Request):
    if not API_KEY:
        return  # No key configured — skip auth
    auth = request.headers.get("authorization", "")
    if auth != f"Bearer {API_KEY}":
        raise HTTPException(status_code=401, detail="Invalid or missing API key")


# ---------------------------------------------------------------------------
# Request schema
# ---------------------------------------------------------------------------


class SynthesizeRequest(BaseModel):
    text: str
    mode: str = "custom_voice"
    language: str = "English"
    voice_description: str = ""
    speaker: str = "Vivian"
    instruct: str = ""


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "device": DEVICE_NAME,
        "dtype": str(DTYPE),
        "models_loaded": voice_design_model is not None and custom_voice_model is not None,
        "uptime_seconds": round(time.time() - start_time, 1) if start_time else 0,
        "valid_speakers": sorted(VALID_SPEAKERS),
        "valid_languages": sorted(VALID_LANGUAGES),
    }


@app.post("/synthesize")
async def synthesize(req: SynthesizeRequest, request: Request):
    verify_auth(request)

    import soundfile as sf

    # Validate inputs
    language = req.language if req.language in VALID_LANGUAGES else "English"
    text = req.text[:2000] if len(req.text) > 2000 else req.text

    if not text.strip():
        raise HTTPException(status_code=400, detail="Text is empty")

    # Generate audio
    if req.mode == "voice_design":
        description = req.voice_description or "A warm, friendly voice"
        wavs, sr = voice_design_model.generate_voice_design(
            text=text,
            language=language,
            instruct=description,
            max_new_tokens=2400,
        )
    else:
        speaker = req.speaker if req.speaker in VALID_SPEAKERS else "Vivian"
        wavs, sr = custom_voice_model.generate_custom_voice(
            text=text,
            language=language,
            speaker=speaker,
            instruct=req.instruct or "",
            max_new_tokens=2400,
        )

    # WAV → OGG/Opus via ffmpeg
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as wav_f:
        sf.write(wav_f.name, wavs[0], sr)
        result = subprocess.run(
            [
                "ffmpeg", "-y",
                "-i", wav_f.name,
                "-c:a", "libopus",
                "-b:a", "64k",
                "-f", "ogg",
                "pipe:1",
            ],
            capture_output=True,
        )
        if result.returncode != 0:
            raise HTTPException(
                status_code=500,
                detail=f"ffmpeg conversion failed: {result.stderr.decode()[:500]}",
            )
        return Response(content=result.stdout, media_type="audio/ogg")


# ---------------------------------------------------------------------------
# Direct run
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT)
