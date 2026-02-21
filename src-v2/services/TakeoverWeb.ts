/**
 * TakeoverWeb service — secure wait_for_user takeover URL server.
 */

import { Context, Effect } from 'effect';

export interface PendingTakeoverRequest {
  readonly requestId: string;
  readonly groupFolder: string;
  readonly token: string;
  readonly createdAt: string;
  readonly message: string | null;
  readonly vncPassword: string | null;
}

export interface TakeoverWaitHandlers {
  readonly getByToken: (token: string) => PendingTakeoverRequest | null;
  readonly resolveByToken: (token: string) => boolean;
  readonly touch?: () => void | Promise<void>;
}

export interface TakeoverWebService {
  readonly start: Effect.Effect<void>;
  readonly setWaitHandlers: (
    handlers: TakeoverWaitHandlers,
  ) => Effect.Effect<void>;
  readonly getTakeoverBaseUrl: Effect.Effect<string | null>;
  readonly getTakeoverUrl: (
    token: string,
    sessionToken?: string,
  ) => Effect.Effect<string | null>;
}

export class TakeoverWeb extends Context.Tag('TakeoverWeb')<
  TakeoverWeb,
  TakeoverWebService
>() {}
