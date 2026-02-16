/**
 * Long-term memory tools: memory_save, memory_search (via Supermemory).
 */

import { z } from 'zod';
import Supermemory from 'supermemory';
import { Effect } from 'effect';
import type { NanoTool } from './types.js';
import { ToolError } from '../errors/index.js';
import { resolveSupermemoryApiKey } from './utils.js';

export const memoryTools: NanoTool[] = [
  {
    name: 'memory_save',
    description:
      'Save a note, fact, or piece of information to long-term memory (Supermemory). Use this to explicitly remember important context, preferences, or decisions that should persist across conversations.',
    schema: z.object({
      content: z
        .string()
        .describe(
          'The text content to save to memory. Can be a fact, note, summary, or any information worth remembering.',
        ),
      metadata: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          'Optional key-value metadata (e.g., {"category": "preference", "topic": "coding"})',
        ),
    }),
    handler: (args, ctx) =>
      Effect.gen(function* () {
        const resolvedSmKey = resolveSupermemoryApiKey();
        if (!resolvedSmKey) {
          return {
            content:
              'No Supermemory API key found. Set SUPERMEMORY_API_KEY (or SUPERMEMORY_OPENCLAW_API_KEY / SUPERMEMORY_CC_API_KEY).',
            isError: true as const,
          };
        }

        const result = yield* Effect.tryPromise({
          try: async () => {
            const sm = new Supermemory({ apiKey: resolvedSmKey.key });
            await sm.add({
              content: args.content as string,
              containerTags: [`nanoclaw_${ctx.groupFolder}`],
              metadata: {
                type: 'explicit_save',
                ...(args.metadata as Record<string, string> | undefined),
              },
            });
            return { content: 'Memory saved successfully.' };
          },
          catch: (err) =>
            new ToolError({
              toolName: 'memory_save',
              message: `Supermemory save error: ${err instanceof Error ? err.message : String(err)}`,
              cause: err,
            }),
        });

        return result;
      }),
  },

  {
    name: 'memory_search',
    description:
      'Search long-term memory (Supermemory) for relevant past information, conversations, and facts. Use this to recall context from previous conversations or explicitly saved memories.',
    schema: z.object({
      query: z
        .string()
        .describe(
          'Natural language search query describing what you want to recall',
        ),
      limit: z
        .number()
        .optional()
        .describe('Maximum number of results to return (default: 10)'),
    }),
    handler: (args, ctx) =>
      Effect.gen(function* () {
        const resolvedSmKey = resolveSupermemoryApiKey();
        if (!resolvedSmKey) {
          return {
            content:
              'No Supermemory API key found. Set SUPERMEMORY_API_KEY (or SUPERMEMORY_OPENCLAW_API_KEY / SUPERMEMORY_CC_API_KEY).',
            isError: true as const,
          };
        }

        const result = yield* Effect.tryPromise({
          try: async () => {
            const sm = new Supermemory({ apiKey: resolvedSmKey.key });
            const response = await sm.search.memories({
              q: args.query as string,
              containerTag: `nanoclaw_${ctx.groupFolder}`,
              searchMode: 'hybrid',
              limit: (args.limit as number | undefined) ?? 10,
            });

            const results = (response.results || [])
              .map(
                (r: {
                  memory?: string;
                  chunk?: string;
                  similarity?: number;
                }) => ({
                  text: r.memory || r.chunk || '',
                  similarity: r.similarity ?? 0,
                }),
              )
              .filter((r: { text: string }) => r.text.trim());

            if (results.length === 0) {
              return { content: 'No matching memories found.' };
            }

            const formatted = results
              .map(
                (r: { text: string; similarity: number }, i: number) =>
                  `${i + 1}. [relevance: ${r.similarity.toFixed(2)}] ${r.text}`,
              )
              .join('\n\n');

            return { content: `Found ${results.length} memories:\n\n${formatted}` };
          },
          catch: (err) =>
            new ToolError({
              toolName: 'memory_search',
              message: `Supermemory search error: ${err instanceof Error ? err.message : String(err)}`,
              cause: err,
            }),
        });

        return result;
      }),
  },
];
