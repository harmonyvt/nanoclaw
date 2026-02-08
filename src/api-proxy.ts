/**
 * Host-side API proxy for container tool calls.
 * The container sends IPC requests for Firecrawl and Supermemory operations.
 * This module resolves secrets from 1Password/env and executes the actual
 * API calls — the container never sees any third-party API key.
 */

import Supermemory from 'supermemory';
import { logger } from './logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

type ApiResponse = {
  status: 'ok' | 'error';
  result?: string;
  error?: string;
};

type ApiHandler = (
  params: Record<string, unknown>,
) => Promise<ApiResponse>;

// ─── Secret Resolution ──────────────────────────────────────────────────────

function getFirecrawlKey(): string | null {
  return process.env.FIRECRAWL_API_KEY?.trim() || null;
}

const SUPERMEMORY_KEY_ENV_VARS = [
  'SUPERMEMORY_API_KEY',
  'SUPERMEMORY_OPENCLAW_API_KEY',
  'SUPERMEMORY_CC_API_KEY',
] as const;

function getSupermemoryKey(): string | null {
  for (const envVar of SUPERMEMORY_KEY_ENV_VARS) {
    const key = process.env[envVar]?.trim();
    if (key) return key;
  }
  return null;
}

// ─── Firecrawl Handlers ─────────────────────────────────────────────────────

const firecrawlScrape: ApiHandler = async (params) => {
  const apiKey = getFirecrawlKey();
  if (!apiKey) {
    return { status: 'error', error: 'FIRECRAWL_API_KEY is not configured.' };
  }

  const { url, formats } = params as { url: string; formats?: string[] };

  const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url, formats: formats ?? ['markdown'] }),
  });

  if (res.status === 429) {
    return { status: 'error', error: 'Firecrawl rate limit exceeded. Please wait and try again.' };
  }

  if (!res.ok) {
    const body = await res.text();
    return { status: 'error', error: `Firecrawl scrape failed (HTTP ${res.status}): ${body.slice(0, 500)}` };
  }

  const json = (await res.json()) as {
    success: boolean;
    data?: { markdown?: string };
  };
  if (!json.success || !json.data?.markdown) {
    return {
      status: 'error',
      error: `Firecrawl scrape returned no markdown. Response: ${JSON.stringify(json).slice(0, 500)}`,
    };
  }

  const MAX_SIZE = 50 * 1024; // 50KB
  let markdown = json.data.markdown;
  if (markdown.length > MAX_SIZE) {
    markdown = markdown.slice(0, MAX_SIZE) + '\n\n[Content truncated at 50KB]';
  }

  return { status: 'ok', result: markdown };
};

const firecrawlCrawl: ApiHandler = async (params) => {
  const apiKey = getFirecrawlKey();
  if (!apiKey) {
    return { status: 'error', error: 'FIRECRAWL_API_KEY is not configured.' };
  }

  const { url, limit, maxDepth } = params as {
    url: string;
    limit?: number;
    maxDepth?: number;
  };

  // Start the crawl job
  const startRes = await fetch('https://api.firecrawl.dev/v1/crawl', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url,
      limit: limit ?? 10,
      maxDepth: maxDepth ?? 2,
    }),
  });

  if (startRes.status === 429) {
    return { status: 'error', error: 'Firecrawl rate limit exceeded. Please wait and try again.' };
  }
  if (!startRes.ok) {
    const body = await startRes.text();
    return { status: 'error', error: `Firecrawl crawl failed to start (HTTP ${startRes.status}): ${body.slice(0, 500)}` };
  }

  const startJson = (await startRes.json()) as { success: boolean; id?: string };
  if (!startJson.success || !startJson.id) {
    return { status: 'error', error: `Firecrawl crawl failed to start: ${JSON.stringify(startJson).slice(0, 500)}` };
  }

  const jobId = startJson.id;
  const POLL_INTERVAL = 5000;
  const TIMEOUT = 120_000;
  const startTime = Date.now();

  // Poll for completion
  while (Date.now() - startTime < TIMEOUT) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));

    const pollRes = await fetch(`https://api.firecrawl.dev/v1/crawl/${jobId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (pollRes.status === 429) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
      continue;
    }
    if (!pollRes.ok) {
      const body = await pollRes.text();
      return { status: 'error', error: `Firecrawl crawl poll failed (HTTP ${pollRes.status}): ${body.slice(0, 500)}` };
    }

    const pollJson = (await pollRes.json()) as {
      status: string;
      data?: Array<{ metadata?: { sourceURL?: string }; markdown?: string }>;
    };

    if (pollJson.status === 'completed') {
      const results = (pollJson.data ?? []).map((page) => ({
        url: page.metadata?.sourceURL ?? 'unknown',
        markdown: page.markdown ?? '',
      }));

      const MAX_SIZE = 100 * 1024; // 100KB
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

      return { status: 'ok', result: `Crawled ${pollJson.data?.length ?? 0} pages:\n\n${output}` };
    }

    if (pollJson.status === 'failed') {
      return { status: 'error', error: 'Firecrawl crawl job failed.' };
    }
  }

  return { status: 'error', error: `Firecrawl crawl timed out after ${TIMEOUT / 1000}s. Job ID: ${jobId}` };
};

const firecrawlMap: ApiHandler = async (params) => {
  const apiKey = getFirecrawlKey();
  if (!apiKey) {
    return { status: 'error', error: 'FIRECRAWL_API_KEY is not configured.' };
  }

  const { url } = params as { url: string };

  const res = await fetch('https://api.firecrawl.dev/v1/map', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url }),
  });

  if (res.status === 429) {
    return { status: 'error', error: 'Firecrawl rate limit exceeded. Please wait and try again.' };
  }
  if (!res.ok) {
    const body = await res.text();
    return { status: 'error', error: `Firecrawl map failed (HTTP ${res.status}): ${body.slice(0, 500)}` };
  }

  const json = (await res.json()) as { success: boolean; links?: string[] };
  if (!json.success || !json.links) {
    return { status: 'error', error: `Firecrawl map returned no links: ${JSON.stringify(json).slice(0, 500)}` };
  }

  return { status: 'ok', result: `Found ${json.links.length} URLs:\n\n${json.links.join('\n')}` };
};

// ─── Supermemory Handlers ───────────────────────────────────────────────────

const memorySave: ApiHandler = async (params) => {
  const apiKey = getSupermemoryKey();
  if (!apiKey) {
    return { status: 'error', error: 'Supermemory API key not configured.' };
  }

  const { content, metadata, groupFolder } = params as {
    content: string;
    metadata?: Record<string, string>;
    groupFolder: string;
  };

  const sm = new Supermemory({ apiKey });
  await sm.add({
    content,
    containerTags: [`nanoclaw_${groupFolder}`],
    metadata: { type: 'explicit_save', ...metadata },
  });

  return { status: 'ok', result: 'Memory saved successfully.' };
};

const memorySearch: ApiHandler = async (params) => {
  const apiKey = getSupermemoryKey();
  if (!apiKey) {
    return { status: 'error', error: 'Supermemory API key not configured.' };
  }

  const { query, limit, groupFolder } = params as {
    query: string;
    limit?: number;
    groupFolder: string;
  };

  const sm = new Supermemory({ apiKey });
  const response = await sm.search.memories({
    q: query,
    containerTag: `nanoclaw_${groupFolder}`,
    searchMode: 'hybrid',
    limit: limit ?? 10,
  });

  const results = (response.results || [])
    .map((r: { memory?: string; chunk?: string; similarity?: number }) => ({
      text: r.memory || r.chunk || '',
      similarity: r.similarity ?? 0,
    }))
    .filter((r: { text: string }) => r.text.trim());

  if (results.length === 0) {
    return { status: 'ok', result: 'No matching memories found.' };
  }

  const formatted = results
    .map(
      (r: { text: string; similarity: number }, i: number) =>
        `${i + 1}. [relevance: ${r.similarity.toFixed(2)}] ${r.text}`,
    )
    .join('\n\n');

  return { status: 'ok', result: `Found ${results.length} memories:\n\n${formatted}` };
};

// ─── Dispatch ───────────────────────────────────────────────────────────────

const handlers: Record<string, ApiHandler> = {
  firecrawl_scrape: firecrawlScrape,
  firecrawl_crawl: firecrawlCrawl,
  firecrawl_map: firecrawlMap,
  memory_save: memorySave,
  memory_search: memorySearch,
};

/**
 * Process an API proxy request from a container.
 * Called by the IPC watcher when it finds req-*.json in the api/ directory.
 */
export async function processApiProxyRequest(
  action: string,
  params: Record<string, unknown>,
  sourceGroup: string,
): Promise<ApiResponse> {
  const handler = handlers[action];
  if (!handler) {
    return { status: 'error', error: `Unknown API proxy action: ${action}` };
  }

  const startMs = Date.now();
  try {
    const result = await handler(params);
    const durationMs = Date.now() - startMs;
    logger.info(
      { action, sourceGroup, status: result.status, durationMs },
      'API proxy request processed',
    );
    return result;
  } catch (err) {
    const durationMs = Date.now() - startMs;
    logger.error(
      { action, sourceGroup, err, durationMs },
      'API proxy request failed',
    );
    return {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
