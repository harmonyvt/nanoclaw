import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  REPLICATE_TTS_ENABLED,
  REPLICATE_TTS_RATE_LIMIT_PER_MIN,
  REPLICATE_TTS_TIMEOUT_MS,
  REPLICATE_TTS_DEFAULT_PROVIDER,
  REPLICATE_TTS_DEFAULT_SPEAKER,
  QWEN_TTS_DEFAULT_LANGUAGE,
  GROUPS_DIR,
} from './config.js';
import { isReplicateConfigured, runModel } from './replicate-client.js';
import { logger } from './logger.js';
import { logDebugEvent } from './debug-log.js';

// ---------------------------------------------------------------------------
// Startup ffmpeg availability check
// ---------------------------------------------------------------------------

if (REPLICATE_TTS_ENABLED) {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'pipe', timeout: 5_000 });
  } catch {
    logger.warn(
      { module: 'tts-replicate' },
      'ffmpeg not found in PATH — Replicate TTS requires ffmpeg for WAV→OGG conversion. Voice messages will fail until ffmpeg is installed.',
    );
  }
}

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

export const PROVIDER_SHORTHANDS: Record<string, ReplicateTTSProvider> = {
  qwen: 'qwen/qwen3-tts',
  chatterbox: 'resemble-ai/chatterbox-turbo',
  minimax: 'minimax/speech-2.8-turbo',
};

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
    logger.warn(
      {
        module: 'tts-replicate',
        currentCount: requestTimestamps.length,
        limit: REPLICATE_TTS_RATE_LIMIT_PER_MIN,
        oldestRequestAgeMs: requestTimestamps.length > 0 ? now - requestTimestamps[0] : 0,
      },
      'Replicate TTS rate limit exceeded',
    );
    return false;
  }

  requestTimestamps.push(now);
  logger.debug(
    {
      module: 'tts-replicate',
      requestsInWindow: requestTimestamps.length,
      limit: REPLICATE_TTS_RATE_LIMIT_PER_MIN,
    },
    'Replicate TTS rate limit check passed',
  );
  return true;
}

// ---------------------------------------------------------------------------
// Audio download + OGG conversion
// ---------------------------------------------------------------------------

const MAX_TEXT_LENGTH = 2000;

const PROVIDER_MAX_TEXT: Record<ReplicateTTSProvider, number> = {
  'qwen/qwen3-tts': 2000,
  'resemble-ai/chatterbox-turbo': 500,
  'minimax/speech-2.8-turbo': 2000,
};

/**
 * Download audio from URL, convert to OGG/Opus via ffmpeg, return OGG path.
 */
async function downloadAndConvertToOgg(
  audioUrl: string,
  mediaDir: string,
): Promise<string> {
  fs.mkdirSync(mediaDir, { recursive: true });

  // Download audio bytes
  const downloadStart = Date.now();
  const response = await fetch(audioUrl);
  if (!response.ok) {
    const downloadMs = Date.now() - downloadStart;
    logger.error(
      { module: 'tts-replicate', status: response.status, downloadMs, audioUrl: audioUrl.slice(0, 120) },
      'TTS audio download failed',
    );
    throw new Error(`Audio download failed: ${response.status}`);
  }
  const audioBuffer = Buffer.from(await response.arrayBuffer());
  const downloadMs = Date.now() - downloadStart;

  logger.info(
    {
      module: 'tts-replicate',
      downloadMs,
      rawSize: audioBuffer.length,
      audioUrl: audioUrl.slice(0, 120),
    },
    'TTS audio downloaded',
  );

  // Write to temp file
  const tempFilename = `tts-tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`;
  const tempPath = path.join(mediaDir, tempFilename);
  fs.writeFileSync(tempPath, audioBuffer);

  // Convert to OGG/Opus via ffmpeg
  const oggFilename = `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ogg`;
  const oggPath = path.join(mediaDir, oggFilename);

  const ffmpegStart = Date.now();
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

  const ffmpegMs = Date.now() - ffmpegStart;
  const oggSize = fs.statSync(oggPath).size;
  logger.debug(
    {
      module: 'tts-replicate',
      ffmpegMs,
      rawSize: audioBuffer.length,
      oggSize,
    },
    'TTS audio converted to OGG',
  );

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
    mode: profile.mode,
    language,
  };

  if (profile.mode === 'custom_voice' && profile.custom_voice) {
    input.speaker = profile.custom_voice.speaker || REPLICATE_TTS_DEFAULT_SPEAKER;
    if (profile.custom_voice.instruct) {
      input.style_instruction = profile.custom_voice.instruct;
    }
  } else if (profile.mode === 'voice_design' && profile.voice_design) {
    input.voice_description = profile.voice_design.description;
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
    if (profile.voice_clone.ref_text) {
      input.reference_text = profile.voice_clone.ref_text;
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

  // Apply extras (only params supported by chatterbox-turbo API)
  if (profile.extras) {
    if (profile.extras.temperature !== undefined) input.temperature = profile.extras.temperature;
    if (profile.extras.top_p !== undefined) input.top_p = profile.extras.top_p;
    if (profile.extras.top_k !== undefined) input.top_k = profile.extras.top_k;
    if (profile.extras.repetition_penalty !== undefined) input.repetition_penalty = profile.extras.repetition_penalty;
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
  return REPLICATE_TTS_ENABLED && isReplicateConfigured();
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
  if (!isReplicateConfigured()) {
    throw new Error('Replicate TTS token is not configured');
  }

  if (!checkRateLimit()) {
    throw new Error('Replicate TTS rate limit exceeded, try again later');
  }

  // Truncate overly long text (per-provider limits)
  const maxLen = PROVIDER_MAX_TEXT[profile.provider] ?? MAX_TEXT_LENGTH;
  let inputText = text;
  if (inputText.length > maxLen) {
    logger.warn(
      { module: 'tts-replicate', provider: profile.provider, length: inputText.length, max: maxLen },
      'TTS text too long, truncating',
    );
    inputText = inputText.slice(0, maxLen) + '...';
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

  // Log input params (redact base64 audio data)
  const logInput = { ...input };
  if (typeof logInput.reference_audio === 'string' && (logInput.reference_audio as string).startsWith('data:')) {
    logInput.reference_audio = `[base64 audio, ${(logInput.reference_audio as string).length} chars]`;
  }
  logger.info(
    {
      module: 'tts-replicate',
      provider: profile.provider,
      mode: profile.mode,
      textLength: inputText.length,
      input: logInput,
    },
    'Calling Replicate TTS',
  );

  const ttsStartMs = Date.now();

  // Call Replicate API
  let output: unknown;
  try {
    output = await runModel(profile.provider, input, {
      timeoutMs: REPLICATE_TTS_TIMEOUT_MS,
    });
  } catch (err) {
    const durationMs = Date.now() - ttsStartMs;
    logger.error(
      {
        module: 'tts-replicate',
        provider: profile.provider,
        mode: profile.mode,
        textLength: inputText.length,
        durationMs,
        error: err instanceof Error ? err.message : String(err),
      },
      'Replicate TTS API call failed',
    );
    throw err;
  }

  // Log output type for diagnostics
  const outputType = output instanceof ReadableStream
    ? 'ReadableStream'
    : typeof output === 'string'
      ? 'string'
      : output && typeof output === 'object' && 'url' in output
        ? 'FileOutput'
        : typeof output;
  logger.debug(
    { module: 'tts-replicate', provider: profile.provider, outputType },
    'Replicate TTS output received',
  );

  // Replicate TTS output is typically a URL string or a FileOutput with url()
  let oggPath: string;
  let audioUrl: string;
  if (typeof output === 'string') {
    audioUrl = output;
  } else if (output && typeof output === 'object' && 'url' in output) {
    audioUrl = String((output as { url: () => string }).url());
  } else if (output instanceof ReadableStream || (output && typeof (output as { getReader?: unknown }).getReader === 'function')) {
    // Stream output — collect into buffer and save directly
    const streamStart = Date.now();
    const reader = (output as ReadableStream).getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const streamMs = Date.now() - streamStart;
    logger.info(
      { module: 'tts-replicate', provider: profile.provider, streamMs, chunkCount: chunks.length, totalBytes: totalLength },
      'TTS stream chunks collected',
    );
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
    const durationMs = Date.now() - ttsStartMs;
    logger.error(
      { module: 'tts-replicate', provider: profile.provider, outputType: typeof output, durationMs },
      'Unexpected Replicate output type',
    );
    throw new Error(`Unexpected Replicate output type: ${typeof output}`);
  }

  // Download from URL and convert to OGG
  oggPath = await downloadAndConvertToOgg(audioUrl, mediaDir);

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
