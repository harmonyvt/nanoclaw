"""PCM / WAV conversion and resampling utilities for voice call sidecar."""

import io
import struct
import wave
from typing import Optional

import numpy as np
import torchaudio


def pcm_to_wav(pcm_bytes: bytes, sample_rate: int = 48000, channels: int = 1) -> bytes:
    """Wrap raw 16-bit PCM in a WAV container."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)  # 16-bit
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_bytes)
    return buf.getvalue()


def wav_to_pcm(wav_bytes: bytes) -> tuple[bytes, int, int]:
    """Extract raw PCM bytes, sample rate, and channels from WAV data."""
    buf = io.BytesIO(wav_bytes)
    with wave.open(buf, "rb") as wf:
        sample_rate = wf.getframerate()
        channels = wf.getnchannels()
        pcm = wf.readframes(wf.getnframes())
    return pcm, sample_rate, channels


def resample_pcm(
    pcm_bytes: bytes,
    from_rate: int,
    to_rate: int,
    channels: int = 1,
) -> bytes:
    """Resample 16-bit PCM from one sample rate to another."""
    if from_rate == to_rate:
        return pcm_bytes
    samples = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    import torch

    tensor = torch.from_numpy(samples).unsqueeze(0)
    resampled = torchaudio.functional.resample(tensor, from_rate, to_rate)
    out = (resampled.squeeze(0).numpy() * 32768.0).clip(-32768, 32767).astype(np.int16)
    return out.tobytes()


def wav_to_pcm_48k_mono(wav_bytes: bytes) -> bytes:
    """Convert any WAV to 48kHz 16-bit mono PCM (pytgcalls input format)."""
    pcm, rate, channels = wav_to_pcm(wav_bytes)
    if channels > 1:
        # Mix down to mono
        samples = np.frombuffer(pcm, dtype=np.int16).reshape(-1, channels)
        pcm = samples.mean(axis=1).astype(np.int16).tobytes()
    return resample_pcm(pcm, rate, 48000, channels=1)


def pcm_48k_to_wav_16k(pcm_bytes: bytes) -> bytes:
    """Convert 48kHz mono PCM to 16kHz WAV (for STT)."""
    resampled = resample_pcm(pcm_bytes, 48000, 16000, channels=1)
    return pcm_to_wav(resampled, sample_rate=16000, channels=1)
