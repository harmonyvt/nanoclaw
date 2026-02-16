/**
 * Firecrawl web crawling tools: firecrawl_scrape, firecrawl_crawl, firecrawl_map.
 */

import { z } from 'zod';
import { Effect } from 'effect';
import type { NanoTool } from './types.js';
import { ToolError } from '../errors/index.js';

export const firecrawlTools: NanoTool[] = [
  {
    name: 'firecrawl_scrape',
    description:
      'Scrape a single URL and return its content as markdown. Useful for reading web pages, articles, documentation, etc.',
    schema: z.object({
      url: z.string().describe('The URL to scrape'),
      formats: z
        .array(z.string())
        .optional()
        .describe('Output formats (default: ["markdown"])'),
    }),
    handler: (args) =>
      Effect.gen(function* () {
        const apiKey = process.env.FIRECRAWL_API_KEY;
        if (!apiKey) {
          return {
            content:
              'FIRECRAWL_API_KEY is not set. Ask the admin to configure the Firecrawl API key.',
            isError: true as const,
          };
        }

        const result = yield* Effect.tryPromise({
          try: async () => {
            const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                url: args.url as string,
                formats: (args.formats as string[] | undefined) ?? ['markdown'],
              }),
            });

            if (res.status === 429) {
              return {
                content: 'Firecrawl rate limit exceeded. Please wait a moment and try again.',
                isError: true as const,
              };
            }

            if (!res.ok) {
              const body = await res.text();
              return {
                content: `Firecrawl scrape failed (HTTP ${res.status}): ${body.slice(0, 500)}`,
                isError: true as const,
              };
            }

            const json = (await res.json()) as {
              success: boolean;
              data?: { markdown?: string };
            };
            if (!json.success || !json.data?.markdown) {
              return {
                content: `Firecrawl scrape returned no markdown content. Response: ${JSON.stringify(json).slice(0, 500)}`,
                isError: true as const,
              };
            }

            const MAX_SIZE = 50 * 1024;
            let markdown = json.data.markdown;
            if (markdown.length > MAX_SIZE) {
              markdown = markdown.slice(0, MAX_SIZE) + '\n\n[Content truncated at 50KB]';
            }

            return { content: markdown };
          },
          catch: (err) =>
            new ToolError({
              toolName: 'firecrawl_scrape',
              message: `Firecrawl scrape error: ${err instanceof Error ? err.message : String(err)}`,
              cause: err,
            }),
        });

        return result;
      }),
  },

  {
    name: 'firecrawl_crawl',
    description:
      'Crawl a website starting from a URL, following links up to a depth limit. Returns markdown content for each page found. Useful for indexing documentation sites or exploring a domain.',
    schema: z.object({
      url: z.string().describe('The starting URL to crawl'),
      limit: z
        .number()
        .optional()
        .describe('Max number of pages to crawl (default: 10)'),
      maxDepth: z
        .number()
        .optional()
        .describe('Max link depth to follow (default: 2)'),
    }),
    handler: (args) =>
      Effect.gen(function* () {
        const apiKey = process.env.FIRECRAWL_API_KEY;
        if (!apiKey) {
          return {
            content:
              'FIRECRAWL_API_KEY is not set. Ask the admin to configure the Firecrawl API key.',
            isError: true as const,
          };
        }

        const result = yield* Effect.tryPromise({
          try: async () => {
            // Start the crawl job
            const startRes = await fetch('https://api.firecrawl.dev/v1/crawl', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                url: args.url as string,
                limit: (args.limit as number | undefined) ?? 10,
                maxDepth: (args.maxDepth as number | undefined) ?? 2,
              }),
            });

            if (startRes.status === 429) {
              return {
                content: 'Firecrawl rate limit exceeded. Please wait a moment and try again.',
                isError: true as const,
              };
            }

            if (!startRes.ok) {
              const body = await startRes.text();
              return {
                content: `Firecrawl crawl failed to start (HTTP ${startRes.status}): ${body.slice(0, 500)}`,
                isError: true as const,
              };
            }

            const startJson = (await startRes.json()) as {
              success: boolean;
              id?: string;
            };
            if (!startJson.success || !startJson.id) {
              return {
                content: `Firecrawl crawl failed to start. Response: ${JSON.stringify(startJson).slice(0, 500)}`,
                isError: true as const,
              };
            }

            const jobId = startJson.id;
            const POLL_INTERVAL = 5000;
            const TIMEOUT = 120_000;
            const startTime = Date.now();

            while (Date.now() - startTime < TIMEOUT) {
              await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));

              const pollRes = await fetch(
                `https://api.firecrawl.dev/v1/crawl/${jobId}`,
                { headers: { Authorization: `Bearer ${apiKey}` } },
              );

              if (pollRes.status === 429) {
                await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
                continue;
              }

              if (!pollRes.ok) {
                const body = await pollRes.text();
                return {
                  content: `Firecrawl crawl poll failed (HTTP ${pollRes.status}): ${body.slice(0, 500)}`,
                  isError: true as const,
                };
              }

              const pollJson = (await pollRes.json()) as {
                status: string;
                data?: Array<{
                  metadata?: { sourceURL?: string };
                  markdown?: string;
                }>;
              };

              if (pollJson.status === 'completed') {
                const results = (pollJson.data ?? []).map((page) => ({
                  url: page.metadata?.sourceURL ?? 'unknown',
                  markdown: page.markdown ?? '',
                }));

                const MAX_SIZE = 100 * 1024;
                let output = JSON.stringify(results, null, 2);
                if (output.length > MAX_SIZE) {
                  while (output.length > MAX_SIZE && results.length > 1) {
                    results.pop();
                    output = JSON.stringify(results, null, 2);
                  }
                  if (output.length > MAX_SIZE) {
                    output = output.slice(0, MAX_SIZE) + '\n\n[Content truncated at 100KB]';
                  }
                }

                return {
                  content: `Crawled ${pollJson.data?.length ?? 0} pages:\n\n${output}`,
                };
              }

              if (pollJson.status === 'failed') {
                return { content: 'Firecrawl crawl job failed.', isError: true as const };
              }
            }

            return {
              content: `Firecrawl crawl timed out after ${TIMEOUT / 1000}s. Job ID: ${jobId}`,
              isError: true as const,
            };
          },
          catch: (err) =>
            new ToolError({
              toolName: 'firecrawl_crawl',
              message: `Firecrawl crawl error: ${err instanceof Error ? err.message : String(err)}`,
              cause: err,
            }),
        });

        return result;
      }),
  },

  {
    name: 'firecrawl_map',
    description:
      'Discover all URLs on a website. Returns a list of URLs found on the domain. Useful for understanding site structure before crawling or scraping specific pages.',
    schema: z.object({
      url: z.string().describe('The URL to map'),
    }),
    handler: (args) =>
      Effect.gen(function* () {
        const apiKey = process.env.FIRECRAWL_API_KEY;
        if (!apiKey) {
          return {
            content:
              'FIRECRAWL_API_KEY is not set. Ask the admin to configure the Firecrawl API key.',
            isError: true as const,
          };
        }

        const result = yield* Effect.tryPromise({
          try: async () => {
            const res = await fetch('https://api.firecrawl.dev/v1/map', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ url: args.url as string }),
            });

            if (res.status === 429) {
              return {
                content: 'Firecrawl rate limit exceeded. Please wait a moment and try again.',
                isError: true as const,
              };
            }

            if (!res.ok) {
              const body = await res.text();
              return {
                content: `Firecrawl map failed (HTTP ${res.status}): ${body.slice(0, 500)}`,
                isError: true as const,
              };
            }

            const json = (await res.json()) as {
              success: boolean;
              links?: string[];
            };
            if (!json.success || !json.links) {
              return {
                content: `Firecrawl map returned no links. Response: ${JSON.stringify(json).slice(0, 500)}`,
                isError: true as const,
              };
            }

            return {
              content: `Found ${json.links.length} URLs:\n\n${json.links.join('\n')}`,
            };
          },
          catch: (err) =>
            new ToolError({
              toolName: 'firecrawl_map',
              message: `Firecrawl map error: ${err instanceof Error ? err.message : String(err)}`,
              cause: err,
            }),
        });

        return result;
      }),
  },
];
