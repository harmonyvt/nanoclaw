/**
 * BrowseHost service — coordinates browse requests between containers and CUA sandbox.
 */

import { Context, Effect } from 'effect';
import type { BrowseError, BrowseWaitTimeoutError } from '../errors.js';

export type ScreenshotPayload = {
  readonly path: string;
  readonly mimeType: string;
  readonly base64: string;
  readonly analysisSource: 'omniparser' | 'accessibility';
  readonly metadataPath?: string;
};

export type ScreenshotGrid = {
  readonly rows: number;
  readonly cols: number;
  readonly width: number;
  readonly height: number;
};

export type ScreenshotAnalysisElement = {
  readonly id: number;
  readonly label: string;
  readonly role: string | null;
  readonly interactive: boolean;
  readonly center: { x: number; y: number };
  readonly bounds: { x: number; y: number; width: number; height: number };
  readonly grid: { row: number; col: number; key: string };
};

export type ScreenshotAnalysis = {
  readonly capturedAt: string;
  readonly grid: ScreenshotGrid;
  readonly elementCount: number;
  readonly truncated: boolean;
  readonly elements: ReadonlyArray<ScreenshotAnalysisElement>;
  metadataPath?: string;
  summary: string;
};

// ─── Types ─────────────────────────────────────────────────────────────────

export interface BrowseResult {
  readonly status: 'ok' | 'error';
  readonly result?: unknown;
  readonly error?: string;
  readonly analysis?: ScreenshotAnalysis;
  readonly screenshot?: ScreenshotPayload;
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

  /** Resolve waiting request by takeover token */
  readonly resolveWaitByToken: (token: string) => Effect.Effect<boolean>;

  /** Look up waiting request by takeover token */
  readonly getWaitByToken: (
    token: string,
  ) => Effect.Effect<
    {
      requestId: string;
      groupFolder: string;
      token: string;
      createdAt: string;
      message: string | null;
      vncPassword: string | null;
    } | null
  >;

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
