"""
Qwen3-TTS Server — MLX inference on Apple Silicon for voice synthesis.

Loads VoiceDesign (natural language voice descriptions), CustomVoice
(9 preset speakers), and optionally a Base model for voice cloning
via mlx-audio. Returns OGG/Opus audio.

Run locally:
    python server.py

Run with uvicorn:
    uvicorn server:app --host 0.0.0.0 --port 8787

Environment variables:
    TTS_API_KEY       — Required. Bearer token for auth.
    TTS_PORT          — Server port (default: 8787)
    TTS_HOST          — Server bind address (default: 0.0.0.0)
    TTS_CLONE_MODEL   — Model ID for voice cloning (default: 0.6B-Base)
"""

import base64
import os
import subprocess
import tempfile
import time
from contextlib import asynccontextmanager

import mlx.core as mx
import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

DEVICE_NAME = "mlx (Apple Silicon)"

API_KEY = os.environ.get("TTS_API_KEY", "")
PORT = int(os.environ.get("TTS_PORT", "8787"))
HOST = os.environ.get("TTS_HOST", "0.0.0.0")

TTS_CLONE_MODEL = os.environ.get(
    "TTS_CLONE_MODEL",
    "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16",
)

VALID_SPEAKERS = {
    "Vivian", "Serena", "Uncle_Fu", "Dylan",
    "Eric", "Ryan", "Aiden", "Ono_Anna", "Sohee",
}

VALID_LANGUAGES = {
    "Chinese", "English", "Japanese", "Korean", "German",
    "French", "Russian", "Portuguese", "Spanish", "Italian",
}

# ---------------------------------------------------------------------------
# Models (VoiceDesign + CustomVoice loaded at startup, Base lazy-loaded)
# ---------------------------------------------------------------------------

voice_design_model = None
custom_voice_model = None
voice_clone_model = None
start_time = 0.0


def get_clone_model():
    """Lazy-load the Base model for voice cloning on first use."""
    global voice_clone_model
    if voice_clone_model is None:
        from mlx_audio.tts.utils import load_model

        print(f"Loading VoiceClone model: {TTS_CLONE_MODEL}...")
        voice_clone_model = load_model(TTS_CLONE_MODEL)
        print("VoiceClone model loaded.")
    return voice_clone_model


@asynccontextmanager
async def lifespan(app: FastAPI):
    global voice_design_model, custom_voice_model, start_time
    from mlx_audio.tts.utils import load_model

    print(f"Device: {DEVICE_NAME}")
    print(f"Auth: {'enabled' if API_KEY else 'DISABLED (no TTS_API_KEY set)'}")

    print("Loading VoiceDesign model...")
    voice_design_model = load_model(
        "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16"
    )

    print("Loading CustomVoice model...")
    custom_voice_model = load_model(
        "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16"
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
    # Voice clone fields
    ref_audio_base64: str = ""
    ref_text: str = ""


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "device": DEVICE_NAME,
        "dtype": "bfloat16",
        "models_loaded": voice_design_model is not None and custom_voice_model is not None,
        "voice_clone_model_loaded": voice_clone_model is not None,
        "clone_model_id": TTS_CLONE_MODEL,
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

    # Generate audio via MLX
    if req.mode == "voice_design":
        description = req.voice_description or "A warm, friendly voice"
        results = list(voice_design_model.generate_voice_design(
            text=text,
            language=language,
            instruct=description,
            max_tokens=2400,
        ))
    elif req.mode == "voice_clone":
        clone_model = get_clone_model()
        if not req.ref_audio_base64:
            raise HTTPException(
                status_code=400,
                detail="voice_clone mode requires ref_audio_base64",
            )

        # Validate and decode base64 reference audio to temp WAV
        if len(req.ref_audio_base64) > 10_000_000:  # ~7.5MB decoded
            raise HTTPException(status_code=400, detail="ref_audio_base64 too large (max ~7.5MB)")
        audio_bytes = base64.b64decode(req.ref_audio_base64)
        ref_tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        try:
            ref_tmp.write(audio_bytes)
            ref_tmp.close()

            generate_kwargs = dict(
                text=text,
                ref_audio=ref_tmp.name,
                language=language,
                max_new_tokens=2400,
            )
            if req.ref_text.strip():
                generate_kwargs["ref_text"] = req.ref_text
            else:
                generate_kwargs["x_vector_only_mode"] = True

            results = list(clone_model.generate(**generate_kwargs))
        finally:
            os.unlink(ref_tmp.name)
    else:
        speaker = req.speaker if req.speaker in VALID_SPEAKERS else "Vivian"
        results = list(custom_voice_model.generate_custom_voice(
            text=text,
            language=language,
            speaker=speaker,
            instruct=req.instruct or "",
            max_tokens=2400,
        ))

    audio_np = np.array(results[0].audio.astype(mx.float32))
    sr = results[0].sample_rate

    # WAV → OGG/Opus via ffmpeg
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as wav_f:
        sf.write(wav_f.name, audio_np, sr)
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
                detail="ffmpeg audio conversion failed",
            )
        return Response(content=result.stdout, media_type="audio/ogg")


# ---------------------------------------------------------------------------
# Direct run
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT)
