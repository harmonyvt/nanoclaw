import { logger } from './logger.js';

const BASE_URL = 'https://api.supermemory.ai';
const RETRIEVE_TIMEOUT = 5000; // 5s — don't delay agent start
const STORE_TIMEOUT = 10000; // 10s for storage

export function isSupermemoryEnabled(): boolean {
  return !!process.env.SUPERMEMORY_API_KEY;
}

export interface MemoryResult {
  text: string;
  relevance: number;
}

export interface MemoryContext {
  memories: MemoryResult[];
}

interface StoreMetadata {
  threadId?: string;
  timestamp?: string;
  groupName?: string;
  [key: string]: string | undefined;
}

function apiKey(): string {
  return process.env.SUPERMEMORY_API_KEY || '';
}

function containerTag(groupFolder: string): string {
  return `nanoclaw_${groupFolder}`;
}

/**
 * Retrieve relevant memories for the current conversation.
 * Returns null on any failure — never blocks message processing.
 */
export async function retrieveMemories(
  groupFolder: string,
  query: string,
): Promise<MemoryContext | null> {
  if (!query.trim()) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RETRIEVE_TIMEOUT);

    const res = await fetch(`${BASE_URL}/v4/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        q: query,
        containerTag: containerTag(groupFolder),
        searchMode: 'hybrid',
        limit: 10,
        threshold: 0.5,
        rerank: true,
        rewriteQuery: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (res.status === 429) {
      logger.warn({ groupFolder }, 'Supermemory rate limit on retrieve');
      return null;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn(
        { groupFolder, status: res.status, body: body.slice(0, 200) },
        'Supermemory retrieve failed',
      );
      return null;
    }

    const data = (await res.json()) as {
      results?: Array<{
        memory?: string;
        chunk?: string;
        similarity?: number;
      }>;
    };

    const memories: MemoryResult[] = (data.results || [])
      .map((r) => ({
        text: r.memory || r.chunk || '',
        relevance: r.similarity ?? 0,
      }))
      .filter((m) => m.text.trim());

    if (memories.length === 0) return null;

    logger.info(
      { groupFolder, count: memories.length },
      'Retrieved memories from Supermemory',
    );

    return { memories };
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
  try {
    const content = `User:\n${userMessages}\n\nAssistant:\n${agentResponse}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STORE_TIMEOUT);

    const res = await fetch(`${BASE_URL}/v3/documents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content,
        containerTags: [containerTag(groupFolder)],
        metadata: {
          type: 'interaction',
          ...Object.fromEntries(
            Object.entries(metadata).filter(([, v]) => v !== undefined),
          ),
        },
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (res.status === 429) {
      logger.warn({ groupFolder }, 'Supermemory rate limit on store');
      return;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn(
        { groupFolder, status: res.status, body: body.slice(0, 200) },
        'Supermemory store failed',
      );
      return;
    }

    logger.info({ groupFolder }, 'Stored interaction to Supermemory');
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      logger.warn({ groupFolder }, 'Supermemory store timed out');
    } else {
      logger.warn({ groupFolder, err }, 'Supermemory store error');
    }
  }
}

/**
 * Format retrieved memories as XML context for prompt injection.
 */
export function formatMemoryContext(ctx: MemoryContext): string {
  const lines = ctx.memories.map(
    (m) =>
      `  <memory relevance="${m.relevance.toFixed(2)}">${escapeXml(m.text)}</memory>`,
  );
  return `<memory_context source="supermemory">\n${lines.join('\n')}\n</memory_context>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
