/**
 * Adapter factory — creates the appropriate provider adapter.
 */

import { ClaudeAdapter } from './claude-adapter.js';
import { OpenAIAdapter } from './openai-adapter.js';
import { MinimaxAdapter } from './minimax-adapter.js';
import type { ProviderAdapter } from './types.js';

export function createAdapter(provider: string): ProviderAdapter {
  switch (provider) {
    case 'minimax':
      return new MinimaxAdapter();
    case 'openai':
      return new OpenAIAdapter();
    case 'anthropic':
    default:
      return new ClaudeAdapter();
  }
}

export type { ProviderAdapter, AdapterInput } from './types.js';
