"""
silero-vad speech endpoint detection with state machine.

States: IDLE -> SPEECH_DETECTED -> COLLECTING -> SILENCE -> UTTERANCE_COMPLETE
"""

import enum
import time
from typing import Callable, Optional

import numpy as np
import torch

# silero-vad model (loaded lazily)
_vad_model = None
_vad_sr = 16000  # silero-vad expects 16kHz


def _get_vad_model():
    global _vad_model
    if _vad_model is None:
        model, _ = torch.hub.load(
            repo_or_dir="snakers4/silero-vad",
            model="silero_vad",
            trust_repo=True,
        )
        _vad_model = model
    return _vad_model


class VadState(enum.Enum):
    IDLE = "idle"
    SPEECH_DETECTED = "speech_detected"
    COLLECTING = "collecting"
    SILENCE = "silence"
    UTTERANCE_COMPLETE = "utterance_complete"


class VoiceActivityDetector:
    """
    Stateful VAD that accumulates audio frames and detects complete utterances.

    Operates on 48kHz 16-bit mono PCM input (pytgcalls format).
    Internally resamples to 16kHz for silero-vad.
    """

    def __init__(
        self,
        silence_threshold_ms: int = 1500,
        speech_threshold: float = 0.5,
        min_speech_ms: int = 300,
        on_utterance: Optional[Callable[[bytes], None]] = None,
    ):
        self.silence_threshold_ms = silence_threshold_ms
        self.speech_threshold = speech_threshold
        self.min_speech_ms = min_speech_ms
        self.on_utterance = on_utterance

        self._state = VadState.IDLE
        self._speech_buffer: list[bytes] = []
        self._speech_start_time: float = 0
        self._last_speech_time: float = 0
        self._frame_size_48k = 960  # 20ms at 48kHz (480 at 16kHz)
        self._pending_pcm = b""

    @property
    def state(self) -> VadState:
        return self._state

    def reset(self):
        """Reset state machine and discard any buffered audio."""
        self._state = VadState.IDLE
        self._speech_buffer.clear()
        self._speech_start_time = 0
        self._last_speech_time = 0
        self._pending_pcm = b""
        model = _get_vad_model()
        model.reset_states()

    def feed(self, pcm_48k: bytes) -> Optional[bytes]:
        """
        Feed 48kHz 16-bit mono PCM data.
        Returns complete utterance WAV bytes when speech ends, else None.
        """
        self._pending_pcm += pcm_48k

        # Process in 20ms frames (960 samples at 48kHz = 1920 bytes)
        frame_bytes = self._frame_size_48k * 2  # 16-bit = 2 bytes/sample
        result = None

        while len(self._pending_pcm) >= frame_bytes:
            frame = self._pending_pcm[:frame_bytes]
            self._pending_pcm = self._pending_pcm[frame_bytes:]
            result = self._process_frame(frame) or result

        return result

    def _process_frame(self, frame_48k: bytes) -> Optional[bytes]:
        """Process a single 20ms frame at 48kHz."""
        # Resample 48kHz -> 16kHz for VAD
        samples_48k = np.frombuffer(frame_48k, dtype=np.int16).astype(np.float32) / 32768.0
        # Simple 3:1 decimation (48k / 16k = 3)
        samples_16k = samples_48k[::3]
        tensor = torch.from_numpy(samples_16k)

        model = _get_vad_model()
        speech_prob = model(tensor, _vad_sr).item()
        is_speech = speech_prob > self.speech_threshold
        now = time.monotonic()

        if self._state == VadState.IDLE:
            if is_speech:
                self._state = VadState.SPEECH_DETECTED
                self._speech_start_time = now
                self._last_speech_time = now
                self._speech_buffer.clear()
                self._speech_buffer.append(frame_48k)

        elif self._state == VadState.SPEECH_DETECTED:
            self._speech_buffer.append(frame_48k)
            if is_speech:
                self._last_speech_time = now
                elapsed_ms = (now - self._speech_start_time) * 1000
                if elapsed_ms >= self.min_speech_ms:
                    self._state = VadState.COLLECTING
            else:
                silence_ms = (now - self._last_speech_time) * 1000
                if silence_ms >= self.silence_threshold_ms:
                    # False start - not enough speech
                    self._state = VadState.IDLE
                    self._speech_buffer.clear()

        elif self._state == VadState.COLLECTING:
            self._speech_buffer.append(frame_48k)
            if is_speech:
                self._last_speech_time = now
            else:
                silence_ms = (now - self._last_speech_time) * 1000
                if silence_ms >= self.silence_threshold_ms:
                    self._state = VadState.UTTERANCE_COMPLETE
                    return self._finalize_utterance()

        return None

    def _finalize_utterance(self) -> Optional[bytes]:
        """Assemble buffered frames into a complete utterance."""
        if not self._speech_buffer:
            self._state = VadState.IDLE
            return None

        pcm_48k = b"".join(self._speech_buffer)
        self._speech_buffer.clear()
        self._state = VadState.IDLE

        # Reset VAD model state between utterances
        model = _get_vad_model()
        model.reset_states()

        if self.on_utterance:
            self.on_utterance(pcm_48k)

        return pcm_48k
