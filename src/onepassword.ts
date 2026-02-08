/**
 * 1Password SDK integration for host-side secret resolution.
 * Loads secrets from a dedicated 1Password vault into process.env at startup.
 * Falls back gracefully when 1Password is not configured.
 */

import sdk from '@1password/sdk';
import { logger } from './logger.js';

/** Maps environment variable names to 1Password secret references. */
const SECRET_REFS: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: 'op://Agent/Telegram/bot-token',
  TELEGRAM_OWNER_ID: 'op://Agent/Telegram/owner-id',
  OPENAI_API_KEY: 'op://Agent/OpenAI/credential',
  FIRECRAWL_API_KEY: 'op://Agent/Firecrawl/credential',
  SUPERMEMORY_API_KEY: 'op://Agent/Supermemory/credential',
  FREYA_API_KEY: 'op://Agent/Freya/credential',
};

export function isOnePasswordEnabled(): boolean {
  return !!process.env.OP_SERVICE_ACCOUNT_TOKEN;
}

/**
 * Resolve all secrets from 1Password and load them into process.env.
 * Only sets vars not already present — explicit env takes precedence.
 * Returns count of secrets successfully loaded.
 */
export async function loadSecretsIntoEnv(): Promise<number> {
  if (!isOnePasswordEnabled()) return 0;

  logger.info('1Password: initializing SDK client...');
  let client: Awaited<ReturnType<typeof sdk.createClient>>;
  try {
    client = await sdk.createClient({
      auth: process.env.OP_SERVICE_ACCOUNT_TOKEN!,
      integrationName: 'Agent Host',
      integrationVersion: '1.0.0',
    });
    logger.info('1Password: SDK client ready');
  } catch (err) {
    logger.warn({ err }, '1Password: client initialization failed, falling back to .env');
    return 0;
  }

  let loaded = 0;
  const skipped: string[] = [];
  const resolved: string[] = [];
  const failed: string[] = [];

  for (const [envVar, ref] of Object.entries(SECRET_REFS)) {
    // Don't overwrite existing env vars
    if (process.env[envVar]?.trim()) {
      skipped.push(envVar);
      continue;
    }

    try {
      const value = await client.secrets.resolve(ref);
      if (value) {
        process.env[envVar] = value;
        loaded++;
        resolved.push(envVar);
      }
    } catch {
      // Secret doesn't exist in vault — not all secrets are required
      failed.push(envVar);
    }
  }

  if (resolved.length > 0) {
    logger.info({ secrets: resolved }, `1Password: resolved ${resolved.length} secret(s)`);
  }
  if (skipped.length > 0) {
    logger.debug({ secrets: skipped }, `1Password: skipped ${skipped.length} (already in env)`);
  }
  if (failed.length > 0) {
    logger.debug({ secrets: failed }, `1Password: ${failed.length} not found in vault (optional)`);
  }

  return loaded;
}
