/**
 * Supermemory service — long-term memory integration.
 */

import { Context, Effect } from 'effect';
import type { MemoryError } from '../errors.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface MemorySearchResult {
  readonly results: ReadonlyArray<{
    readonly content: string;
    readonly score: number;
    readonly metadata?: Record<string, unknown>;
  }>;
}

// ─── Service Interface ─────────────────────────────────────────────────────

export interface SupermemoryService {
  /** Search long-term memory */
  readonly search: (
    query: string,
    groupFolder: string,
  ) => Effect.Effect<MemorySearchResult, MemoryError>;

  /** Save a memory */
  readonly save: (
    content: string,
    groupFolder: string,
    metadata?: Record<string, unknown>,
  ) => Effect.Effect<void, MemoryError>;

  /** Check if Supermemory is configured */
  readonly isEnabled: Effect.Effect<boolean>;
}

export class Supermemory extends Context.Tag('Supermemory')<
  Supermemory,
  SupermemoryService
>() {}
