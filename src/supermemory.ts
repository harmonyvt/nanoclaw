import Supermemory from 'supermemory';
import { logger } from './logger.js';

const RETRIEVE_TIMEOUT = 5000; // 5s — don't delay agent start
const STORE_TIMEOUT = 10000; // 10s for storage

const SUPERMEMORY_KEY_ENV_VARS = [
  'SUPERMEMORY_API_KEY',
  'SUPERMEMORY_OPENCLAW_API_KEY',
  'SUPERMEMORY_CC_API_KEY',
] as const;

let client: Supermemory | null = null;

function resolveSupermemoryApiKey():
  | { key: string; envVar: (typeof SUPERMEMORY_KEY_ENV_VARS)[number] }
  | null {
  for (const envVar of SUPERMEMORY_KEY_ENV_VARS) {
    const raw = process.env[envVar];
    if (typeof raw !== 'string') continue;
    const key = raw.trim();
    if (!key) continue;
    return { key, envVar };
  }
  return null;
}

function getClient(): Supermemory | null {
  const resolved = resolveSupermemoryApiKey();
  if (!resolved) return null;
  if (!client) {
    client = new Supermemory({
      apiKey: resolved.key,
      timeout: STORE_TIMEOUT,
    });
    if (resolved.envVar !== 'SUPERMEMORY_API_KEY') {
      logger.info(
        { envVar: resolved.envVar },
        'Using alternate Supermemory API key environment variable',
      );
    }
  }
  return client;
}

export function isSupermemoryEnabled(): boolean {
  return !!resolveSupermemoryApiKey();
}

export interface MemoryResult {
  text: string;
  relevance: number;
}

export interface MemoryContext {
  profile: { static: string[]; dynamic: string[] };
  memories: MemoryResult[];
}

interface StoreMetadata {
  threadId?: string;
  timestamp?: string;
  groupName?: string;
  [key: string]: string | undefined;
}

function containerTag(groupFolder: string): string {
  return `nanoclaw_${groupFolder}`;
}

/**
 * Retrieve user profile + relevant memories for the current conversation.
 * Uses client.profile() for a combined profile+search call.
 * Returns null on any failure — never blocks message processing.
 */
export async function retrieveMemories(
  groupFolder: string,
  query: string,
): Promise<MemoryContext | null> {
  const sm = getClient();
  if (!sm || !query.trim()) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RETRIEVE_TIMEOUT);

    const result = await sm.profile(
      {
        containerTag: containerTag(groupFolder),
        q: query,
      },
      { signal: controller.signal },
    );

    clearTimeout(timer);

    const staticFacts = result.profile?.static || [];
    const dynamicCtx = result.profile?.dynamic || [];
    const rawResults = (result.searchResults?.results || []) as Array<{
      memory?: string;
      chunk?: string;
      similarity?: number;
    }>;
    const searchResults = rawResults
      .map((r) => ({
        text: r.memory || r.chunk || '',
        relevance: r.similarity ?? 0,
      }))
      .filter((m) => m.text.trim());

    if (
      staticFacts.length === 0 &&
      dynamicCtx.length === 0 &&
      searchResults.length === 0
    ) {
      return null;
    }

    logger.info(
      {
        groupFolder,
        staticFacts: staticFacts.length,
        dynamicCtx: dynamicCtx.length,
        memories: searchResults.length,
      },
      'Retrieved memories from Supermemory',
    );

    return {
      profile: { static: staticFacts, dynamic: dynamicCtx },
      memories: searchResults,
    };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      logger.warn({ groupFolder }, 'Supermemory retrieve timed out');
    } else {
      logger.warn({ groupFolder, err }, 'Supermemory retrieve error');
    }
    return null;
  }
}

/**
 * Store a conversation interaction to Supermemory.
 * Fire-and-forget — errors are logged but never thrown.
 */
export async function storeInteraction(
  groupFolder: string,
  userMessages: string,
  agentResponse: string,
  metadata: StoreMetadata,
): Promise<void> {
  const sm = getClient();
  if (!sm) return;

  try {
    const content = `User:\n${userMessages}\n\nAssistant:\n${agentResponse}`;

    await sm.add({
      content,
      containerTags: [containerTag(groupFolder)],
      metadata: Object.fromEntries(
        Object.entries({ type: 'interaction', ...metadata }).filter(
          ([, v]) => v !== undefined,
        ),
      ) as Record<string, string>,
    });

    logger.info({ groupFolder }, 'Stored interaction to Supermemory');
  } catch (err: unknown) {
    logger.warn({ groupFolder, err }, 'Supermemory store error');
  }
}

/**
 * Format retrieved memories as XML context for prompt injection.
 */
export function formatMemoryContext(ctx: MemoryContext): string {
  const sections: string[] = [];

  if (ctx.profile.static.length > 0) {
    sections.push(
      `  <profile_facts>\n${ctx.profile.static.map((f) => `    <fact>${escapeXml(f)}</fact>`).join('\n')}\n  </profile_facts>`,
    );
  }

  if (ctx.profile.dynamic.length > 0) {
    sections.push(
      `  <recent_context>\n${ctx.profile.dynamic.map((d) => `    <context>${escapeXml(d)}</context>`).join('\n')}\n  </recent_context>`,
    );
  }

  if (ctx.memories.length > 0) {
    sections.push(
      `  <memories>\n${ctx.memories.map((m) => `    <memory relevance="${m.relevance.toFixed(2)}">${escapeXml(m.text)}</memory>`).join('\n')}\n  </memories>`,
    );
  }

  return `<memory_context source="supermemory">\n${sections.join('\n')}\n</memory_context>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
