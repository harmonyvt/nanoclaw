/**
 * TTS service — dispatches text-to-speech synthesis across providers.
 */

import { Context, Effect } from 'effect';
import type { TTSError } from '../errors.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface TTSResult {
  readonly audioPath: string;
  readonly provider: string;
  readonly durationMs: number;
}

export interface VoiceProfile {
  readonly provider?: string;
  readonly speaker?: string;
  readonly language?: string;
  readonly referenceAudio?: string;
  readonly referenceText?: string;
}

// ─── Service Interface ─────────────────────────────────────────────────────

export interface TTSService {
  /** Synthesize text to speech audio file */
  readonly synthesize: (params: {
    text: string;
    groupFolder: string;
    voiceProfile?: VoiceProfile;
    emotion?: string;
  }) => Effect.Effect<TTSResult, TTSError>;

  /** Check if any TTS provider is enabled */
  readonly isEnabled: Effect.Effect<boolean>;
}

export class TTS extends Context.Tag('TTS')<TTS, TTSService>() {}
