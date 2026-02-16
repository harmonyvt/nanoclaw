/**
 * CredentialsLive — resolves API credentials with fallback chain.
 *
 * Fallback: .env → macOS Keychain → ~/.claude/.credentials.json
 * Port of resolveCredentials() + refreshOAuthToken() from src/container-runner.ts (v1).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, execSync } from 'child_process';
import { Effect, Layer, Ref } from 'effect';

import { AppConfig } from '../config.js';
import { CredentialError, OAuthRefreshError } from '../errors.js';
import { Credentials } from './Credentials.js';
import type { CredentialResult, CredentialsService } from './Credentials.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REFRESH_THRESHOLD_MS = 15 * 60 * 1000;
const REFRESH_DEBOUNCE_MS = 2 * 60 * 1000;

/** Non-auth API keys always extracted from .env regardless of auth source */
const EXTRA_VARS = [
  'OPENAI_API_KEY',
  'OPENAI_MEDIA_API_KEY',
  'MINIMAX_API_KEY',
  'FIRECRAWL_API_KEY',
  'REPLICATE_API_TOKEN',
  'SUPERMEMORY_API_KEY',
  'SUPERMEMORY_OPENCLAW_API_KEY',
  'SUPERMEMORY_CC_API_KEY',
  'COMPOSITE_AI_ENABLED',
  'OPENAI_BASE_URL',
  'OPENAI_MEDIA_BASE_URL',
  'OPENAI_MEDIA_MODEL',
  'OPENAI_MEDIA_VISION_MODEL',
  'OPENAI_MEDIA_AUDIO_MODEL',
  'ANTHROPIC_BASE_URL',
];

const AUTH_VARS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];

// ─── Helpers ────────────────────────────────────────────────────────────────

function getHomeDir(): string {
  return process.env.HOME || os.homedir() || '/Users/user';
}

function parseEnvLines(
  envContent: string,
  varNames: string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx);
    const val = line.slice(eqIdx + 1);
    if (!val) continue;
    if (varNames.includes(key)) {
      result[key] = val;
    }
  }
  return result;
}

function readKeychainCredentials(): {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  source: 'keychain';
} | null {
  if (process.platform !== 'darwin') return null;
  try {
    const raw = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const oauth = parsed?.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt,
      source: 'keychain',
    };
  } catch {
    return null;
  }
}

function readCredentialsFile(): {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  source: 'credentials-file';
} | null {
  try {
    const credPath = path.join(getHomeDir(), '.claude', '.credentials.json');
    if (!fs.existsSync(credPath)) return null;
    const raw = fs.readFileSync(credPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const oauth = parsed?.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt,
      source: 'credentials-file',
    };
  } catch {
    return null;
  }
}

// ─── Live Layer ─────────────────────────────────────────────────────────────

export const CredentialsLive: Layer.Layer<
  Credentials,
  never,
  AppConfig
> = Layer.effect(
  Credentials,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const lastRefreshRef = yield* Ref.make<number>(0);

    const resolve: CredentialsService['resolve'] = Effect.gen(function* () {
      const projectRoot = config.projectRoot;
      const envFile = path.join(projectRoot, '.env');

      // Read .env once for both extra and auth vars
      let extraVars: Record<string, string> = {};
      let authVars: Record<string, string> = {};
      if (fs.existsSync(envFile)) {
        const envContent = fs.readFileSync(envFile, 'utf-8');
        extraVars = parseEnvLines(envContent, EXTRA_VARS);
        authVars = parseEnvLines(envContent, AUTH_VARS);
      }

      // Priority 1: .env file for auth
      if (Object.keys(authVars).length > 0) {
        return {
          source: 'dotenv' as const,
          authType: 'api-key' as const,
          envVars: { ...authVars, ...extraVars },
        };
      }

      // Priority 2: macOS Keychain
      const keychainCreds = readKeychainCredentials();
      if (keychainCreds) {
        return {
          source: 'keychain' as const,
          authType: 'oauth-token' as const,
          envVars: {
            CLAUDE_CODE_OAUTH_TOKEN: keychainCreds.accessToken,
            ...extraVars,
          },
        };
      }

      // Priority 3: ~/.claude/.credentials.json
      const fileCreds = readCredentialsFile();
      if (fileCreds) {
        return {
          source: 'credentials-file' as const,
          authType: 'oauth-token' as const,
          envVars: {
            CLAUDE_CODE_OAUTH_TOKEN: fileCreds.accessToken,
            ...extraVars,
          },
        };
      }

      // Return what we have (may just be extra vars with no auth)
      if (Object.keys(extraVars).length > 0) {
        return {
          source: 'dotenv' as const,
          authType: 'api-key' as const,
          envVars: extraVars,
        };
      }

      return yield* Effect.fail(
        new CredentialError({
          message: 'No credentials found in .env, keychain, or credentials file',
          source: 'none',
        }),
      );
    });

    const refreshOAuth: CredentialsService['refreshOAuth'] = Effect.gen(
      function* () {
        const now = Date.now();
        const lastRefresh = yield* Ref.get(lastRefreshRef);

        // Debounce
        if (now - lastRefresh < REFRESH_DEBOUNCE_MS) return;

        // Read full OAuth credentials (with refresh token)
        const keychainCreds = readKeychainCredentials();
        const fileCreds = readCredentialsFile();
        const creds = keychainCreds || fileCreds;

        if (!creds?.refreshToken) return;

        // Check if refresh is needed
        if (creds.expiresAt && creds.expiresAt - now > REFRESH_THRESHOLD_MS) {
          return; // Token still valid
        }

        yield* Ref.set(lastRefreshRef, now);

        // POST to refresh endpoint
        const response = yield* Effect.tryPromise({
          try: async () => {
            const body = new URLSearchParams({
              grant_type: 'refresh_token',
              refresh_token: creds.refreshToken!,
              client_id: OAUTH_CLIENT_ID,
            });
            const res = await fetch(OAUTH_TOKEN_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: body.toString(),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
            return (await res.json()) as {
              access_token?: string;
              refresh_token?: string;
              expires_in?: number;
            };
          },
          catch: (err) =>
            new OAuthRefreshError({
              message: `OAuth refresh failed: ${err instanceof Error ? err.message : String(err)}`,
              cause: err,
            }),
        });

        if (!response.access_token) return;

        // Write refreshed credentials back
        const homeDir = getHomeDir();
        const credPath = path.join(homeDir, '.claude', '.credentials.json');

        yield* Effect.try({
          try: () => {
            let fullJson: Record<string, unknown> = {};
            try {
              if (fs.existsSync(credPath)) {
                fullJson = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
              }
            } catch {
              /* start fresh */
            }

            const existing =
              (fullJson.claudeAiOauth as Record<string, unknown>) || {};
            fullJson.claudeAiOauth = {
              ...existing,
              accessToken: response.access_token,
              expiresAt: now + (response.expires_in ?? 3600) * 1000,
              ...(response.refresh_token
                ? { refreshToken: response.refresh_token }
                : {}),
            };

            const jsonStr = JSON.stringify(fullJson);
            const credDir = path.dirname(credPath);
            if (!fs.existsSync(credDir))
              fs.mkdirSync(credDir, { recursive: true });
            fs.writeFileSync(credPath, jsonStr, {
              encoding: 'utf-8',
              mode: 0o600,
            });

            // On macOS, also update keychain
            if (process.platform === 'darwin' && creds.source === 'keychain') {
              const account = os.userInfo().username;
              try {
                execFileSync(
                  'security',
                  [
                    'delete-generic-password',
                    '-s',
                    'Claude Code-credentials',
                  ],
                  { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' },
                );
              } catch {
                /* may not exist */
              }
              execFileSync(
                'security',
                [
                  'add-generic-password',
                  '-s',
                  'Claude Code-credentials',
                  '-a',
                  account,
                  '-w',
                  jsonStr,
                ],
                { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' },
              );
            }
          },
          catch: () =>
            new OAuthRefreshError({
              message: 'Failed to write refreshed credentials',
            }),
        });
      },
    );

    return { resolve, refreshOAuth };
  }),
);
