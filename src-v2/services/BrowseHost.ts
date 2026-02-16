/**
 * BrowseHost service — coordinates browse requests between containers and CUA sandbox.
 */

import { Context, Effect } from 'effect';
import type { BrowseError, BrowseWaitTimeoutError } from '../errors.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface BrowseResult {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

// ─── Service Interface ─────────────────────────────────────────────────────

export interface BrowseHostService {
  /** Process a browse action request from a container */
  readonly processAction: (
    sourceGroup: string,
    action: string,
    params: Record<string, unknown>,
  ) => Effect.Effect<BrowseResult, BrowseError>;

  /** Handle wait_for_user: returns when user returns control */
  readonly waitForUser: (
    requestId: string,
    groupFolder: string,
    message: string,
    chatJid?: string,
  ) => Effect.Effect<BrowseResult, BrowseError | BrowseWaitTimeoutError>;

  /** Resolve a waiting request (user clicked "continue") */
  readonly resolveWait: (
    groupFolder: string,
    requestId?: string,
  ) => Effect.Effect<boolean>;

  /** Cancel all waiting requests for a group */
  readonly cancelWaiting: (
    groupFolder: string,
    reason?: string,
  ) => Effect.Effect<number>;

  /** Check if group has pending wait requests */
  readonly hasWaitingRequests: (
    groupFolder: string,
  ) => Effect.Effect<boolean>;
}

export class BrowseHost extends Context.Tag('BrowseHost')<
  BrowseHost,
  BrowseHostService
>() {}
