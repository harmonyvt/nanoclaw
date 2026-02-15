/**
 * Effect service: Long-term Memory (Supermemory)
 *
 * Wraps the optional Supermemory integration for persistent
 * memory storage and retrieval.
 */
import { Context, Effect, Layer } from 'effect';

import {
  isSupermemoryEnabled,
  retrieveMemories,
  storeInteraction,
  formatMemoryContext,
} from '../../supermemory.js';
import type { MemoryContext } from '../../supermemory.js';

export type { MemoryContext };

export interface MemoryService {
  readonly isEnabled: () => boolean;
  readonly retrieve: (groupFolder: string, query: string) => Effect.Effect<MemoryContext | null>;
  readonly store: (
    groupFolder: string,
    messagesXml: string,
    response: string,
    opts: { timestamp: string; groupName: string },
  ) => Effect.Effect<void>;
  readonly formatContext: (ctx: MemoryContext) => string;
}

export class Memory extends Context.Tag('nanoclaw/Memory')<
  Memory,
  MemoryService
>() {}

export const MemoryLive = Layer.succeed(Memory, {
  isEnabled: isSupermemoryEnabled,
  retrieve: (groupFolder, query) =>
    Effect.promise(() => retrieveMemories(groupFolder, query)),
  store: (groupFolder, messagesXml, response, opts) =>
    Effect.promise(() => storeInteraction(groupFolder, messagesXml, response, opts)),
  formatContext: formatMemoryContext,
} satisfies MemoryService);
