"""
Voice call sidecar — FastAPI server for pytgcalls voice chat integration.

Endpoints:
  POST /join    — Join a group voice chat
  POST /leave   — Leave the current voice chat
  GET  /status  — Current call state
  POST /play    — Play WAV audio in voice chat
  GET  /health  — Readiness check

Environment variables:
  TELEGRAM_BOT_TOKEN   — Bot token
  TELEGRAM_API_ID      — MTProto API ID from https://my.telegram.org
  TELEGRAM_API_HASH    — MTProto API hash
  HOST_CALLBACK_URL    — URL to POST utterances to (e.g. http://host:8101/voice-utterance)
  VAD_SILENCE_MS       — Silence threshold for VAD (default 1500)
"""

import asyncio
import io
import logging
import os
import struct
import tempfile
import time
from contextlib import asynccontextmanager
from typing import Optional

import httpx
import numpy as np
from fastapi import FastAPI, HTTPException, UploadFile, File
from pydantic import BaseModel
from pyrogram import Client as PyrogramClient
from pytgcalls import PyTgCalls
from pytgcalls.types import AudioPiped, AudioParameters
from pytgcalls.types.input_stream import InputAudioStream
from pytgcalls.types.input_stream.quality import HighQualityAudio

from audio import pcm_to_wav, pcm_48k_to_wav_16k, wav_to_pcm_48k_mono
from vad import VoiceActivityDetector

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("voice-sidecar")

# ─── Config ───────────────────────────────────────────────────────────────────

BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
API_ID = int(os.environ.get("TELEGRAM_API_ID", "0"))
API_HASH = os.environ.get("TELEGRAM_API_HASH", "")
HOST_CALLBACK_URL = os.environ.get("HOST_CALLBACK_URL", "http://host.docker.internal:8101/voice-utterance")
VAD_SILENCE_MS = int(os.environ.get("VAD_SILENCE_MS", "1500"))

# ─── State ────────────────────────────────────────────────────────────────────

pyrogram_client: Optional[PyrogramClient] = None
pytgcalls_client: Optional[PyTgCalls] = None
http_client: Optional[httpx.AsyncClient] = None

call_state = {
    "active": False,
    "chat_id": 0,
    "joined_at": None,
    "last_speech_at": None,
    "utterances_sent": 0,
    "playbacks": 0,
}

vad: Optional[VoiceActivityDetector] = None
_recording_task: Optional[asyncio.Task] = None
_play_lock = asyncio.Lock()
_active_fifo_path: Optional[str] = None
_fifo_writer_task: Optional[asyncio.Task] = None
_fifo_pcm_queue: Optional[asyncio.Queue] = None


# ─── Helpers ──────────────────────────────────────────────────────────────────

async def send_utterance_to_host(pcm_48k: bytes):
    """Convert utterance to 16kHz WAV and POST to host callback."""
    global http_client
    if not http_client:
        return
    wav_bytes = pcm_48k_to_wav_16k(pcm_48k)
    call_state["last_speech_at"] = time.time()
    call_state["utterances_sent"] += 1

    log.info(f"Sending utterance ({len(wav_bytes)} bytes WAV) to host")
    try:
        files = {"audio": ("utterance.wav", wav_bytes, "audio/wav")}
        data = {"chat_id": str(call_state["chat_id"])}
        resp = await http_client.post(HOST_CALLBACK_URL, files=files, data=data, timeout=30.0)
        if resp.status_code != 200:
            log.error(f"Host callback returned {resp.status_code}: {resp.text[:200]}")
    except Exception as e:
        log.error(f"Failed to send utterance to host: {e}")


# ─── pytgcalls audio stream handler ──────────────────────────────────────────

def on_audio_frame(frame: bytes):
    """Called by pytgcalls with raw PCM audio from the voice chat."""
    if vad is None:
        return
    utterance_pcm = vad.feed(frame)
    if utterance_pcm is not None:
        # Schedule async callback
        loop = asyncio.get_event_loop()
        loop.create_task(send_utterance_to_host(utterance_pcm))


# ─── FIFO-based audio playback ───────────────────────────────────────────────

async def _fifo_writer_loop(fifo_path: str, queue: asyncio.Queue):
    """Background task that writes PCM chunks to the FIFO pipe."""
    try:
        fd = os.open(fifo_path, os.O_WRONLY)
        try:
            while True:
                chunk = await queue.get()
                if chunk is None:  # sentinel to stop
                    break
                os.write(fd, chunk)
        finally:
            os.close(fd)
    except Exception as e:
        log.error(f"FIFO writer error: {e}")


# ─── Lifespan ─────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global http_client
    http_client = httpx.AsyncClient()
    log.info("Voice sidecar starting up")
    yield
    log.info("Voice sidecar shutting down")
    if call_state["active"]:
        await _leave_call()
    if http_client:
        await http_client.aclose()
        http_client = None


app = FastAPI(lifespan=lifespan)


# ─── Models ───────────────────────────────────────────────────────────────────

class JoinRequest(BaseModel):
    chat_id: int


class PlayRequest(BaseModel):
    pass  # audio sent as file upload


# ─── Endpoints ────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "call_active": call_state["active"]}


@app.get("/status")
async def status():
    return call_state


@app.post("/join")
async def join(req: JoinRequest):
    global pyrogram_client, pytgcalls_client, vad

    if call_state["active"]:
        raise HTTPException(400, "Already in a call")

    if not BOT_TOKEN or not API_ID or not API_HASH:
        raise HTTPException(500, "Missing TELEGRAM_BOT_TOKEN, TELEGRAM_API_ID, or TELEGRAM_API_HASH")

    log.info(f"Joining voice chat in chat_id={req.chat_id}")

    try:
        # Initialize Pyrogram client with bot token
        pyrogram_client = PyrogramClient(
            "voice_bot",
            api_id=API_ID,
            api_hash=API_HASH,
            bot_token=BOT_TOKEN,
            in_memory=True,
        )

        pytgcalls_client = PyTgCalls(pyrogram_client)

        # Initialize VAD
        vad = VoiceActivityDetector(
            silence_threshold_ms=VAD_SILENCE_MS,
            on_utterance=None,  # We handle in on_audio_frame
        )

        await pyrogram_client.start()
        await pytgcalls_client.start()

        # Register incoming audio handler
        @pytgcalls_client.on_raw_update()
        async def on_raw(client, update):
            # pytgcalls raw updates include audio frames
            pass

        # Join the group call with audio recording enabled
        # pytgcalls joins with an audio stream; we use a silent input initially
        # and capture incoming audio via the stream handler
        await pytgcalls_client.join_group_call(
            req.chat_id,
            AudioPiped(
                "/dev/zero",
                AudioParameters(bitrate=48000, channels=1),
            ),
            stream_type=pytgcalls.types.StreamType().pulse_stream,
        )

        call_state.update({
            "active": True,
            "chat_id": req.chat_id,
            "joined_at": time.time(),
            "last_speech_at": None,
            "utterances_sent": 0,
            "playbacks": 0,
        })

        log.info(f"Joined voice chat in chat_id={req.chat_id}")
        return {"status": "joined", "chat_id": req.chat_id}

    except Exception as e:
        log.error(f"Failed to join voice chat: {e}")
        await _cleanup_clients()
        raise HTTPException(500, f"Failed to join: {str(e)}")


@app.post("/leave")
async def leave():
    if not call_state["active"]:
        raise HTTPException(400, "Not in a call")
    await _leave_call()
    return {"status": "left"}


@app.post("/play")
async def play(audio: UploadFile = File(...)):
    """Receive WAV audio and stream it into the voice chat."""
    if not call_state["active"] or not pytgcalls_client:
        raise HTTPException(400, "Not in a call")

    wav_bytes = await audio.read()
    if not wav_bytes:
        raise HTTPException(400, "Empty audio file")

    async with _play_lock:
        try:
            # Convert WAV to 48kHz mono PCM for pytgcalls
            pcm_48k = wav_to_pcm_48k_mono(wav_bytes)

            # Write to a temp file for pytgcalls AudioPiped
            with tempfile.NamedTemporaryFile(suffix=".raw", delete=False) as f:
                f.write(pcm_48k)
                raw_path = f.name

            # Stream the audio into the call
            await pytgcalls_client.change_stream(
                call_state["chat_id"],
                AudioPiped(
                    raw_path,
                    AudioParameters(bitrate=48000, channels=1),
                ),
            )

            call_state["playbacks"] += 1
            duration_ms = len(pcm_48k) / (48000 * 2) * 1000  # 16-bit mono
            log.info(f"Playing audio ({duration_ms:.0f}ms)")

            # Wait for playback to finish, then switch back to silence
            await asyncio.sleep(duration_ms / 1000 + 0.5)

            await pytgcalls_client.change_stream(
                call_state["chat_id"],
                AudioPiped(
                    "/dev/zero",
                    AudioParameters(bitrate=48000, channels=1),
                ),
            )

            # Clean up temp file
            try:
                os.unlink(raw_path)
            except OSError:
                pass

            return {"status": "played", "duration_ms": int(duration_ms)}

        except Exception as e:
            log.error(f"Playback failed: {e}")
            raise HTTPException(500, f"Playback failed: {str(e)}")


# ─── Internal ─────────────────────────────────────────────────────────────────

async def _leave_call():
    global vad
    log.info("Leaving voice chat")

    if pytgcalls_client and call_state["active"]:
        try:
            await pytgcalls_client.leave_group_call(call_state["chat_id"])
        except Exception as e:
            log.warning(f"Error leaving group call: {e}")

    if vad:
        vad.reset()
        vad = None

    await _cleanup_clients()

    call_state.update({
        "active": False,
        "chat_id": 0,
        "joined_at": None,
    })
    log.info("Left voice chat")


async def _cleanup_clients():
    global pyrogram_client, pytgcalls_client
    if pytgcalls_client:
        try:
            await pytgcalls_client.stop()
        except Exception:
            pass
        pytgcalls_client = None
    if pyrogram_client:
        try:
            await pyrogram_client.stop()
        except Exception:
            pass
        pyrogram_client = None


# ─── Main ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8100, log_level="info")
