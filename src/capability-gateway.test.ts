import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { processCapabilityRequest } from './capability-gateway.js';

describe('capability-gateway', () => {
  let originalFetch: typeof fetch;
  let savedOpenAi: string | undefined;
  let savedAnthropic: string | undefined;
  let savedClaudeOauth: string | undefined;
  let savedFirecrawl: string | undefined;
  let savedSm: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    savedOpenAi = process.env.OPENAI_API_KEY;
    savedAnthropic = process.env.ANTHROPIC_API_KEY;
    savedClaudeOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    savedFirecrawl = process.env.FIRECRAWL_API_KEY;
    savedSm = process.env.SUPERMEMORY_API_KEY;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (savedOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedOpenAi;
    if (savedAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedAnthropic;
    if (savedClaudeOauth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedClaudeOauth;
    if (savedFirecrawl === undefined) delete process.env.FIRECRAWL_API_KEY;
    else process.env.FIRECRAWL_API_KEY = savedFirecrawl;
    if (savedSm === undefined) delete process.env.SUPERMEMORY_API_KEY;
    else process.env.SUPERMEMORY_API_KEY = savedSm;
  });

  test('returns error for unknown action', async () => {
    const res = await processCapabilityRequest(
      'req-1',
      'totally_unknown',
      {},
      'main',
    );
    expect(res.status).toBe('error');
    expect(String(res.error)).toContain('Unknown capability action');
  });

  test('firecrawl action fails when host key is missing', async () => {
    delete process.env.FIRECRAWL_API_KEY;
    const res = await processCapabilityRequest(
      'req-2',
      'firecrawl_scrape',
      { url: 'https://example.com' },
      'main',
    );
    expect(res.status).toBe('error');
    expect(String(res.error)).toContain('FIRECRAWL_API_KEY');
  });

  test('openai chat completion proxies through host key', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-host';
    let called = false;
    globalThis.fetch = (async (url, init) => {
      called = true;
      expect(String(url)).toBe('https://api.openai.com/v1/chat/completions');
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        'Bearer sk-test-host',
      );
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        messages: unknown[];
      };
      expect(body.model).toBe('gpt-4o');
      expect(Array.isArray(body.messages)).toBe(true);
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const res = await processCapabilityRequest(
      'req-3',
      'openai_chat_completion',
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      },
      'main',
    );
    expect(called).toBe(true);
    expect(res.status).toBe('ok');
  });

  test('anthropic messages uses host ANTHROPIC_API_KEY', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api-test';
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    let called = false;
    globalThis.fetch = (async (url, init) => {
      called = true;
      expect(String(url)).toBe('https://api.anthropic.com/v1/messages');
      const headers = init?.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe('sk-ant-api-test');
      expect(headers.Authorization).toBeUndefined();
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        messages: unknown[];
      };
      expect(body.model).toBe('claude-sonnet-4-5-20250929');
      expect(Array.isArray(body.messages)).toBe(true);
      return new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const res = await processCapabilityRequest(
      'req-4',
      'anthropic_messages',
      {
        model: 'claude-sonnet-4-5-20250929',
        messages: [{ role: 'user', content: 'Hello' }],
      },
      'main',
    );
    expect(called).toBe(true);
    expect(res.status).toBe('ok');
  });

  test('anthropic messages uses host CLAUDE_CODE_OAUTH_TOKEN when api key missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-test-token';
    let called = false;
    globalThis.fetch = (async (_url, init) => {
      called = true;
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer oauth-test-token');
      expect(headers['x-api-key']).toBeUndefined();
      return new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const res = await processCapabilityRequest(
      'req-5',
      'anthropic_messages',
      {
        model: 'claude-sonnet-4-5-20250929',
        messages: [{ role: 'user', content: 'Hello' }],
      },
      'main',
    );
    expect(called).toBe(true);
    expect(res.status).toBe('ok');
  });
});
