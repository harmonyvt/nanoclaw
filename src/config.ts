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

// Sandbox configuration (CUA desktop sandbox)
export const SANDBOX_IDLE_TIMEOUT_MS = parseInt(
  process.env.SANDBOX_IDLE_TIMEOUT_MS || `${30 * 60 * 1000}`,
  10,
);
export const SANDBOX_TAILSCALE_ENABLED =
  process.env.SANDBOX_TAILSCALE_ENABLED !== 'false';
export const CUA_SANDBOX_CONTAINER_NAME =
  process.env.CUA_SANDBOX_CONTAINER_NAME || 'nanoclaw-cua-sandbox';
export const CUA_SANDBOX_IMAGE =
  process.env.CUA_SANDBOX_IMAGE || 'trycua/cua-sandbox:latest';
export const CUA_SANDBOX_COMMAND_PORT = parseInt(
  process.env.CUA_SANDBOX_COMMAND_PORT || '8000',
  10,
);
export const CUA_SANDBOX_VNC_PORT = parseInt(
  process.env.CUA_SANDBOX_VNC_PORT || '5900',
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
export const CUA_API_KEY = process.env.CUA_API_KEY || '';

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

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
