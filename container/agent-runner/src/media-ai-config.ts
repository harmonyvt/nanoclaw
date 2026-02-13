const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MEDIA_VISION_MODEL = 'gpt-4o';
const DEFAULT_MEDIA_AUDIO_MODEL = 'whisper-1';

export type MediaOpenAIConfig = {
  compositeEnabled: boolean;
  apiKey: string;
  baseUrl: string;
  visionModel: string;
  audioModel: string;
};

export function resolveMediaOpenAIConfig(): MediaOpenAIConfig {
  const compositeEnabled = process.env.COMPOSITE_AI_ENABLED === 'true';
  const sharedMediaModel = compositeEnabled
    ? process.env.OPENAI_MEDIA_MODEL || ''
    : '';
  const configuredBaseUrl = compositeEnabled
    ? process.env.OPENAI_MEDIA_BASE_URL ||
      process.env.OPENAI_BASE_URL ||
      DEFAULT_OPENAI_BASE_URL
    : process.env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL;

  return {
    compositeEnabled,
    apiKey: compositeEnabled
      ? process.env.OPENAI_MEDIA_API_KEY || process.env.OPENAI_API_KEY || ''
      : process.env.OPENAI_API_KEY || '',
    baseUrl: configuredBaseUrl.replace(/\/+$/, ''),
    visionModel:
      (compositeEnabled ? process.env.OPENAI_MEDIA_VISION_MODEL : '') ||
      sharedMediaModel ||
      DEFAULT_MEDIA_VISION_MODEL,
    audioModel:
      (compositeEnabled ? process.env.OPENAI_MEDIA_AUDIO_MODEL : '') ||
      sharedMediaModel ||
      DEFAULT_MEDIA_AUDIO_MODEL,
  };
}
