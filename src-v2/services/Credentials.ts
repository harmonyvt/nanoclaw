/**
 * Credentials service — resolves API credentials with fallback chain.
 */

import { Context, Effect } from 'effect';
import type { CredentialError, OAuthRefreshError } from '../errors.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface CredentialResult {
  readonly source: 'dotenv' | 'keychain' | 'credentials-file' | 'oauth';
  readonly authType: 'api-key' | 'oauth-token';
  readonly envVars: Record<string, string>;
}

// ─── Service Interface ─────────────────────────────────────────────────────

export interface CredentialsService {
  /** Resolve auth credentials with fallback chain: .env → keychain → credentials.json */
  readonly resolve: Effect.Effect<CredentialResult, CredentialError>;

  /** Refresh OAuth token if expired */
  readonly refreshOAuth: Effect.Effect<void, OAuthRefreshError>;
}

export class Credentials extends Context.Tag('Credentials')<
  Credentials,
  CredentialsService
>() {}
