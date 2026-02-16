/**
 * SupermemoryLive — long-term memory via Supermemory HTTP API.
 *
 * Port of src/supermemory.ts (v1).
 */

import { Effect, Layer } from 'effect';

import { AppConfig } from '../config.js';
import { MemoryError } from '../errors.js';
import { Supermemory } from './Supermemory.js';
import type { SupermemoryService, MemorySearchResult } from './Supermemory.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const RETRIEVE_TIMEOUT_MS = 5000;
const STORE_TIMEOUT_MS = 10000;

// ─── Live Layer ─────────────────────────────────────────────────────────────

export const SupermemoryLive: Layer.Layer<Supermemory, never, AppConfig> =
  Layer.effect(
    Supermemory,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const apiKey = config.supermemoryApiKey;

      const containerTag = (groupFolder: string) =>
        `nanoclaw_${groupFolder}`;

      const service: SupermemoryService = {
        search: (query, groupFolder) =>
          Effect.gen(function* () {
            if (!apiKey || !query.trim()) {
              return { results: [] } satisfies MemorySearchResult;
            }

            const controller = new AbortController();
            const timer = setTimeout(
              () => controller.abort(),
              RETRIEVE_TIMEOUT_MS,
            );

            const result = yield* Effect.tryPromise({
              try: async () => {
                const { default: Supermemory } = await import('supermemory');
                const client = new Supermemory({
                  apiKey,
                  timeout: RETRIEVE_TIMEOUT_MS,
                });
                const res = await client.profile(
                  {
                    containerTag: containerTag(groupFolder),
                    q: query,
                  },
                  { signal: controller.signal },
                );
                clearTimeout(timer);
                return res;
              },
              catch: (err) => {
                clearTimeout(timer);
                return new MemoryError({
                  message: `Supermemory search failed: ${err instanceof Error ? err.message : String(err)}`,
                  cause: err,
                });
              },
            });

            const rawResults = (
              (result as unknown as Record<string, unknown>).searchResults as {
                results?: Array<{
                  memory?: string;
                  chunk?: string;
                  similarity?: number;
                }>;
              }
            )?.results ?? [];

            return {
              results: rawResults
                .map((r) => ({
                  content: r.memory || r.chunk || '',
                  score: r.similarity ?? 0,
                }))
                .filter((m) => m.content.trim()),
            } satisfies MemorySearchResult;
          }),

        save: (content, groupFolder, metadata) =>
          Effect.gen(function* () {
            if (!apiKey) return;

            yield* Effect.tryPromise({
              try: async () => {
                const { default: Supermemory } = await import('supermemory');
                const client = new Supermemory({
                  apiKey,
                  timeout: STORE_TIMEOUT_MS,
                });
                await client.add({
                  content,
                  containerTags: [containerTag(groupFolder)],
                  metadata: {
                    type: 'memory',
                    ...(metadata as Record<string, string> | undefined),
                  },
                });
              },
              catch: (err) =>
                new MemoryError({
                  message: `Supermemory save failed: ${err instanceof Error ? err.message : String(err)}`,
                  cause: err,
                }),
            });
          }),

        isEnabled: Effect.succeed(!!apiKey),
      };

      return service;
    }),
  );
