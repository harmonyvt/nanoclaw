/**
 * DashboardSession service — in-memory owner session lifecycle for takeover links.
 */

import { Context, Effect } from 'effect';

export interface AuthResult {
  readonly valid: boolean;
  readonly userId?: number;
  readonly userName?: string;
  readonly error?: string;
}

export interface DashboardSessionInfo {
  readonly userId: number;
  readonly groupFolder?: string;
}

export interface DashboardSessionToken {
  readonly token: string;
  readonly expiresAt: number;
}

export interface DashboardSessionService {
  readonly validateTelegramInitData: (
    initDataRaw: string,
  ) => Effect.Effect<AuthResult>;

  readonly createSession: (
    userId: number,
    groupFolder?: string,
  ) => Effect.Effect<DashboardSessionToken>;

  readonly validateSession: (
    token: string,
  ) => Effect.Effect<DashboardSessionInfo | null>;

  readonly createSessionForOwner: (
    groupFolder?: string,
  ) => Effect.Effect<DashboardSessionToken | null>;

  readonly cleanExpiredSessions: Effect.Effect<void>;
}

export class DashboardSession extends Context.Tag('DashboardSession')<
  DashboardSession,
  DashboardSessionService
>() {}
