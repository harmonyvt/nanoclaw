import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Supermemory from 'supermemory';

import { logger } from './logger.js';

type CapabilityResponse = {
  status: 'ok' | 'error';
  result?: unknown;
  error?: string;
};

const SUPERMEMORY_KEY_ENV_VARS = [
  'SUPERMEMORY_API_KEY',
  'SUPERMEMORY_OPENCLAW_API_KEY',
  'SUPERMEMORY_CC_API_KEY',
] as const;

type AnthropicCredential = {
  mode: 'api-key' | 'oauth';
  token: string;
  source:
    | 'env:ANTHROPIC_API_KEY'
    | 'env:CLAUDE_CODE_OAUTH_TOKEN'
    | 'keychain:Claude Code-credentials'
    | 'file:~/.claude/.credentials.json';
};

function getEnvKey(name: string): string | null {
  const raw = process.env[name];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveSupermemoryApiKey(): string | null {
  for (const envVar of SUPERMEMORY_KEY_ENV_VARS) {
    const key = getEnvKey(envVar);
    if (key) return key;
  }
  return null;
}

function readClaudeCodeKeychainToken(): string | null {
  try {
    const raw = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      claudeAiOauth?: { accessToken?: unknown };
    };
    return asString(parsed?.claudeAiOauth?.accessToken) ?? null;
  } catch {
    return null;
  }
}

function readClaudeCodeCredentialsFileToken(): string | null {
  try {
    const homeDir = getEnvKey('HOME') || os.homedir();
    if (!homeDir) return null;
    const credentialsPath = path.join(homeDir, '.claude', '.credentials.json');
    if (!fs.existsSync(credentialsPath)) return null;
    const raw = fs.readFileSync(credentialsPath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      claudeAiOauth?: { accessToken?: unknown };
    };
    return asString(parsed?.claudeAiOauth?.accessToken) ?? null;
  } catch {
    return null;
  }
}

function resolveAnthropicCredential(): AnthropicCredential | null {
  const apiKey = getEnvKey('ANTHROPIC_API_KEY');
  if (apiKey) {
    return { mode: 'api-key', token: apiKey, source: 'env:ANTHROPIC_API_KEY' };
  }

  const oauthToken = getEnvKey('CLAUDE_CODE_OAUTH_TOKEN');
  if (oauthToken) {
    return {
      mode: 'oauth',
      token: oauthToken,
      source: 'env:CLAUDE_CODE_OAUTH_TOKEN',
    };
  }

  const keychainToken = readClaudeCodeKeychainToken();
  if (keychainToken) {
    return {
      mode: 'oauth',
      token: keychainToken,
      source: 'keychain:Claude Code-credentials',
    };
  }

  const credentialsFileToken = readClaudeCodeCredentialsFileToken();
  if (credentialsFileToken) {
    return {
      mode: 'oauth',
      token: credentialsFileToken,
      source: 'file:~/.claude/.credentials.json',
    };
  }

  return null;
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const arr = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return arr;
}

async function firecrawlScrape(
  params: Record<string, unknown>,
): Promise<CapabilityResponse> {
  const apiKey = getEnvKey('FIRECRAWL_API_KEY');
  if (!apiKey) {
    return {
      status: 'error',
      error: 'FIRECRAWL_API_KEY is not set on host.',
    };
  }

  const url = asString(params.url);
  if (!url) {
    return { status: 'error', error: 'Missing required parameter: url' };
  }
  const parsedFormats = asStringArray(params.formats);
  const formats = parsedFormats && parsedFormats.length > 0 ? parsedFormats : ['markdown'];

  const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url, formats }),
  });

  if (res.status === 429) {
    return {
      status: 'error',
      error: 'Firecrawl rate limit exceeded. Please wait and retry.',
    };
  }

  if (!res.ok) {
    const body = await res.text();
    return {
      status: 'error',
      error: `Firecrawl scrape failed (HTTP ${res.status}): ${body.slice(0, 500)}`,
    };
  }

  const json = (await res.json()) as {
    success: boolean;
    data?: { markdown?: string };
  };
  if (!json.success || !json.data?.markdown) {
    return {
      status: 'error',
      error: `Firecrawl scrape returned no markdown content. Response: ${JSON.stringify(json).slice(0, 500)}`,
    };
  }

  const MAX_SIZE = 50 * 1024;
  let markdown = json.data.markdown;
  if (markdown.length > MAX_SIZE) {
    markdown = `${markdown.slice(0, MAX_SIZE)}\n\n[Content truncated at 50KB]`;
  }

  return { status: 'ok', result: markdown };
}

async function firecrawlCrawl(
  params: Record<string, unknown>,
): Promise<CapabilityResponse> {
  const apiKey = getEnvKey('FIRECRAWL_API_KEY');
  if (!apiKey) {
    return {
      status: 'error',
      error: 'FIRECRAWL_API_KEY is not set on host.',
    };
  }

  const url = asString(params.url);
  if (!url) {
    return { status: 'error', error: 'Missing required parameter: url' };
  }
  const limit =
    typeof params.limit === 'number' && Number.isFinite(params.limit)
      ? params.limit
      : 10;
  const maxDepth =
    typeof params.maxDepth === 'number' && Number.isFinite(params.maxDepth)
      ? params.maxDepth
      : 2;

  const startRes = await fetch('https://api.firecrawl.dev/v1/crawl', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url, limit, maxDepth }),
  });

  if (startRes.status === 429) {
    return {
      status: 'error',
      error: 'Firecrawl rate limit exceeded. Please wait and retry.',
    };
  }

  if (!startRes.ok) {
    const body = await startRes.text();
    return {
      status: 'error',
      error: `Firecrawl crawl failed to start (HTTP ${startRes.status}): ${body.slice(0, 500)}`,
    };
  }

  const startJson = (await startRes.json()) as { success: boolean; id?: string };
  if (!startJson.success || !startJson.id) {
    return {
      status: 'error',
      error: `Firecrawl crawl failed to start. Response: ${JSON.stringify(startJson).slice(0, 500)}`,
    };
  }

  const jobId = startJson.id;
  const POLL_INTERVAL = 5000;
  const TIMEOUT = 120_000;
  const startTime = Date.now();

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
      return {
        status: 'error',
        error: `Firecrawl crawl poll failed (HTTP ${pollRes.status}): ${body.slice(0, 500)}`,
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
          output = `${output.slice(0, MAX_SIZE)}\n\n[Content truncated at 100KB]`;
        }
      }

      return {
        status: 'ok',
        result: `Crawled ${pollJson.data?.length ?? 0} pages:\n\n${output}`,
      };
    }

    if (pollJson.status === 'failed') {
      return { status: 'error', error: 'Firecrawl crawl job failed.' };
    }
  }

  return {
    status: 'error',
    error: `Firecrawl crawl timed out after ${TIMEOUT / 1000}s. Job ID: ${jobId}`,
  };
}

async function firecrawlMap(
  params: Record<string, unknown>,
): Promise<CapabilityResponse> {
  const apiKey = getEnvKey('FIRECRAWL_API_KEY');
  if (!apiKey) {
    return {
      status: 'error',
      error: 'FIRECRAWL_API_KEY is not set on host.',
    };
  }

  const url = asString(params.url);
  if (!url) {
    return { status: 'error', error: 'Missing required parameter: url' };
  }

  const res = await fetch('https://api.firecrawl.dev/v1/map', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url }),
  });

  if (res.status === 429) {
    return {
      status: 'error',
      error: 'Firecrawl rate limit exceeded. Please wait and retry.',
    };
  }

  if (!res.ok) {
    const body = await res.text();
    return {
      status: 'error',
      error: `Firecrawl map failed (HTTP ${res.status}): ${body.slice(0, 500)}`,
    };
  }

  const json = (await res.json()) as { success: boolean; links?: string[] };
  if (!json.success || !json.links) {
    return {
      status: 'error',
      error: `Firecrawl map returned no links. Response: ${JSON.stringify(json).slice(0, 500)}`,
    };
  }

  return {
    status: 'ok',
    result: `Found ${json.links.length} URLs:\n\n${json.links.join('\n')}`,
  };
}

async function memorySave(
  params: Record<string, unknown>,
  groupFolder: string,
): Promise<CapabilityResponse> {
  const apiKey = resolveSupermemoryApiKey();
  if (!apiKey) {
    return {
      status: 'error',
      error:
        'No Supermemory API key found on host. Set SUPERMEMORY_API_KEY (or alias vars).',
    };
  }

  const content = asString(params.content);
  if (!content) {
    return { status: 'error', error: 'Missing required parameter: content' };
  }

  const metadataInput = params.metadata;
  let metadata: Record<string, string> = { type: 'explicit_save' };
  if (
    metadataInput &&
    typeof metadataInput === 'object' &&
    !Array.isArray(metadataInput)
  ) {
    metadata = {
      ...metadata,
      ...Object.fromEntries(
        Object.entries(metadataInput as Record<string, unknown>)
          .filter(([, value]) => typeof value === 'string')
          .map(([key, value]) => [key, value as string]),
      ),
    };
  }

  const sm = new Supermemory({ apiKey });
  await sm.add({
    content,
    containerTags: [`nanoclaw_${groupFolder}`],
    metadata,
  });

  return { status: 'ok', result: 'Memory saved successfully.' };
}

async function memorySearch(
  params: Record<string, unknown>,
  groupFolder: string,
): Promise<CapabilityResponse> {
  const apiKey = resolveSupermemoryApiKey();
  if (!apiKey) {
    return {
      status: 'error',
      error:
        'No Supermemory API key found on host. Set SUPERMEMORY_API_KEY (or alias vars).',
    };
  }

  const query = asString(params.query);
  if (!query) {
    return { status: 'error', error: 'Missing required parameter: query' };
  }
  const limit =
    typeof params.limit === 'number' && Number.isFinite(params.limit)
      ? params.limit
      : 10;

  const sm = new Supermemory({ apiKey });
  const response = await sm.search.memories({
    q: query,
    containerTag: `nanoclaw_${groupFolder}`,
    searchMode: 'hybrid',
    limit,
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
    return { status: 'ok', result: 'No matching memories found.' };
  }

  const formatted = results
    .map(
      (r: { text: string; similarity: number }, i: number) =>
        `${i + 1}. [relevance: ${r.similarity.toFixed(2)}] ${r.text}`,
    )
    .join('\n\n');

  return {
    status: 'ok',
    result: `Found ${results.length} memories:\n\n${formatted}`,
  };
}

async function anthropicMessages(
  params: Record<string, unknown>,
): Promise<CapabilityResponse> {
  const credential = resolveAnthropicCredential();
  if (!credential) {
    return {
      status: 'error',
      error:
        'No Anthropic credentials found on host. Set ANTHROPIC_API_KEY or Claude Code OAuth credentials.',
    };
  }

  const model = asString(params.model);
  if (!model) {
    return { status: 'error', error: 'Missing required parameter: model' };
  }
  if (!Array.isArray(params.messages)) {
    return { status: 'error', error: 'Missing required parameter: messages[]' };
  }

  const body: Record<string, unknown> = {
    model,
    messages: params.messages,
  };

  const maxTokens =
    typeof params.max_tokens === 'number' && Number.isFinite(params.max_tokens)
      ? Math.max(1, Math.floor(params.max_tokens))
      : 4096;
  body.max_tokens = maxTokens;

  const passthroughKeys = [
    'system',
    'tools',
    'tool_choice',
    'temperature',
    'top_p',
    'stop_sequences',
    'metadata',
  ] as const;
  for (const key of passthroughKeys) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      body[key] = params[key];
    }
  }

  const makeHeaders = (
    forceApiKeyHeader = false,
    includeOauthBeta = false,
  ): Record<string, string> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    };
    if (includeOauthBeta) {
      headers['anthropic-beta'] = 'oauth-2025-04-20';
    }
    if (
      forceApiKeyHeader ||
      credential.mode === 'api-key' ||
      credential.token.startsWith('sk-ant-api')
    ) {
      headers['x-api-key'] = credential.token;
    } else {
      headers.Authorization = `Bearer ${credential.token}`;
    }
    return headers;
  };

  const callAnthropic = async (
    forceApiKeyHeader = false,
    includeOauthBeta = false,
  ): Promise<Response> =>
    fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: makeHeaders(forceApiKeyHeader, includeOauthBeta),
      body: JSON.stringify(body),
    });

  logger.debug(
    { source: credential.source, mode: credential.mode, model },
    'Processing anthropic_messages capability request',
  );

  let res = await callAnthropic(false);
  if (
    !res.ok &&
    credential.mode === 'oauth' &&
    (res.status === 401 || res.status === 403)
  ) {
    // Retry with OAuth beta header for hosts that require explicit OAuth gating.
    res = await callAnthropic(false, true);
  }
  if (
    !res.ok &&
    credential.mode === 'oauth' &&
    (res.status === 400 || res.status === 401 || res.status === 403)
  ) {
    // Some environments expose OAuth tokens that only work as x-api-key style.
    res = await callAnthropic(true);
  }

  if (!res.ok) {
    const text = await res.text();
    return {
      status: 'error',
      error: `Anthropic messages failed (HTTP ${res.status}): ${text.slice(0, 700)}`,
    };
  }

  const json = (await res.json()) as Record<string, unknown>;
  return { status: 'ok', result: json };
}

async function openaiChatCompletion(
  params: Record<string, unknown>,
): Promise<CapabilityResponse> {
  const apiKey = getEnvKey('OPENAI_API_KEY');
  if (!apiKey) {
    return {
      status: 'error',
      error: 'OPENAI_API_KEY is not set on host.',
    };
  }

  const model = asString(params.model);
  if (!model) {
    return { status: 'error', error: 'Missing required parameter: model' };
  }

  if (!Array.isArray(params.messages)) {
    return { status: 'error', error: 'Missing required parameter: messages[]' };
  }

  const body: Record<string, unknown> = {
    model,
    messages: params.messages,
  };

  if (Array.isArray(params.tools) && params.tools.length > 0) {
    body.tools = params.tools;
  }
  if (Object.prototype.hasOwnProperty.call(params, 'tool_choice')) {
    body.tool_choice = params.tool_choice;
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    return {
      status: 'error',
      error: `OpenAI chat completion failed (HTTP ${res.status}): ${text.slice(0, 700)}`,
    };
  }

  const json = (await res.json()) as {
    choices?: unknown[];
  };
  if (!Array.isArray(json.choices) || json.choices.length === 0) {
    return {
      status: 'error',
      error: 'OpenAI chat completion returned no choices.',
    };
  }

  return { status: 'ok', result: json };
}

export async function processCapabilityRequest(
  requestId: string,
  action: string,
  params: Record<string, unknown>,
  groupFolder: string,
): Promise<CapabilityResponse> {
  try {
    switch (action) {
      case 'firecrawl_scrape':
        return await firecrawlScrape(params);
      case 'firecrawl_crawl':
        return await firecrawlCrawl(params);
      case 'firecrawl_map':
        return await firecrawlMap(params);
      case 'memory_save':
        return await memorySave(params, groupFolder);
      case 'memory_search':
        return await memorySearch(params, groupFolder);
      case 'anthropic_messages':
        return await anthropicMessages(params);
      case 'openai_chat_completion':
        return await openaiChatCompletion(params);
      default:
        return { status: 'error', error: `Unknown capability action: ${action}` };
    }
  } catch (err) {
    logger.error(
      { err, action, requestId, groupFolder },
      'Capability gateway request failed',
    );
    return {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
