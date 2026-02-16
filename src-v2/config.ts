/**
 * NanoClaw v2 — AppConfig service.
 * Reads all environment variables and exposes them as a typed Effect Service.
 */

import path from 'path';
import { Context, Effect, Layer } from 'effect';

// ─── Config Interface ──────────────────────────────────────────────────────

export interface AppConfigShape {
  // ── Telegram ──
  readonly telegramBotToken: string;
  readonly telegramOwnerId: string;

  // ── AI Provider Defaults ──
  readonly defaultProvider: string;
  readonly defaultModel: string;

  // ── Assistant ──
  readonly assistantName: string;
  readonly triggerPattern: RegExp;

  // ── Paths ──
  readonly projectRoot: string;
  readonly storeDir: string;
  readonly groupsDir: string;
  readonly dataDir: string;
  readonly serviceLogsDir: string;
  readonly mainGroupFolder: string;

  // ── Container ──
  readonly containerImage: string;
  readonly containerAgentVersion: string;
  readonly containerTimeout: number;
  readonly containerMaxOutputSize: number;
  readonly maxConcurrentAgents: number;
  readonly maxConversationMessages: number;
  readonly maxAgentRetries: number;
  readonly agentRetryDelay: number;

  // ── IPC ──
  readonly ipcPollInterval: number;
  readonly schedulerPollInterval: number;

  // ── Sandbox / CUA ──
  readonly sandboxIdleTimeoutMs: number;
  readonly sandboxTailscaleEnabled: boolean;
  readonly cuaTakeoverWebEnabled: boolean;
  readonly cuaTakeoverWebPort: number;
  readonly cuaSandboxContainerName: string;
  readonly cuaSandboxImage: string;
  readonly cuaSandboxPlatform: string;
  readonly cuaSandboxCommandPort: number;
  readonly cuaSandboxVncPort: number;
  readonly cuaSandboxNovncPort: number;
  readonly cuaSandboxScreenWidth: number;
  readonly cuaSandboxScreenHeight: number;
  readonly cuaSandboxScreenDepth: number;
  readonly cuaSandboxShmSize: string;
  readonly cuaSandboxPersist: boolean;
  readonly cuaSandboxHomeVolume: string;
  readonly cuaApiKey: string;

  // ── Replicate ──
  readonly replicateApiToken: string;

  // ── OmniParser ──
  readonly omniparserEnabled: boolean;
  readonly omniparserBoxThreshold: number;
  readonly omniparserIouThreshold: number;
  readonly omniparserTimeoutMs: number;

  // ── TTS ──
  readonly freyaTtsEnabled: boolean;
  readonly freyaApiKey: string;
  readonly freyaCharacterId: string;
  readonly freyaLanguage: string;
  readonly freyaRateLimitPerMin: number;
  readonly qwenTtsEnabled: boolean;
  readonly qwenTtsUrl: string;
  readonly qwenTtsApiKey: string;
  readonly qwenTtsDefaultLanguage: string;
  readonly qwenTtsDefaultSpeaker: string;
  readonly qwenTtsRateLimitPerMin: number;
  readonly replicateTtsEnabled: boolean;
  readonly replicateTtsRateLimitPerMin: number;
  readonly replicateTtsTimeoutMs: number;
  readonly replicateTtsDefaultProvider: string;
  readonly replicateTtsDefaultSpeaker: string;

  // ── External APIs ──
  readonly openaiApiKey: string;
  readonly openaiBaseUrl: string;
  readonly anthropicBaseUrl: string;
  readonly firecrawlApiKey: string;
  readonly supermemoryApiKey: string;

  // ── Dashboard ──
  readonly dashboardEnabled: boolean;
  readonly dashboardPort: number;
  readonly dashboardUrl: string;
  readonly dashboardHttpsPort: number;
  readonly cuaTakeoverHttpsPort: number;
  readonly logRetentionDays: number;

  // ── Misc ──
  readonly timezone: string;
  readonly logLevel: string;
  readonly maxThinkingTokens: number;
  readonly debugThreads: boolean;
}

export class AppConfig extends Context.Tag('AppConfig')<
  AppConfig,
  AppConfigShape
>() {}

// ─── Helpers ───────────────────────────────────────────────────────────────

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  return v ? parseInt(v, 10) : fallback;
}

function envFloat(key: string, fallback: number): number {
  const v = process.env[key];
  return v ? parseFloat(v) : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined) return fallback;
  return v === 'true';
}

function envBoolNotFalse(key: string): boolean {
  return process.env[key] !== 'false';
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Live Layer ────────────────────────────────────────────────────────────

export const AppConfigLive: Layer.Layer<AppConfig> = Layer.succeed(
  AppConfig,
  (() => {
    const projectRoot = process.cwd();
    const homeDir = process.env.HOME || '/Users/user';
    const assistantName = process.env.ASSISTANT_NAME || 'Andy';

    const replicateApiToken =
      process.env.REPLICATE_API_TOKEN ||
      process.env.REPLICATE_TTS_TOKEN ||
      process.env.OMNIPARSER_REPLICATE_TOKEN ||
      '';

    const supermemoryApiKey =
      process.env.SUPERMEMORY_API_KEY ||
      process.env.SUPERMEMORY_OPENCLAW_API_KEY ||
      process.env.SUPERMEMORY_CC_API_KEY ||
      '';

    const defaultCuaImage = 'trycua/cua-xfce:latest';
    const legacyCuaImage = 'trycua/cua-sandbox:latest';
    const configuredCuaImage =
      process.env.CUA_SANDBOX_IMAGE || defaultCuaImage;
    const cuaSandboxImage =
      configuredCuaImage === legacyCuaImage ? defaultCuaImage : configuredCuaImage;

    return {
      telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
      telegramOwnerId: process.env.TELEGRAM_OWNER_ID || '',

      defaultProvider: process.env.DEFAULT_PROVIDER || 'anthropic',
      defaultModel: process.env.DEFAULT_MODEL || '',

      assistantName,
      triggerPattern: new RegExp(`^@${escapeRegex(assistantName)}\\b`, 'i'),

      projectRoot,
      storeDir: path.resolve(projectRoot, 'store'),
      groupsDir: path.resolve(projectRoot, 'groups'),
      dataDir: path.resolve(projectRoot, 'data'),
      serviceLogsDir: path.resolve(projectRoot, 'logs', 'services'),
      mainGroupFolder: 'main',

      containerImage: process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest',
      containerAgentVersion: process.env.NANOCLAW_AGENT_VERSION || '1',
      containerTimeout: envInt('CONTAINER_TIMEOUT', 300_000),
      containerMaxOutputSize: envInt('CONTAINER_MAX_OUTPUT_SIZE', 10_485_760),
      maxConcurrentAgents: envInt('MAX_CONCURRENT_AGENTS', 4),
      maxConversationMessages: envInt('MAX_CONVERSATION_MESSAGES', 50),
      maxAgentRetries: envInt('MAX_AGENT_RETRIES', 7),
      agentRetryDelay: 2000,

      ipcPollInterval: 1000,
      schedulerPollInterval: 60_000,

      sandboxIdleTimeoutMs: envInt('SANDBOX_IDLE_TIMEOUT_MS', 30 * 60 * 1000),
      sandboxTailscaleEnabled: envBoolNotFalse('SANDBOX_TAILSCALE_ENABLED'),
      cuaTakeoverWebEnabled: envBoolNotFalse('CUA_TAKEOVER_WEB_ENABLED'),
      cuaTakeoverWebPort: envInt('CUA_TAKEOVER_WEB_PORT', 7788),
      cuaSandboxContainerName:
        process.env.CUA_SANDBOX_CONTAINER_NAME || 'nanoclaw-cua-sandbox',
      cuaSandboxImage,
      cuaSandboxPlatform: process.env.CUA_SANDBOX_PLATFORM || 'linux/amd64',
      cuaSandboxCommandPort: envInt('CUA_SANDBOX_COMMAND_PORT', 8000),
      cuaSandboxVncPort: envInt('CUA_SANDBOX_VNC_PORT', 5901),
      cuaSandboxNovncPort: envInt('CUA_SANDBOX_NOVNC_PORT', 6901),
      cuaSandboxScreenWidth: envInt('CUA_SANDBOX_SCREEN_WIDTH', 1024),
      cuaSandboxScreenHeight: envInt('CUA_SANDBOX_SCREEN_HEIGHT', 768),
      cuaSandboxScreenDepth: envInt('CUA_SANDBOX_SCREEN_DEPTH', 24),
      cuaSandboxShmSize: process.env.CUA_SANDBOX_SHM_SIZE || '512m',
      cuaSandboxPersist: envBoolNotFalse('CUA_SANDBOX_PERSIST'),
      cuaSandboxHomeVolume:
        process.env.CUA_SANDBOX_HOME_VOLUME || 'nanoclaw-cua-home',
      cuaApiKey: process.env.CUA_API_KEY || '',

      replicateApiToken,

      omniparserEnabled: envBool('OMNIPARSER_ENABLED', false),
      omniparserBoxThreshold: envFloat('OMNIPARSER_BOX_THRESHOLD', 0.05),
      omniparserIouThreshold: envFloat('OMNIPARSER_IOU_THRESHOLD', 0.1),
      omniparserTimeoutMs: envInt('OMNIPARSER_TIMEOUT_MS', 10_000),

      freyaTtsEnabled: envBool('FREYA_TTS_ENABLED', false),
      freyaApiKey: process.env.FREYA_API_KEY || '',
      freyaCharacterId: process.env.FREYA_CHARACTER_ID || 'Amika2',
      freyaLanguage: process.env.FREYA_LANGUAGE || 'English',
      freyaRateLimitPerMin: envInt('FREYA_RATE_LIMIT_PER_MIN', 8),
      qwenTtsEnabled: envBool('QWEN_TTS_ENABLED', false),
      qwenTtsUrl: process.env.QWEN_TTS_URL || '',
      qwenTtsApiKey: process.env.QWEN_TTS_API_KEY || '',
      qwenTtsDefaultLanguage:
        process.env.QWEN_TTS_DEFAULT_LANGUAGE || 'English',
      qwenTtsDefaultSpeaker: process.env.QWEN_TTS_DEFAULT_SPEAKER || 'Vivian',
      qwenTtsRateLimitPerMin: envInt('QWEN_TTS_RATE_LIMIT_PER_MIN', 10),
      replicateTtsEnabled: envBoolNotFalse('REPLICATE_TTS_ENABLED'),
      replicateTtsRateLimitPerMin: envInt('REPLICATE_TTS_RATE_LIMIT_PER_MIN', 10),
      replicateTtsTimeoutMs: envInt('REPLICATE_TTS_TIMEOUT_MS', 120_000),
      replicateTtsDefaultProvider:
        process.env.REPLICATE_TTS_DEFAULT_PROVIDER || 'qwen/qwen3-tts',
      replicateTtsDefaultSpeaker:
        process.env.REPLICATE_TTS_DEFAULT_SPEAKER || 'Vivian',

      openaiApiKey: process.env.OPENAI_API_KEY || '',
      openaiBaseUrl: process.env.OPENAI_BASE_URL || '',
      anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || '',
      firecrawlApiKey: process.env.FIRECRAWL_API_KEY || '',
      supermemoryApiKey,

      dashboardEnabled: envBoolNotFalse('DASHBOARD_ENABLED'),
      dashboardPort: envInt('DASHBOARD_PORT', 7789),
      dashboardUrl: process.env.DASHBOARD_URL || '',
      dashboardHttpsPort: envInt('DASHBOARD_HTTPS_PORT', 7790),
      cuaTakeoverHttpsPort: envInt('CUA_TAKEOVER_HTTPS_PORT', 7791),
      logRetentionDays: envInt('LOG_RETENTION_DAYS', 7),

      timezone:
        process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
      logLevel: process.env.LOG_LEVEL || 'info',
      maxThinkingTokens: envInt('MAX_THINKING_TOKENS', 10_000),
      debugThreads: envBool('DEBUG_THREADS', false),
    };
  })(),
);
