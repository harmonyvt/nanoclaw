/**
 * Effect service: Browser Automation
 *
 * Wraps the CUA browser bridge (browse-host.ts) into an Effect service.
 */
import { Context, Effect, Layer } from 'effect';

import {
  cancelWaitingRequests,
  processBrowseRequest,
  resolveWaitForUser,
  hasWaitingRequests,
  disconnectBrowser,
  ensureWaitForUserRequest,
} from '../../browse-host.js';

export interface BrowseService {
  readonly processBrowseRequest: (
    requestId: string,
    action: string,
    params: Record<string, unknown>,
    groupFolder: string,
    ipcDir: string,
  ) => Effect.Effect<Record<string, unknown>>;
  readonly cancelWaitingRequests: (groupFolder: string) => void;
  readonly resolveWaitForUser: (groupFolder: string, requestId?: string) => boolean;
  readonly hasWaitingRequests: (groupFolder: string) => boolean;
  readonly disconnect: () => Effect.Effect<void>;
  readonly ensureWaitForUserRequest: (
    requestId: string,
    groupFolder: string,
    message: string,
  ) => unknown;
}

export class Browse extends Context.Tag('nanoclaw/Browse')<
  Browse,
  BrowseService
>() {}

export const BrowseLive = Layer.scoped(
  Browse,
  Effect.acquireRelease(
    Effect.succeed({
      processBrowseRequest: (requestId, action, params, groupFolder, ipcDir) =>
        Effect.promise(() => processBrowseRequest(requestId, action, params, groupFolder, ipcDir) as Promise<Record<string, unknown>>),
      cancelWaitingRequests,
      resolveWaitForUser,
      hasWaitingRequests,
      disconnect: () => Effect.promise(() => disconnectBrowser()),
      ensureWaitForUserRequest,
    } satisfies BrowseService),
    () =>
      Effect.promise(() => disconnectBrowser()),
  ),
);
