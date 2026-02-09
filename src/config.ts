import path from 'path';

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Andy';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// When true, appends the session/thread ID to outgoing messages for debugging
export const DEBUG_THREADS = process.env.DEBUG_THREADS === 'true';

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || '/Users/user';

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '300000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;

// Agent retry on container error (self-heal)
export const MAX_AGENT_RETRIES = parseInt(process.env.MAX_AGENT_RETRIES || '7', 10);
export const AGENT_RETRY_DELAY = 2000; // ms between retries

// Sandbox configuration (CUA desktop sandbox)
export const SANDBOX_IDLE_TIMEOUT_MS = parseInt(
  process.env.SANDBOX_IDLE_TIMEOUT_MS || `${30 * 60 * 1000}`,
  10,
);
export const SANDBOX_TAILSCALE_ENABLED =
  process.env.SANDBOX_TAILSCALE_ENABLED !== 'false';
export const CUA_TAKEOVER_WEB_ENABLED =
  process.env.CUA_TAKEOVER_WEB_ENABLED !== 'false';
export const CUA_TAKEOVER_WEB_PORT = parseInt(
  process.env.CUA_TAKEOVER_WEB_PORT || '7788',
  10,
);
export const CUA_SANDBOX_CONTAINER_NAME =
  process.env.CUA_SANDBOX_CONTAINER_NAME || 'nanoclaw-cua-sandbox';
const DEFAULT_CUA_SANDBOX_IMAGE = 'trycua/cua-xfce:latest';
const LEGACY_CUA_SANDBOX_IMAGE = 'trycua/cua-sandbox:latest';
const configuredCuaSandboxImage =
  process.env.CUA_SANDBOX_IMAGE || DEFAULT_CUA_SANDBOX_IMAGE;
export const CUA_SANDBOX_IMAGE_IS_LEGACY =
  configuredCuaSandboxImage === LEGACY_CUA_SANDBOX_IMAGE;
export const CUA_SANDBOX_IMAGE = CUA_SANDBOX_IMAGE_IS_LEGACY
  ? DEFAULT_CUA_SANDBOX_IMAGE
  : configuredCuaSandboxImage;
export const CUA_SANDBOX_PLATFORM =
  process.env.CUA_SANDBOX_PLATFORM || 'linux/amd64';
export const CUA_SANDBOX_COMMAND_PORT = parseInt(
  process.env.CUA_SANDBOX_COMMAND_PORT || '8000',
  10,
);
export const CUA_SANDBOX_VNC_PORT = parseInt(
  process.env.CUA_SANDBOX_VNC_PORT || '5901',
  10,
);
export const CUA_SANDBOX_NOVNC_PORT = parseInt(
  process.env.CUA_SANDBOX_NOVNC_PORT || '6901',
  10,
);
export const CUA_SANDBOX_SCREEN_WIDTH = parseInt(
  process.env.CUA_SANDBOX_SCREEN_WIDTH || '1024',
  10,
);
export const CUA_SANDBOX_SCREEN_HEIGHT = parseInt(
  process.env.CUA_SANDBOX_SCREEN_HEIGHT || '768',
  10,
);
export const CUA_SANDBOX_SCREEN_DEPTH = parseInt(
  process.env.CUA_SANDBOX_SCREEN_DEPTH || '24',
  10,
);
export const CUA_SANDBOX_SHM_SIZE = process.env.CUA_SANDBOX_SHM_SIZE || '512m';
export const CUA_API_KEY = process.env.CUA_API_KEY || '';

// CUA sandbox persistence (default: true)
// When enabled, sandbox container is stopped (not removed) on idle/shutdown,
// and restarted on next use. Named volume persists /home/cua across container recreates.
export const CUA_SANDBOX_PERSIST = process.env.CUA_SANDBOX_PERSIST !== 'false';
export const CUA_SANDBOX_HOME_VOLUME =
  process.env.CUA_SANDBOX_HOME_VOLUME || 'nanoclaw-cua-home';

// Freya TTS configuration (disabled by default, set FREYA_TTS_ENABLED=true to enable)
export const FREYA_TTS_ENABLED = process.env.FREYA_TTS_ENABLED === 'true';
export const FREYA_API_KEY = process.env.FREYA_API_KEY || '';
export const FREYA_CHARACTER_ID = process.env.FREYA_CHARACTER_ID || 'Amika2';
export const FREYA_LANGUAGE = process.env.FREYA_LANGUAGE || 'English';
export const FREYA_RATE_LIMIT_PER_MIN = parseInt(
  process.env.FREYA_RATE_LIMIT_PER_MIN || '8',
  10,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Telegram configuration
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
export const TELEGRAM_OWNER_ID = process.env.TELEGRAM_OWNER_ID || '';

/** Check if a chat ID is a Telegram chat (prefixed with `tg:`) */
export function isTelegramChat(id: string): boolean {
  return id.startsWith('tg:');
}

/** Prepend `tg:` to a numeric Telegram chat ID for DB storage */
export function makeTelegramChatId(chatId: number): string {
  return `tg:${chatId}`;
}

/** Strip `tg:` prefix and return the numeric Telegram chat ID */
export function extractTelegramChatId(id: string): number {
  return Number(id.slice(3));
}

// Dashboard configuration
export const DASHBOARD_ENABLED = process.env.DASHBOARD_ENABLED !== 'false';
export const DASHBOARD_PORT = parseInt(
  process.env.DASHBOARD_PORT || '7789',
  10,
);
export const LOG_RETENTION_DAYS = parseInt(
  process.env.LOG_RETENTION_DAYS || '7',
  10,
);
export const DASHBOARD_TLS_CERT = process.env.DASHBOARD_TLS_CERT || '';
export const DASHBOARD_TLS_KEY = process.env.DASHBOARD_TLS_KEY || '';
// Explicit HTTPS URL for Telegram Web App (e.g. from tailscale serve/funnel).
// When set, used for the menu button and /dashboard command instead of auto-detected URL.
export const DASHBOARD_URL = process.env.DASHBOARD_URL || '';
// HTTPS ports used by tailscale serve reverse proxy
export const DASHBOARD_HTTPS_PORT = parseInt(
  process.env.DASHBOARD_HTTPS_PORT || '7790',
  10,
);
export const CUA_TAKEOVER_HTTPS_PORT = parseInt(
  process.env.CUA_TAKEOVER_HTTPS_PORT || '7791',
  10,
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Default AI provider configuration
// Groups without explicit providerConfig use these values
export const DEFAULT_PROVIDER = process.env.DEFAULT_PROVIDER || 'anthropic';
export const DEFAULT_MODEL = process.env.DEFAULT_MODEL || '';
