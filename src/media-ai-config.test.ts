import { afterEach, describe, expect, test } from 'bun:test';
import { resolveMediaOpenAIConfig } from './media-ai-config.js';

const ENV_KEYS = [
  'COMPOSITE_AI_ENABLED',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MEDIA_API_KEY',
  'OPENAI_MEDIA_BASE_URL',
  'OPENAI_MEDIA_MODEL',
  'OPENAI_MEDIA_VISION_MODEL',
  'OPENAI_MEDIA_AUDIO_MODEL',
] as const;

const envSnapshot = new Map<string, string | undefined>();
for (const key of ENV_KEYS) {
  envSnapshot.set(key, process.env[key]);
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const original = envSnapshot.get(key);
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
});

describe('resolveMediaOpenAIConfig', () => {
  test('non-composite mode keeps default OpenAI pipeline', () => {
    process.env.COMPOSITE_AI_ENABLED = 'false';
    process.env.OPENAI_API_KEY = 'primary-key';
    process.env.OPENAI_MEDIA_API_KEY = 'media-key-ignored';
    process.env.OPENAI_MEDIA_MODEL = 'gpt-4.1-mini';

    const cfg = resolveMediaOpenAIConfig();
    expect(cfg.compositeEnabled).toBe(false);
    expect(cfg.apiKey).toBe('primary-key');
    expect(cfg.audioModel).toBe('whisper-1');
    expect(cfg.visionModel).toBe('gpt-4o');
  });

  test('composite mode uses media overrides with fallback to primary key', () => {
    process.env.COMPOSITE_AI_ENABLED = 'true';
    process.env.OPENAI_API_KEY = 'primary-key';
    process.env.OPENAI_MEDIA_BASE_URL = 'https://media.example.com/v1/';
    process.env.OPENAI_MEDIA_MODEL = 'gpt-4.1-mini';

    const cfg = resolveMediaOpenAIConfig();
    expect(cfg.compositeEnabled).toBe(true);
    expect(cfg.apiKey).toBe('primary-key');
    expect(cfg.baseUrl).toBe('https://media.example.com/v1');
    expect(cfg.audioModel).toBe('gpt-4.1-mini');
    expect(cfg.visionModel).toBe('gpt-4.1-mini');
  });
});
