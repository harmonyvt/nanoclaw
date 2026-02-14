import Replicate from 'replicate';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  REPLICATE_TTS_ENABLED,
  REPLICATE_TTS_TOKEN,
  REPLICATE_TTS_RATE_LIMIT_PER_MIN,
  REPLICATE_TTS_TIMEOUT_MS,
  REPLICATE_TTS_DEFAULT_PROVIDER,
  REPLICATE_TTS_DEFAULT_SPEAKER,
  QWEN_TTS_DEFAULT_LANGUAGE,
  GROUPS_DIR,
} from './config.js';
import { logger } from './logger.js';
import { logDebugEvent } from './debug-log.js';

// ---------------------------------------------------------------------------
// Replicate TTS provider identifiers
// ---------------------------------------------------------------------------

export const REPLICATE_TTS_PROVIDERS = [
  'qwen/qwen3-tts',
  'resemble-ai/chatterbox-turbo',
  'minimax/speech-2.8-turbo',
] as const;

export type ReplicateTTSProvider = (typeof REPLICATE_TTS_PROVIDERS)[number];

export function isReplicateTTSProvider(
  provider: string,
): provider is ReplicateTTSProvider {
  return REPLICATE_TTS_PROVIDERS.includes(provider as ReplicateTTSProvider);
}

// ---------------------------------------------------------------------------
// Provider-specific voice profile types
// ---------------------------------------------------------------------------

export interface ReplicateQwenProfile {
  provider: 'qwen/qwen3-tts';
  mode: 'voice_design' | 'custom_voice' | 'voice_clone';
  voice_design?: { description: string; language: string };
  custom_voice?: { speaker: string; instruct?: string; language: string };
  voice_clone?: { ref_audio_path: string; ref_text?: string; language: string };
  created_at: string;
  updated_at: string;
}

export interface ChatterboxProfile {
  provider: 'resemble-ai/chatterbox-turbo';
  mode: 'custom_voice' | 'voice_clone';
  custom_voice?: { speaker: string };
  voice_clone?: { ref_audio_path: string };
  extras?: {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    repetition_penalty?: number;
    exaggeration?: number;
    cfg_weight?: number;
  };
  created_at: string;
  updated_at: string;
}

export interface MinimaxProfile {
  provider: 'minimax/speech-2.8-turbo';
  mode: 'custom_voice';
  custom_voice?: { speaker: string; language?: string };
  extras?: {
    speed?: number;
    pitch?: number;
    volume?: number;
    emotion?: string;
  };
  created_at: string;
  updated_at: string;
}

export type ReplicateVoiceProfile =
  | ReplicateQwenProfile
  | ChatterboxProfile
  | MinimaxProfile;

// ---------------------------------------------------------------------------
// Mode compatibility per provider
// ---------------------------------------------------------------------------

const SUPPORTED_MODES: Record<ReplicateTTSProvider, readonly string[]> = {
  'qwen/qwen3-tts': ['voice_design', 'custom_voice', 'voice_clone'],
  'resemble-ai/chatterbox-turbo': ['custom_voice', 'voice_clone'],
  'minimax/speech-2.8-turbo': ['custom_voice'],
};

export function isModeSupported(
  provider: ReplicateTTSProvider,
  mode: string,
): boolean {
  return SUPPORTED_MODES[provider]?.includes(mode) ?? false;
}

// ---------------------------------------------------------------------------
// Default speaker names per provider
// ---------------------------------------------------------------------------

export const PROVIDER_SPEAKERS: Record<ReplicateTTSProvider, string[]> = {
  'qwen/qwen3-tts': [
    'Vivian', 'Serena', 'Dylan', 'Eric', 'Ryan',
    'Aiden', 'Uncle_Fu', 'Ono_Anna', 'Sohee',
  ],
  'resemble-ai/chatterbox-turbo': [
    'Andy', 'Abigail', 'Aaron', 'Brian', 'Chloe', 'Dylan',
  ],
  'minimax/speech-2.8-turbo': [
    'Wise_Woman', 'Friendly_Person', 'Deep_Voice_Man', 'Calm_Woman',
    'Casual_Guy', 'Lively_Girl', 'Patient_Man', 'Young_Knight',
    'Determined_Man', 'Lovely_Girl', 'Decent_Boy', 'Inspirational_Girl',
    'Imposing_Manner', 'Elegant_Man', 'Abbess', 'Sweet_Girl_2',
    'Exuberant_Girl',
  ],
};

// ---------------------------------------------------------------------------
// Rate limiter (sliding window)
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

  if (requestTimestamps.length >= REPLICATE_TTS_RATE_LIMIT_PER_MIN) {
    return false;
  }

  requestTimestamps.push(now);
  return true;
}

// ---------------------------------------------------------------------------
// Audio download + OGG conversion
// ---------------------------------------------------------------------------

const MAX_TEXT_LENGTH = 2000;

/**
 * Download audio from URL, convert to OGG/Opus via ffmpeg, return OGG path.
 */
async function downloadAndConvertToOgg(
  audioUrl: string,
  mediaDir: string,
): Promise<string> {
  fs.mkdirSync(mediaDir, { recursive: true });

  // Download audio bytes
  const response = await fetch(audioUrl);
  if (!response.ok) {
    throw new Error(`Audio download failed: ${response.status}`);
  }
  const audioBuffer = Buffer.from(await response.arrayBuffer());

  // Write to temp file
  const tempFilename = `tts-tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`;
  const tempPath = path.join(mediaDir, tempFilename);
  fs.writeFileSync(tempPath, audioBuffer);

  // Convert to OGG/Opus via ffmpeg
  const oggFilename = `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ogg`;
  const oggPath = path.join(mediaDir, oggFilename);

  try {
    execFileSync('ffmpeg', [
      '-i', tempPath,
      '-c:a', 'libopus',
      '-b:a', '64k',
      '-vn',
      '-y',
      oggPath,
    ], { timeout: 30_000, stdio: 'pipe' });
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }

  return oggPath;
}

// ---------------------------------------------------------------------------
// Provider-specific input builders
// ---------------------------------------------------------------------------

function buildQwenInput(
  text: string,
  profile: ReplicateQwenProfile,
  groupFolder: string,
): Record<string, unknown> {
  const language = (() => {
    if (profile.mode === 'voice_design') return profile.voice_design?.language;
    if (profile.mode === 'custom_voice') return profile.custom_voice?.language;
    if (profile.mode === 'voice_clone') return profile.voice_clone?.language;
    return undefined;
  })() || QWEN_TTS_DEFAULT_LANGUAGE;

  const input: Record<string, unknown> = {
    text,
    language,
  };

  if (profile.mode === 'custom_voice' && profile.custom_voice) {
    input.speaker = profile.custom_voice.speaker || REPLICATE_TTS_DEFAULT_SPEAKER;
    if (profile.custom_voice.instruct) {
      input.instruct = profile.custom_voice.instruct;
    }
  } else if (profile.mode === 'voice_design' && profile.voice_design) {
    input.instruct = profile.voice_design.description;
  } else if (profile.mode === 'voice_clone' && profile.voice_clone) {
    const refPath = path.join(
      GROUPS_DIR,
      groupFolder,
      profile.voice_clone.ref_audio_path,
    );
    if (!fs.existsSync(refPath)) {
      throw new Error(`Voice clone ref audio not found: ${refPath}`);
    }
    const audioBuffer = fs.readFileSync(refPath);
    const ext = path.extname(refPath).replace('.', '') || 'wav';
    input.ref_audio = `data:audio/${ext};base64,${audioBuffer.toString('base64')}`;
    if (profile.voice_clone.ref_text) {
      input.ref_text = profile.voice_clone.ref_text;
    }
  }

  return input;
}

function buildChatterboxInput(
  text: string,
  profile: ChatterboxProfile,
  groupFolder: string,
): Record<string, unknown> {
  const input: Record<string, unknown> = { text };

  if (profile.mode === 'custom_voice' && profile.custom_voice) {
    input.voice = profile.custom_voice.speaker || 'Andy';
  } else if (profile.mode === 'voice_clone' && profile.voice_clone) {
    const refPath = path.join(
      GROUPS_DIR,
      groupFolder,
      profile.voice_clone.ref_audio_path,
    );
    if (!fs.existsSync(refPath)) {
      throw new Error(`Voice clone ref audio not found: ${refPath}`);
    }
    const audioBuffer = fs.readFileSync(refPath);
    const ext = path.extname(refPath).replace('.', '') || 'wav';
    input.reference_audio = `data:audio/${ext};base64,${audioBuffer.toString('base64')}`;
  }

  // Apply extras
  if (profile.extras) {
    if (profile.extras.temperature !== undefined) input.temperature = profile.extras.temperature;
    if (profile.extras.top_p !== undefined) input.top_p = profile.extras.top_p;
    if (profile.extras.top_k !== undefined) input.top_k = profile.extras.top_k;
    if (profile.extras.repetition_penalty !== undefined) input.repetition_penalty = profile.extras.repetition_penalty;
    if (profile.extras.exaggeration !== undefined) input.exaggeration = profile.extras.exaggeration;
    if (profile.extras.cfg_weight !== undefined) input.cfg_weight = profile.extras.cfg_weight;
  }

  return input;
}

function buildMinimaxInput(
  text: string,
  profile: MinimaxProfile,
): Record<string, unknown> {
  const input: Record<string, unknown> = {
    text,
    voice_id: profile.custom_voice?.speaker || 'Friendly_Person',
  };

  // Apply extras
  if (profile.extras) {
    if (profile.extras.speed !== undefined) input.speed = profile.extras.speed;
    if (profile.extras.pitch !== undefined) input.pitch = profile.extras.pitch;
    if (profile.extras.volume !== undefined) input.volume = profile.extras.volume;
    if (profile.extras.emotion !== undefined) input.emotion = profile.extras.emotion;
  }

  return input;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function isReplicateTTSEnabled(): boolean {
  return REPLICATE_TTS_ENABLED && REPLICATE_TTS_TOKEN.length > 0;
}

/**
 * Default Replicate voice profile using REPLICATE_TTS_DEFAULT_* env vars.
 */
export function defaultReplicateVoiceProfile(): ReplicateVoiceProfile {
  const provider = REPLICATE_TTS_DEFAULT_PROVIDER as ReplicateTTSProvider;
  const now = new Date().toISOString();

  if (provider === 'resemble-ai/chatterbox-turbo') {
    return {
      provider,
      mode: 'custom_voice',
      custom_voice: { speaker: REPLICATE_TTS_DEFAULT_SPEAKER },
      created_at: now,
      updated_at: now,
    };
  }

  if (provider === 'minimax/speech-2.8-turbo') {
    return {
      provider,
      mode: 'custom_voice',
      custom_voice: { speaker: REPLICATE_TTS_DEFAULT_SPEAKER },
      created_at: now,
      updated_at: now,
    };
  }

  // Default: qwen/qwen3-tts
  return {
    provider: 'qwen/qwen3-tts',
    mode: 'custom_voice',
    custom_voice: {
      speaker: REPLICATE_TTS_DEFAULT_SPEAKER,
      language: QWEN_TTS_DEFAULT_LANGUAGE,
    },
    created_at: now,
    updated_at: now,
  };
}

/**
 * Synthesize text to speech via a Replicate-hosted TTS model.
 * Returns the absolute path to the saved .ogg file.
 */
export async function synthesizeReplicateTTS(
  text: string,
  profile: ReplicateVoiceProfile,
  mediaDir: string,
  groupFolder: string,
): Promise<string> {
  if (!REPLICATE_TTS_TOKEN) {
    throw new Error('Replicate TTS token is not configured');
  }

  if (!checkRateLimit()) {
    throw new Error('Replicate TTS rate limit exceeded, try again later');
  }

  // Truncate overly long text
  let inputText = text;
  if (inputText.length > MAX_TEXT_LENGTH) {
    logger.warn(
      { module: 'tts-replicate', length: inputText.length, max: MAX_TEXT_LENGTH },
      'TTS text too long, truncating',
    );
    inputText = inputText.slice(0, MAX_TEXT_LENGTH) + '...';
  }

  // Build provider-specific input
  let input: Record<string, unknown>;
  switch (profile.provider) {
    case 'qwen/qwen3-tts':
      input = buildQwenInput(inputText, profile, groupFolder);
      break;
    case 'resemble-ai/chatterbox-turbo':
      input = buildChatterboxInput(inputText, profile, groupFolder);
      break;
    case 'minimax/speech-2.8-turbo':
      input = buildMinimaxInput(inputText, profile);
      break;
    default:
      throw new Error(`Unknown Replicate TTS provider: ${(profile as ReplicateVoiceProfile).provider}`);
  }

  const ttsStartMs = Date.now();
  logger.info(
    {
      module: 'tts-replicate',
      provider: profile.provider,
      mode: profile.mode,
      textLength: inputText.length,
    },
    'Calling Replicate TTS',
  );

  // Call Replicate API
  const replicate = new Replicate({ auth: REPLICATE_TTS_TOKEN });
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REPLICATE_TTS_TIMEOUT_MS);

  let oggPath: string;
  try {
    const output = await replicate.run(profile.provider, {
      input,
      signal: controller.signal,
    });

    // Replicate TTS output is typically a URL string or a FileOutput with url()
    let audioUrl: string;
    if (typeof output === 'string') {
      audioUrl = output;
    } else if (output && typeof output === 'object' && 'url' in output) {
      audioUrl = String((output as { url: () => string }).url());
    } else if (output instanceof ReadableStream || (output && typeof (output as { getReader?: unknown }).getReader === 'function')) {
      // Stream output — collect into buffer and save directly
      const reader = (output as ReadableStream).getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      const buffer = Buffer.alloc(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.length;
      }

      // Save raw audio and convert
      fs.mkdirSync(mediaDir, { recursive: true });
      const tempPath = path.join(mediaDir, `tts-tmp-${Date.now()}.raw`);
      fs.writeFileSync(tempPath, buffer);

      const oggFilename = `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ogg`;
      oggPath = path.join(mediaDir, oggFilename);
      try {
        execFileSync('ffmpeg', ['-i', tempPath, '-c:a', 'libopus', '-b:a', '64k', '-vn', '-y', oggPath], {
          timeout: 30_000,
          stdio: 'pipe',
        });
      } finally {
        try { fs.unlinkSync(tempPath); } catch {}
      }

      const ttsDurationMs = Date.now() - ttsStartMs;
      logDebugEvent('tts', 'replicate_synthesis_complete', groupFolder, {
        provider: profile.provider,
        mode: profile.mode,
        textLength: inputText.length,
        durationMs: ttsDurationMs,
      });

      logger.info(
        {
          module: 'tts-replicate',
          provider: profile.provider,
          filePath: oggPath,
          size: fs.statSync(oggPath).size,
          durationMs: ttsDurationMs,
        },
        'Replicate TTS audio synthesized (stream)',
      );

      return oggPath;
    } else {
      throw new Error(`Unexpected Replicate output type: ${typeof output}`);
    }

    // Download from URL and convert to OGG
    oggPath = await downloadAndConvertToOgg(audioUrl, mediaDir);
  } finally {
    clearTimeout(timeoutId);
  }

  const ttsDurationMs = Date.now() - ttsStartMs;
  logDebugEvent('tts', 'replicate_synthesis_complete', groupFolder, {
    provider: profile.provider,
    mode: profile.mode,
    textLength: inputText.length,
    durationMs: ttsDurationMs,
  });

  logger.info(
    {
      module: 'tts-replicate',
      provider: profile.provider,
      filePath: oggPath,
      size: fs.statSync(oggPath).size,
      durationMs: ttsDurationMs,
    },
    'Replicate TTS audio synthesized',
  );

  return oggPath;
}
