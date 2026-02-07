import fs from 'fs';
import path from 'path';
import {
  FREYA_API_KEY,
  FREYA_CHARACTER_ID,
  FREYA_LANGUAGE,
  FREYA_RATE_LIMIT_PER_MIN,
} from './config.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Freya TTS API client + emotion system
// ---------------------------------------------------------------------------

const FREYA_ENDPOINT = 'https://freya-audio.com/api/tts/stream';
const MAX_TEXT_LENGTH = 2000;

// ---------------------------------------------------------------------------
// Emotion catalog
// ---------------------------------------------------------------------------

interface EmotionDef {
  freyaCode: string;
  maxIntensity: number;
}

const EMOTION_CATALOG: Record<string, EmotionDef> = {
  neutral: { freyaCode: 'neutral', maxIntensity: 1 },
  happy: { freyaCode: 'happy', maxIntensity: 3 },
  sad: { freyaCode: 'sad', maxIntensity: 3 },
  angry: { freyaCode: 'angry', maxIntensity: 4 },
  fear: { freyaCode: 'fear', maxIntensity: 4 },
  surprise: { freyaCode: 'surprise', maxIntensity: 2 },
  awe: { freyaCode: 'awe', maxIntensity: 1 },
  shy: { freyaCode: 'shy', maxIntensity: 3 },
  embarrassed: { freyaCode: 'embarrassed', maxIntensity: 1 },
  lonely: { freyaCode: 'lonely', maxIntensity: 1 },
  jealous: { freyaCode: 'jealous', maxIntensity: 3 },
  tsun: { freyaCode: 'tsun', maxIntensity: 3 },
  awkward: { freyaCode: 'awkwardness', maxIntensity: 1 },
  caring: { freyaCode: 'caring', maxIntensity: 3 },
  protective: { freyaCode: 'protective', maxIntensity: 1 },
  relieved: { freyaCode: 'relieved', maxIntensity: 2 },
  worried: { freyaCode: 'worried', maxIntensity: 2 },
  anxious: { freyaCode: 'anxiety', maxIntensity: 1 },
  annoyed: { freyaCode: 'annoyed', maxIntensity: 4 },
  frustrated: { freyaCode: 'frustrated', maxIntensity: 1 },
  disappointed: { freyaCode: 'disappointed', maxIntensity: 1 },
  sarcastic: { freyaCode: 'sarcastic', maxIntensity: 1 },
  playful: { freyaCode: 'playful', maxIntensity: 3 },
  proud: { freyaCode: 'proud', maxIntensity: 1 },
  pout: { freyaCode: 'pout', maxIntensity: 1 },
  cold: { freyaCode: 'cold', maxIntensity: 3 },
  desire: { freyaCode: 'sexual_desire', maxIntensity: 3 },
  whisper: { freyaCode: 'whisper', maxIntensity: 3 },
  tired: { freyaCode: 'tired', maxIntensity: 2 },
  sleepy: { freyaCode: 'sleepy', maxIntensity: 1 },
  breathy: { freyaCode: 'breathy', maxIntensity: 1 },
  monotone: { freyaCode: 'monotone', maxIntensity: 1 },
  firm: { freyaCode: 'firm', maxIntensity: 1 },
  mumbling: { freyaCode: 'mumbling', maxIntensity: 1 },
};

// ---------------------------------------------------------------------------
// Emotion parsing
// ---------------------------------------------------------------------------

export interface ParsedEmotion {
  name: string;
  intensity: number;
  freyaCode: string;
}

/**
 * Parse an agent-supplied emotion string like "happy" or "happy:2".
 * Returns a ParsedEmotion or an object with an error message.
 */
export function parseEmotion(
  emotion: string,
): ParsedEmotion | { error: string } {
  const parts = emotion.trim().toLowerCase().split(':');
  const name = parts[0];
  const intensity = parts.length > 1 ? parseInt(parts[1], 10) : 1;

  if (isNaN(intensity) || intensity < 1) {
    return { error: `Invalid intensity in "${emotion}"` };
  }

  const def = EMOTION_CATALOG[name];
  if (!def) {
    return {
      error: `Unknown emotion "${name}". Valid: ${Object.keys(EMOTION_CATALOG).join(', ')}`,
    };
  }

  return {
    name,
    intensity: Math.min(intensity, def.maxIntensity),
    freyaCode: def.freyaCode,
  };
}

// ---------------------------------------------------------------------------
// Keyword-based emotion fallback
// ---------------------------------------------------------------------------

const KEYWORD_MAP: Array<{
  keywords: string[];
  emotion: string;
  intensity: number;
}> = [
  {
    keywords: ['happy', 'excited', 'joy', 'great', 'wonderful', 'yay', 'awesome'],
    emotion: 'happy',
    intensity: 2,
  },
  {
    keywords: ['sad', 'sorry', 'unfortunately', 'miss you', 'cry'],
    emotion: 'sad',
    intensity: 2,
  },
  {
    keywords: ['angry', 'mad', 'furious', 'hate'],
    emotion: 'angry',
    intensity: 2,
  },
  {
    keywords: ['scared', 'afraid', 'terrified', 'panic'],
    emotion: 'fear',
    intensity: 2,
  },
  {
    keywords: ['wow', 'amazing', 'incredible', 'unbelievable'],
    emotion: 'surprise',
    intensity: 1,
  },
  {
    keywords: ['haha', 'lol', 'funny', 'joke'],
    emotion: 'playful',
    intensity: 2,
  },
  {
    keywords: ['worried', 'concerned', 'nervous'],
    emotion: 'worried',
    intensity: 1,
  },
  {
    keywords: ['whisper', 'secret', 'quietly', 'psst'],
    emotion: 'whisper',
    intensity: 1,
  },
  {
    keywords: ['tired', 'exhausted', 'sleepy'],
    emotion: 'tired',
    intensity: 1,
  },
  {
    keywords: ['take care', 'be careful', 'stay safe', 'i care'],
    emotion: 'caring',
    intensity: 1,
  },
];

/**
 * Detect an emotion from text content using keyword matching.
 * Returns neutral if no keywords match.
 */
export function detectEmotionFromText(text: string): ParsedEmotion {
  const lower = text.toLowerCase();
  for (const entry of KEYWORD_MAP) {
    for (const kw of entry.keywords) {
      if (lower.includes(kw)) {
        const def = EMOTION_CATALOG[entry.emotion]!;
        return {
          name: entry.emotion,
          intensity: Math.min(entry.intensity, def.maxIntensity),
          freyaCode: def.freyaCode,
        };
      }
    }
  }
  return { name: 'neutral', intensity: 1, freyaCode: 'neutral' };
}

// ---------------------------------------------------------------------------
// Text formatting
// ---------------------------------------------------------------------------

/** Prepend a Freya emotion marker to text. */
export function formatFreyaText(text: string, emotion: ParsedEmotion): string {
  const code = `${emotion.freyaCode}${emotion.intensity}`;
  return `\u3010${code}\u3011${text}`;
}

// ---------------------------------------------------------------------------
// Rate limiter (sliding window)
// ---------------------------------------------------------------------------

const requestTimestamps: number[] = [];

function checkRateLimit(): boolean {
  const now = Date.now();
  const windowMs = 60_000;

  // Remove timestamps outside window
  while (
    requestTimestamps.length > 0 &&
    requestTimestamps[0] < now - windowMs
  ) {
    requestTimestamps.shift();
  }

  if (requestTimestamps.length >= FREYA_RATE_LIMIT_PER_MIN) {
    return false;
  }

  requestTimestamps.push(now);
  return true;
}

// ---------------------------------------------------------------------------
// Binary stream parser
// ---------------------------------------------------------------------------

/**
 * Parse Freya's length-prefixed binary response into a single OGG buffer.
 * Format: repeated [4-byte big-endian length][OGG/Opus chunk].
 */
function parseLengthPrefixedOgg(buffer: ArrayBuffer): Uint8Array {
  const view = new DataView(buffer);
  const chunks: Uint8Array[] = [];
  let offset = 0;

  while (offset + 4 <= buffer.byteLength) {
    const chunkLength = view.getUint32(offset, false); // big-endian
    offset += 4;

    if (chunkLength === 0) continue;
    if (offset + chunkLength > buffer.byteLength) {
      logger.warn(
        { chunkLength, offset, total: buffer.byteLength },
        'Freya TTS: truncated chunk at end of stream',
      );
      break;
    }

    chunks.push(new Uint8Array(buffer, offset, chunkLength));
    offset += chunkLength;
  }

  if (chunks.length === 0) {
    throw new Error('Freya TTS: no audio chunks in response');
  }

  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let pos = 0;
  for (const chunk of chunks) {
    result.set(chunk, pos);
    pos += chunk.length;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Check if Freya TTS is configured. */
export function isFreyaEnabled(): boolean {
  return FREYA_API_KEY.length > 0;
}

/**
 * Synthesize text to speech via Freya TTS API.
 * Text should already include emotion markers (use formatFreyaText).
 * Returns the absolute path to the saved .ogg file.
 */
export async function synthesizeSpeech(
  text: string,
  mediaDir: string,
): Promise<string> {
  if (!checkRateLimit()) {
    throw new Error('Freya TTS rate limit exceeded, try again later');
  }

  // Truncate overly long text
  let inputText = text;
  if (inputText.length > MAX_TEXT_LENGTH) {
    logger.warn(
      { length: inputText.length, max: MAX_TEXT_LENGTH },
      'TTS text too long, truncating',
    );
    inputText = inputText.slice(0, MAX_TEXT_LENGTH) + '...';
  }

  const response = await fetch(FREYA_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${FREYA_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text: inputText,
      character_id: FREYA_CHARACTER_ID,
      language: FREYA_LANGUAGE,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(
      `Freya TTS API error: HTTP ${response.status} — ${errorText.slice(0, 300)}`,
    );
  }

  const rawBuffer = await response.arrayBuffer();
  const oggData = parseLengthPrefixedOgg(rawBuffer);

  // Save to media directory
  fs.mkdirSync(mediaDir, { recursive: true });
  const filename = `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ogg`;
  const filePath = path.join(mediaDir, filename);
  fs.writeFileSync(filePath, oggData);

  logger.info(
    { filePath, size: oggData.length, textLength: inputText.length },
    'TTS audio synthesized',
  );

  return filePath;
}
