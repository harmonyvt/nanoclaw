import fs from 'fs';
import path from 'path';
import {
  QWEN_TTS_ENABLED,
  QWEN_TTS_URL,
  QWEN_TTS_API_KEY,
  QWEN_TTS_DEFAULT_LANGUAGE,
  QWEN_TTS_DEFAULT_SPEAKER,
  QWEN_TTS_RATE_LIMIT_PER_MIN,
  GROUPS_DIR,
} from './config.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Voice profile types
// ---------------------------------------------------------------------------

export interface VoiceDesignConfig {
  description: string;
  language: string;
}

export interface CustomVoiceConfig {
  speaker: string;
  instruct?: string;
  language: string;
}

export interface VoiceProfile {
  provider: 'qwen3-tts';
  mode: 'voice_design' | 'custom_voice';
  voice_design?: VoiceDesignConfig;
  custom_voice?: CustomVoiceConfig;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Rate limiter (sliding window — same pattern as src/tts.ts)
// ---------------------------------------------------------------------------

const requestTimestamps: number[] = [];

function checkRateLimit(): boolean {
  const now = Date.now();
  const windowMs = 60_000;

  while (
    requestTimestamps.length > 0 &&
    requestTimestamps[0] < now - windowMs
  ) {
    requestTimestamps.shift();
  }

  if (requestTimestamps.length >= QWEN_TTS_RATE_LIMIT_PER_MIN) {
    return false;
  }

  requestTimestamps.push(now);
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const MAX_TEXT_LENGTH = 2000;
const TTS_TIMEOUT_MS = 120_000;

/** Check if Qwen3-TTS is enabled. */
export function isQwenTTSEnabled(): boolean {
  return QWEN_TTS_ENABLED;
}

/** Load a group's voice profile from voice_profile.json. */
export function loadVoiceProfile(groupFolder: string): VoiceProfile | null {
  try {
    const profilePath = path.join(GROUPS_DIR, groupFolder, 'voice_profile.json');
    if (!fs.existsSync(profilePath)) return null;
    const raw = fs.readFileSync(profilePath, 'utf-8');
    const profile = JSON.parse(raw) as VoiceProfile;

    // Basic validation
    if (
      profile.provider !== 'qwen3-tts' ||
      !['voice_design', 'custom_voice'].includes(profile.mode)
    ) {
      logger.warn(
        { module: 'tts-qwen', groupFolder, profile },
        'Invalid voice profile, ignoring',
      );
      return null;
    }

    return profile;
  } catch (err) {
    logger.warn(
      { module: 'tts-qwen', groupFolder, err },
      'Failed to load voice profile',
    );
    return null;
  }
}

/**
 * Synthesize text to speech via self-hosted Qwen3-TTS server.
 * Returns the absolute path to the saved .ogg file.
 */
export async function synthesizeQwenTTS(
  text: string,
  voiceProfile: VoiceProfile,
  mediaDir: string,
): Promise<string> {
  if (!QWEN_TTS_URL) {
    throw new Error('QWEN_TTS_URL is not configured');
  }

  if (!checkRateLimit()) {
    throw new Error('Qwen3-TTS rate limit exceeded, try again later');
  }

  // Truncate overly long text
  let inputText = text;
  if (inputText.length > MAX_TEXT_LENGTH) {
    logger.warn(
      { module: 'tts-qwen', length: inputText.length, max: MAX_TEXT_LENGTH },
      'TTS text too long, truncating',
    );
    inputText = inputText.slice(0, MAX_TEXT_LENGTH) + '...';
  }

  // Build request body based on voice profile mode
  const modeConfig = voiceProfile[voiceProfile.mode];
  const language = modeConfig?.language || QWEN_TTS_DEFAULT_LANGUAGE;

  const body: Record<string, string> = {
    text: inputText,
    mode: voiceProfile.mode,
    language,
  };

  if (voiceProfile.mode === 'voice_design' && voiceProfile.voice_design) {
    body.voice_description = voiceProfile.voice_design.description;
  } else if (voiceProfile.mode === 'custom_voice') {
    body.speaker = voiceProfile.custom_voice?.speaker || QWEN_TTS_DEFAULT_SPEAKER;
    body.instruct = voiceProfile.custom_voice?.instruct || '';
  }

  logger.info(
    {
      module: 'tts-qwen',
      mode: voiceProfile.mode,
      language,
      textLength: inputText.length,
    },
    'Calling Qwen3-TTS server',
  );

  // Call TTS server HTTP endpoint
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (QWEN_TTS_API_KEY) {
    headers['Authorization'] = `Bearer ${QWEN_TTS_API_KEY}`;
  }

  const response = await fetch(`${QWEN_TTS_URL}/synthesize`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`TTS server returned ${response.status}: ${detail.slice(0, 200)}`);
  }

  const audioBytes = await response.arrayBuffer();

  // Save to media directory
  fs.mkdirSync(mediaDir, { recursive: true });
  const filename = `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ogg`;
  const filePath = path.join(mediaDir, filename);
  fs.writeFileSync(filePath, Buffer.from(audioBytes));

  logger.info(
    {
      module: 'tts-qwen',
      filePath,
      size: fs.statSync(filePath).size,
      textLength: inputText.length,
    },
    'Qwen3-TTS audio synthesized',
  );

  return filePath;
}
