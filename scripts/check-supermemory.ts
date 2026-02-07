import Supermemory from 'supermemory';

const KEY_ENV_VARS = [
  'SUPERMEMORY_API_KEY',
  'SUPERMEMORY_OPENCLAW_API_KEY',
  'SUPERMEMORY_CC_API_KEY',
] as const;

type KeyEnvVar = (typeof KEY_ENV_VARS)[number];

function resolveApiKey(): { key: string; envVar: KeyEnvVar } | null {
  for (const envVar of KEY_ENV_VARS) {
    const raw = process.env[envVar];
    if (typeof raw !== 'string') continue;
    const key = raw.trim();
    if (!key) continue;
    return { key, envVar };
  }
  return null;
}

async function main(): Promise<void> {
  const resolved = resolveApiKey();
  if (!resolved) {
    console.error(
      'No Supermemory key found. Set SUPERMEMORY_API_KEY (or SUPERMEMORY_OPENCLAW_API_KEY / SUPERMEMORY_CC_API_KEY).',
    );
    process.exit(1);
  }

  const containerTag = process.argv[2] || 'nanoclaw_main';
  const query = process.argv[3] || 'auth check';

  const client = new Supermemory({
    apiKey: resolved.key,
    timeout: 8000,
  });

  console.log(
    `Checking Supermemory auth with ${resolved.envVar} (prefix ${resolved.key.slice(0, 3)}, length ${resolved.key.length})`,
  );
  console.log(`containerTag=${containerTag} query="${query}"`);

  try {
    const result = await client.profile({
      containerTag,
      q: query,
    });

    console.log('Auth OK');
    console.log(
      `static=${result.profile?.static?.length ?? 0} dynamic=${result.profile?.dynamic?.length ?? 0} results=${result.searchResults?.results?.length ?? 0}`,
    );
  } catch (err: unknown) {
    const status =
      typeof err === 'object' && err !== null && 'status' in err
        ? String((err as { status?: unknown }).status ?? '')
        : '';
    const message =
      err instanceof Error ? err.message : `Unknown error: ${String(err)}`;

    console.error(`Auth FAILED${status ? ` (${status})` : ''}: ${message}`);
    console.error(
      'If this key should be valid, create a fresh key in console.supermemory.ai and retry.',
    );
    process.exit(1);
  }
}

await main();
