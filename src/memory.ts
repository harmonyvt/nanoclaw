import Supermemory from 'supermemory';

import { SUPERMEMORY_API_KEY } from './config.js';
import { logger } from './logger.js';

const CONTAINER_TAG = 'nanoclaw';

let client: Supermemory | null = null;

function getClient(): Supermemory | null {
  if (!SUPERMEMORY_API_KEY) return null;
  if (!client) {
    client = new Supermemory({ apiKey: SUPERMEMORY_API_KEY });
  }
  return client;
}

/**
 * Retrieve relevant memories and user profile for a query.
 * Returns a formatted context string, or empty string if unavailable.
 */
export async function retrieve(query: string): Promise<string> {
  const sm = getClient();
  if (!sm) return '';

  try {
    const result = await sm.profile({
      containerTag: CONTAINER_TAG,
      q: query,
    });

    const parts: string[] = [];

    const staticFacts = result.profile?.static;
    if (staticFacts && staticFacts.length > 0) {
      parts.push(`Static profile:\n${staticFacts.join('\n')}`);
    }

    const dynamicContext = result.profile?.dynamic;
    if (dynamicContext && dynamicContext.length > 0) {
      parts.push(`Dynamic context:\n${dynamicContext.join('\n')}`);
    }

    const memories = result.searchResults?.results as
      | { memory?: string }[]
      | undefined;
    if (memories && memories.length > 0) {
      const memoryLines = memories
        .map((r) => r.memory)
        .filter(Boolean);
      if (memoryLines.length > 0) {
        parts.push(`Relevant memories:\n${memoryLines.join('\n')}`);
      }
    }

    if (parts.length === 0) return '';

    return `<memory>\n${parts.join('\n\n')}\n</memory>`;
  } catch (err) {
    logger.warn({ err }, 'Failed to retrieve memories');
    return '';
  }
}

/**
 * Save a conversation exchange to supermemory.
 * Fire-and-forget — errors are logged but don't block.
 */
export function save(
  userMessages: { sender: string; content: string }[],
  agentResponse: string,
): void {
  const sm = getClient();
  if (!sm) return;

  const lines = userMessages.map((m) => `${m.sender}: ${m.content}`);
  lines.push(`assistant: ${agentResponse}`);
  const content = lines.join('\n');

  sm.add({ content, containerTag: CONTAINER_TAG }).catch((err) => {
    logger.warn({ err }, 'Failed to save memory');
  });
}
