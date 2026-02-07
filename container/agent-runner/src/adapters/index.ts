/**
 * Adapter factory.
 * Returns a ProviderAdapter for the requested provider string.
 */

import { ClaudeAdapter } from './claude-adapter.js';
import { AnthropicProxyAdapter } from './anthropic-proxy-adapter.js';
import { OpenAIAdapter } from './openai-adapter.js';
import type { ProviderAdapter } from '../types.js';

export function createAdapter(provider: string): ProviderAdapter {
  const isSecretless = process.env.NANOCLAW_SECRETLESS === '1';

  switch (provider) {
    case 'openai':
      return new OpenAIAdapter();
    case 'anthropic':
      if (isSecretless) {
        return new AnthropicProxyAdapter();
      }
      return new ClaudeAdapter();
    default:
      if (isSecretless) {
        return new AnthropicProxyAdapter();
      }
      return new ClaudeAdapter();
  }
}
