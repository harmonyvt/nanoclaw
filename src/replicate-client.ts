import Replicate from 'replicate';
import { REPLICATE_API_TOKEN } from './config.js';
import { logger } from './logger.js';

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

  const startMs = Date.now();
  const timeoutMs = options?.timeoutMs;
  if (timeoutMs !== undefined && timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      logger.warn({ module: 'replicate', model, timeoutMs, durationMs: Date.now() - startMs }, 'Replicate model run timed out');
      controller.abort();
    }, timeoutMs);
  }
  try {
    const output = await client.run(model, {
      input,
      signal: controller.signal,
    });
    logger.info({ module: 'replicate', model, durationMs: Date.now() - startMs }, 'Replicate model run completed');
    return output as T;
  } catch (err) {
    logger.warn({ module: 'replicate', model, durationMs: Date.now() - startMs, err }, 'Replicate model run failed');
    throw err;
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
