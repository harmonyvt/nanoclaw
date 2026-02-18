/**
 * DashboardSessionLive — in-memory secure session store.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { Effect, Layer, Ref } from 'effect';

import { AppConfig } from '../config.js';
import { DashboardSession } from './DashboardSession.js';
import type {
  AuthResult,
  DashboardSessionInfo,
  DashboardSessionService,
  DashboardSessionToken,
} from './DashboardSession.js';

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

type SessionRecord = {
  readonly userId: number;
  readonly expiresAt: number;
  readonly groupFolder?: string;
};

export const DashboardSessionLive: Layer.Layer<
  DashboardSession,
  never,
  AppConfig
> = Layer.effect(
  DashboardSession,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const sessionsRef = yield* Ref.make<Map<string, SessionRecord>>(new Map());

    const cleanExpired = Ref.update(sessionsRef, (sessions) => {
      const now = Date.now();
      const next = new Map<string, SessionRecord>();
      for (const [token, session] of sessions.entries()) {
        if (now <= session.expiresAt) {
          next.set(token, session);
        }
      }
      return next;
    });

    const createSession = (
      userId: number,
      groupFolder?: string,
    ): Effect.Effect<DashboardSessionToken> =>
      Effect.gen(function* () {
        yield* cleanExpired;
        const token = randomUUID();
        const expiresAt = Date.now() + SESSION_TTL_MS;
        yield* Ref.update(sessionsRef, (sessions) => {
          const next = new Map(sessions);
          next.set(token, { userId, expiresAt, groupFolder });
          return next;
        });
        return { token, expiresAt };
      });

    const validateSession = (
      token: string,
    ): Effect.Effect<DashboardSessionInfo | null> =>
      Effect.gen(function* () {
        if (!token) return null;
        const sessions = yield* Ref.get(sessionsRef);
        const session = sessions.get(token);
        if (!session) return null;
        if (Date.now() > session.expiresAt) {
          yield* Ref.update(sessionsRef, (current) => {
            const next = new Map(current);
            next.delete(token);
            return next;
          });
          return null;
        }
        return {
          userId: session.userId,
          groupFolder: session.groupFolder,
        };
      });

    const validateTelegramInitData = (
      initDataRaw: string,
    ): Effect.Effect<AuthResult> =>
      Effect.sync(() => {
        if (!initDataRaw) {
          return { valid: false, error: 'missing initData' } satisfies AuthResult;
        }
        if (!config.telegramBotToken) {
          return {
            valid: false,
            error: 'bot token not configured',
          } satisfies AuthResult;
        }

        try {
          const params = new URLSearchParams(initDataRaw);
          const hash = params.get('hash');
          if (!hash) {
            return { valid: false, error: 'missing hash' } satisfies AuthResult;
          }

          params.delete('hash');
          const dataCheckString = Array.from(params.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`)
            .join('\n');

          const secretKey = createHmac('sha256', 'WebAppData')
            .update(config.telegramBotToken)
            .digest();

          const computedHash = createHmac('sha256', secretKey)
            .update(dataCheckString)
            .digest('hex');

          const hashBuffer = Buffer.from(hash, 'hex');
          const computedBuffer = Buffer.from(computedHash, 'hex');

          if (
            hashBuffer.length !== computedBuffer.length ||
            !timingSafeEqual(hashBuffer, computedBuffer)
          ) {
            return { valid: false, error: 'invalid hash' } satisfies AuthResult;
          }

          const authDate = params.get('auth_date');
          if (authDate) {
            const authTimestamp = parseInt(authDate, 10) * 1000;
            if (Date.now() - authTimestamp > 60 * 60 * 1000) {
              return {
                valid: false,
                error: 'expired initData',
              } satisfies AuthResult;
            }
          }

          const userJson = params.get('user');
          if (!userJson) {
            return {
              valid: false,
              error: 'missing user data',
            } satisfies AuthResult;
          }

          const user = JSON.parse(userJson) as {
            id?: unknown;
            first_name?: string;
            username?: string;
          };

          if (typeof user.id !== 'number') {
            return { valid: false, error: 'invalid user data' } satisfies AuthResult;
          }

          if (String(user.id) !== config.telegramOwnerId) {
            return {
              valid: false,
              error: 'unauthorized user',
            } satisfies AuthResult;
          }

          return {
            valid: true,
            userId: user.id,
            userName: user.first_name || user.username || String(user.id),
          } satisfies AuthResult;
        } catch (error) {
          return {
            valid: false,
            error: `validation error: ${String(error)}`,
          } satisfies AuthResult;
        }
      });

    const service: DashboardSessionService = {
      validateTelegramInitData,
      createSession,
      validateSession,
      createSessionForOwner: (groupFolder?: string) =>
        Effect.gen(function* () {
          if (!config.telegramOwnerId) return null;
          const userId = Number(config.telegramOwnerId);
          if (!Number.isFinite(userId)) return null;
          return yield* createSession(userId, groupFolder);
        }),
      cleanExpiredSessions: cleanExpired,
    };

    return service;
  }),
);
