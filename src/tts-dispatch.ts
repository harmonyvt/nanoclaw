import fs from 'fs';
import path from 'path';
import {
  isQwenTTSEnabled,
  loadVoiceProfile,
  defaultVoiceProfile,
  synthesizeQwenTTS,
} from './tts-qwen.js';
import type { VoiceProfile as QwenSelfHostedProfile } from './tts-qwen.js';
import {
  isReplicateTTSEnabled,
  isReplicateTTSProvider,
  isModeSupported,
  defaultReplicateVoiceProfile,
  synthesizeReplicateTTS,
} from './tts-replicate.js';
import type { ReplicateVoiceProfile } from './tts-replicate.js';
import { GROUPS_DIR, QWEN_TTS_DEFAULT_LANGUAGE } from './config.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Unified voice profile type
// ---------------------------------------------------------------------------

export type UnifiedVoiceProfile = QwenSelfHostedProfile | ReplicateVoiceProfile;

// ---------------------------------------------------------------------------
// Profile loading
// ---------------------------------------------------------------------------

/**
 * Load a group's voice profile, supporting both self-hosted and Replicate providers.
 * Returns null on invalid/missing profile (with warning log).
 */
export function loadUnifiedVoiceProfile(
  groupFolder: string,
): UnifiedVoiceProfile | null {
  const profilePath = path.join(GROUPS_DIR, groupFolder, 'voice_profile.json');
  if (!fs.existsSync(profilePath)) return null;

  let raw: string;
  try {
    raw = fs.readFileSync(profilePath, 'utf-8');
  } catch (err) {
    logger.warn({ module: 'tts-dispatch', groupFolder, err }, 'Failed to read voice profile');
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn({ module: 'tts-dispatch', groupFolder }, 'Invalid JSON in voice profile');
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    logger.warn({ module: 'tts-dispatch', groupFolder }, 'Voice profile is not an object');
    return null;
  }

  const provider = parsed.provider as string;
  const mode = parsed.mode as string;

  // Self-hosted Qwen3-TTS — delegate to existing loader
  if (provider === 'qwen3-tts') {
    if (!isQwenTTSEnabled()) {
      logger.warn(
        { module: 'tts-dispatch', groupFolder },
        'Voice profile uses qwen3-tts but QWEN_TTS_ENABLED is false',
      );
      return null;
    }
    return loadVoiceProfile(groupFolder);
  }

  // Replicate provider
  if (!isReplicateTTSProvider(provider)) {
    logger.warn(
      { module: 'tts-dispatch', groupFolder, provider },
      'Unknown TTS provider in voice profile',
    );
    return null;
  }

  if (!isReplicateTTSEnabled()) {
    logger.warn(
      { module: 'tts-dispatch', groupFolder, provider },
      'Voice profile uses Replicate provider but REPLICATE_TTS_ENABLED is false',
    );
    return null;
  }

  if (!isModeSupported(provider, mode)) {
    logger.warn(
      { module: 'tts-dispatch', groupFolder, provider, mode },
      `Mode "${mode}" is not supported by provider "${provider}"`,
    );
    return null;
  }

  const now = '';
  const createdAt = typeof parsed.created_at === 'string' ? parsed.created_at : now;
  const updatedAt = typeof parsed.updated_at === 'string' ? parsed.updated_at : now;

  // Build provider-specific profile
  if (provider === 'qwen/qwen3-tts') {
    const profile: UnifiedVoiceProfile = {
      provider: 'qwen/qwen3-tts',
      mode: mode as 'voice_design' | 'custom_voice' | 'voice_clone',
      created_at: createdAt,
      updated_at: updatedAt,
    };

    if (mode === 'voice_design' && typeof parsed.voice_design === 'object' && parsed.voice_design) {
      const vd = parsed.voice_design as Record<string, unknown>;
      profile.voice_design = {
        description: typeof vd.description === 'string' ? vd.description : '',
        language: typeof vd.language === 'string' ? vd.language : QWEN_TTS_DEFAULT_LANGUAGE,
      };
    } else if (mode === 'custom_voice') {
      const cv = typeof parsed.custom_voice === 'object' && parsed.custom_voice
        ? parsed.custom_voice as Record<string, unknown>
        : {};
      profile.custom_voice = {
        speaker: typeof cv.speaker === 'string' ? cv.speaker : 'Vivian',
        instruct: typeof cv.instruct === 'string' ? cv.instruct : undefined,
        language: typeof cv.language === 'string' ? cv.language : QWEN_TTS_DEFAULT_LANGUAGE,
      };
    } else if (mode === 'voice_clone') {
      const vc = typeof parsed.voice_clone === 'object' && parsed.voice_clone
        ? parsed.voice_clone as Record<string, unknown>
        : {};
      profile.voice_clone = {
        ref_audio_path: typeof vc.ref_audio_path === 'string' ? vc.ref_audio_path : '',
        ref_text: typeof vc.ref_text === 'string' ? vc.ref_text : undefined,
        language: typeof vc.language === 'string' ? vc.language : QWEN_TTS_DEFAULT_LANGUAGE,
      };
    }

    return profile;
  }

  if (provider === 'resemble-ai/chatterbox-turbo') {
    const profile: UnifiedVoiceProfile = {
      provider: 'resemble-ai/chatterbox-turbo',
      mode: mode as 'custom_voice' | 'voice_clone',
      created_at: createdAt,
      updated_at: updatedAt,
    };

    if (mode === 'custom_voice') {
      const cv = typeof parsed.custom_voice === 'object' && parsed.custom_voice
        ? parsed.custom_voice as Record<string, unknown>
        : {};
      profile.custom_voice = {
        speaker: typeof cv.speaker === 'string' ? cv.speaker : 'Andy',
      };
    } else if (mode === 'voice_clone') {
      const vc = typeof parsed.voice_clone === 'object' && parsed.voice_clone
        ? parsed.voice_clone as Record<string, unknown>
        : {};
      profile.voice_clone = {
        ref_audio_path: typeof vc.ref_audio_path === 'string' ? vc.ref_audio_path : '',
      };
    }

    if (typeof parsed.extras === 'object' && parsed.extras) {
      profile.extras = parsed.extras as ChatterboxExtrasType;
    }

    return profile;
  }

  if (provider === 'minimax/speech-2.8-turbo') {
    const cv = typeof parsed.custom_voice === 'object' && parsed.custom_voice
      ? parsed.custom_voice as Record<string, unknown>
      : {};

    const profile: UnifiedVoiceProfile = {
      provider: 'minimax/speech-2.8-turbo',
      mode: 'custom_voice',
      custom_voice: {
        speaker: typeof cv.speaker === 'string' ? cv.speaker : 'Friendly_Person',
        language: typeof cv.language === 'string' ? cv.language : undefined,
      },
      created_at: createdAt,
      updated_at: updatedAt,
    };

    if (typeof parsed.extras === 'object' && parsed.extras) {
      profile.extras = parsed.extras as MinimaxExtrasType;
    }

    return profile;
  }

  return null;
}

// Private type aliases for extras casts
type ChatterboxExtrasType = NonNullable<
  Extract<ReplicateVoiceProfile, { provider: 'resemble-ai/chatterbox-turbo' }>['extras']
>;
type MinimaxExtrasType = NonNullable<
  Extract<ReplicateVoiceProfile, { provider: 'minimax/speech-2.8-turbo' }>['extras']
>;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Return a default voice profile based on which providers are enabled.
 * Priority: Replicate > self-hosted Qwen (Replicate is preferred when both enabled).
 */
export function defaultUnifiedVoiceProfile(): UnifiedVoiceProfile {
  if (isReplicateTTSEnabled()) {
    return defaultReplicateVoiceProfile();
  }
  if (isQwenTTSEnabled()) {
    return defaultVoiceProfile();
  }
  // Fallback to self-hosted default (caller will handle the disabled state)
  return defaultVoiceProfile();
}

// ---------------------------------------------------------------------------
// Enabled check
// ---------------------------------------------------------------------------

export function isTTSEnabled(): boolean {
  return isQwenTTSEnabled() || isReplicateTTSEnabled();
}

// ---------------------------------------------------------------------------
// Unified synthesis dispatcher
// ---------------------------------------------------------------------------

/**
 * Synthesize text to speech using the provider specified in the voice profile.
 * Returns the absolute path to the saved .ogg file.
 */
export async function synthesizeTTS(
  text: string,
  profile: UnifiedVoiceProfile,
  mediaDir: string,
  groupFolder: string,
): Promise<string> {
  if (profile.provider === 'qwen3-tts') {
    return synthesizeQwenTTS(text, profile, mediaDir, groupFolder);
  }

  // All providers with a '/' are Replicate-hosted
  return synthesizeReplicateTTS(text, profile as ReplicateVoiceProfile, mediaDir, groupFolder);
}
