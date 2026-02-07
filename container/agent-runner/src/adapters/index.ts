/**
 * Adapter factory.
 * Returns a ProviderAdapter for the requested provider string.
 */

import { ClaudeAdapter } from './claude-adapter.js';
import { OpenAIAdapter } from './openai-adapter.js';
import type { ProviderAdapter } from '../types.js';

export function createAdapter(provider: string): ProviderAdapter {
  switch (provider) {
    case 'openai':
      return new OpenAIAdapter();
    case 'anthropic':
    default:
      return new ClaudeAdapter();
  }
}
