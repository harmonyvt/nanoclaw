import { createHmac, timingSafeEqual, randomUUID } from 'crypto';
import { TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_ID } from './config.js';

export interface AuthResult {
  valid: boolean;
  userId?: number;
  userName?: string;
  error?: string;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const sessions = new Map<string, { userId: number; expiresAt: number; groupFolder?: string }>();

/**
 * Validate Telegram WebApp initData using HMAC-SHA256.
 * See: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function validateTelegramInitData(initDataRaw: string): AuthResult {
  if (!initDataRaw) return { valid: false, error: 'missing initData' };
  if (!TELEGRAM_BOT_TOKEN) return { valid: false, error: 'bot token not configured' };

  try {
    const params = new URLSearchParams(initDataRaw);
    const hash = params.get('hash');
    if (!hash) return { valid: false, error: 'missing hash' };

    params.delete('hash');

    // Sort key=value pairs alphabetically and join with \n
    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    // secret_key = HMAC_SHA256("WebAppData", botToken)
    const secretKey = createHmac('sha256', 'WebAppData')
      .update(TELEGRAM_BOT_TOKEN)
      .digest();

    // computed_hash = hex(HMAC_SHA256(secret_key, data_check_string))
    const computedHash = createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    // Timing-safe comparison
    const hashBuffer = Buffer.from(hash, 'hex');
    const computedBuffer = Buffer.from(computedHash, 'hex');
    if (
      hashBuffer.length !== computedBuffer.length ||
      !timingSafeEqual(hashBuffer, computedBuffer)
    ) {
      return { valid: false, error: 'invalid hash' };
    }

    // Check auth_date is not older than 1 hour
    const authDate = params.get('auth_date');
    if (authDate) {
      const authTimestamp = parseInt(authDate, 10) * 1000;
      if (Date.now() - authTimestamp > 60 * 60 * 1000) {
        return { valid: false, error: 'expired initData' };
      }
    }

    // Extract and verify user
    const userJson = params.get('user');
    if (!userJson) return { valid: false, error: 'missing user data' };

    const user = JSON.parse(userJson);
    const userId = user.id;

    if (String(userId) !== TELEGRAM_OWNER_ID) {
      return { valid: false, error: 'unauthorized user' };
    }

    return {
      valid: true,
      userId,
      userName: user.first_name || user.username || String(userId),
    };
  } catch (e) {
    return { valid: false, error: `validation error: ${e}` };
  }
}

export function createSession(userId: number, groupFolder?: string): {
  token: string;
  expiresAt: number;
} {
  const token = randomUUID();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(token, { userId, expiresAt, groupFolder });
  return { token, expiresAt };
}

export function validateSession(
  token: string,
): { userId: number; groupFolder?: string } | null {
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return null;
  }
  return { userId: session.userId, groupFolder: session.groupFolder };
}

export function createSessionForOwner(groupFolder?: string): {
  token: string;
  expiresAt: number;
} | null {
  if (!TELEGRAM_OWNER_ID) return null;
  return createSession(Number(TELEGRAM_OWNER_ID), groupFolder);
}

export function cleanExpiredSessions(): void {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now > session.expiresAt) sessions.delete(token);
  }
}
