/**
 * Adapter factory — creates the appropriate provider adapter.
 * Stub — implementations in Phase 3.
 */

import type { ProviderAdapter } from './types.js';

export function createAdapter(_provider: string): ProviderAdapter {
  // Phase 3: dispatch to ClaudeAdapter, OpenAIAdapter, MinimaxAdapter
  throw new Error(
    `Provider adapters not yet implemented (Phase 3). Provider: ${_provider}`,
  );
}
