import Replicate from 'replicate';
import { REPLICATE_API_TOKEN } from './config.js';

let _client: Replicate | null = null;

/** Returns true if a Replicate API token is configured. */
export function isReplicateConfigured(): boolean {
  return REPLICATE_API_TOKEN.length > 0;
}

/** Lazy singleton Replicate SDK client. */
function getClient(): Replicate {
  if (!_client) {
    if (!REPLICATE_API_TOKEN) {
      throw new Error('REPLICATE_API_TOKEN is not configured');
    }
    _client = new Replicate({ auth: REPLICATE_API_TOKEN });
  }
  return _client;
}

export interface RunModelOptions {
  timeoutMs?: number;
}

/**
 * Run a Replicate model with optional timeout.
 * Returns the raw model output (caller handles type-specific parsing).
 */
export async function runModel<T = unknown>(
  model: `${string}/${string}` | `${string}/${string}:${string}`,
  input: Record<string, unknown>,
  options?: RunModelOptions,
): Promise<T> {
  const client = getClient();

  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  if (options?.timeoutMs !== undefined && options.timeoutMs > 0) {
    timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);
  }

  try {
    const output = await client.run(model, {
      input,
      signal: controller.signal,
    });
    return output as T;
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
