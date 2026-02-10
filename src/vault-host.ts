/**
 * 1Password Vault integration for NanoClaw.
 *
 * Runs on the HOST only — the OP_SERVICE_ACCOUNT_TOKEN never enters agent containers.
 * Agent containers request credentials via IPC (request/response files in the vault/ directory).
 *
 * The vault is scoped to a single dedicated 1Password vault (OP_VAULT_NAME) so the agent
 * cannot access the user's other vaults or personal credentials.
 */
import { logger } from './logger.js';
import { OP_SERVICE_ACCOUNT_TOKEN, OP_VAULT_NAME } from './config.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface VaultItem {
  id: string;
  title: string;
  category: string;
  urls?: string[];
}

interface VaultItemDetail {
  id: string;
  title: string;
  category: string;
  fields: Array<{
    label: string;
    value: string;
    type: string;
  }>;
  urls?: string[];
}

interface VaultRequestResult {
  status: 'ok' | 'error';
  result?: unknown;
  error?: string;
}

// ─── State ──────────────────────────────────────────────────────────────────

// Lazy-initialized 1Password SDK client
type OnePasswordClient = Awaited<ReturnType<typeof import('@1password/sdk').createClient>>;
let sdkClient: OnePasswordClient | null = null;
let cachedVaultId: string | null = null;

// ─── SDK Initialization ─────────────────────────────────────────────────────

export function isVaultEnabled(): boolean {
  return !!OP_SERVICE_ACCOUNT_TOKEN;
}

/**
 * Lazily initialize the 1Password SDK client.
 * Returns null if the SDK is not available or token is not configured.
 */
async function getClient(): Promise<OnePasswordClient | null> {
  if (sdkClient) return sdkClient;

  if (!OP_SERVICE_ACCOUNT_TOKEN) {
    return null;
  }

  try {
    const sdk = await import('@1password/sdk');
    sdkClient = await sdk.createClient({
      auth: OP_SERVICE_ACCOUNT_TOKEN,
      integrationName: 'NanoClaw Agent',
      integrationVersion: 'v1.0.0',
    });
    logger.info({ module: 'vault' }, '1Password SDK client initialized');
    return sdkClient;
  } catch (err) {
    logger.error(
      { module: 'vault', err },
      'Failed to initialize 1Password SDK client. Is @1password/sdk installed?',
    );
    return null;
  }
}

/**
 * Find the vault ID for the configured vault name.
 * Caches the result after first lookup.
 */
async function getVaultId(): Promise<string | null> {
  if (cachedVaultId) return cachedVaultId;

  const client = await getClient();
  if (!client) return null;

  try {
    const vaults = await client.vaults.list();
    const match = vaults.find((v) => v.title === OP_VAULT_NAME);
    if (match) {
      cachedVaultId = match.id;
      logger.info(
        { module: 'vault', vaultName: OP_VAULT_NAME, vaultId: cachedVaultId },
        'Vault found',
      );
      return cachedVaultId;
    }
    logger.error(
      { module: 'vault', vaultName: OP_VAULT_NAME },
      'Configured vault not found in 1Password account',
    );
    return null;
  } catch (err) {
    logger.error({ module: 'vault', err }, 'Failed to list 1Password vaults');
    return null;
  }
}

// ─── Vault Operations ───────────────────────────────────────────────────────

/**
 * List all items in the configured vault.
 * Returns titles, categories, and URLs — never secret values.
 */
async function listItems(): Promise<VaultItem[]> {
  const client = await getClient();
  if (!client) throw new Error('1Password SDK not initialized');

  const vaultId = await getVaultId();
  if (!vaultId) throw new Error(`Vault "${OP_VAULT_NAME}" not found`);

  const itemList = await client.items.list(vaultId);
  return itemList.map((item) => ({
    id: item.id,
    title: item.title,
    category: item.category || 'Unknown',
  }));
}

/**
 * Get full item details including field values.
 * This is the operation that returns actual secrets.
 */
async function getItem(itemTitle: string): Promise<VaultItemDetail> {
  const client = await getClient();
  if (!client) throw new Error('1Password SDK not initialized');

  const vaultId = await getVaultId();
  if (!vaultId) throw new Error(`Vault "${OP_VAULT_NAME}" not found`);

  // Find item by title
  const itemList = await client.items.list(vaultId);
  const target = itemList.find(
    (item) => item.title.toLowerCase() === itemTitle.toLowerCase(),
  );
  const targetItemId = target?.id ?? null;

  if (!targetItemId) {
    throw new Error(
      `Item "${itemTitle}" not found in vault "${OP_VAULT_NAME}"`,
    );
  }

  // Get full item with field values
  const fullItem = await client.items.get(vaultId, targetItemId);

  const fields: VaultItemDetail['fields'] = [];
  if (fullItem.fields) {
    for (const field of fullItem.fields) {
      // Skip empty/section fields
      if (!field.value && field.fieldType !== 'Concealed') continue;
      fields.push({
        label: field.title || field.id || 'unknown',
        value: field.value || '',
        type: field.fieldType || 'Text',
      });
    }
  }

  const urls: string[] = [];
  if (fullItem.websites) {
    for (const website of fullItem.websites) {
      if (website.url) urls.push(website.url);
    }
  }

  return {
    id: fullItem.id,
    title: fullItem.title,
    category: fullItem.category || 'Unknown',
    fields,
    urls,
  };
}

/**
 * Resolve a 1Password secret reference (op://vault/item/field).
 * Enforces that the vault component matches the configured vault.
 */
async function resolveSecret(reference: string): Promise<string> {
  const client = await getClient();
  if (!client) throw new Error('1Password SDK not initialized');

  // Validate reference format
  if (!reference.startsWith('op://')) {
    throw new Error(
      'Invalid secret reference. Must start with "op://". Format: op://vault/item/field',
    );
  }

  // Parse and validate vault scope
  const parts = reference.slice('op://'.length).split('/');
  if (parts.length < 3) {
    throw new Error(
      'Invalid secret reference format. Expected: op://vault/item/field',
    );
  }

  const vaultPart = decodeURIComponent(parts[0]);
  if (vaultPart.toLowerCase() !== OP_VAULT_NAME.toLowerCase()) {
    throw new Error(
      `Access denied: agent can only access vault "${OP_VAULT_NAME}", not "${vaultPart}"`,
    );
  }

  const secret = await client.secrets.resolve(reference);
  return secret;
}

// ─── IPC Request Handler ────────────────────────────────────────────────────

/**
 * Process a vault IPC request from an agent container.
 * Called by the host's IPC watcher when it finds req-*.json files in the vault/ directory.
 */
export async function processVaultRequest(
  requestId: string,
  action: string,
  params: Record<string, unknown>,
  sourceGroup: string,
): Promise<VaultRequestResult> {
  if (!isVaultEnabled()) {
    return {
      status: 'error',
      error:
        'Vault not configured. Set OP_SERVICE_ACCOUNT_TOKEN in .env to enable 1Password integration.',
    };
  }

  logger.info(
    { module: 'vault', requestId, action, sourceGroup },
    'Processing vault request',
  );

  try {
    switch (action) {
      case 'list_items': {
        const items = await listItems();
        return {
          status: 'ok',
          result: items,
        };
      }

      case 'get_item': {
        const itemTitle = params.item_name as string;
        if (!itemTitle) {
          return { status: 'error', error: 'Missing required parameter: item_name' };
        }
        const item = await getItem(itemTitle);
        // Log that a credential was accessed (without logging the values)
        logger.info(
          { module: 'vault', requestId, sourceGroup, itemTitle: item.title, fieldCount: item.fields.length },
          'Vault item retrieved',
        );
        return {
          status: 'ok',
          result: item,
        };
      }

      case 'resolve_secret': {
        const reference = params.reference as string;
        if (!reference) {
          return { status: 'error', error: 'Missing required parameter: reference' };
        }
        const secret = await resolveSecret(reference);
        logger.info(
          { module: 'vault', requestId, sourceGroup, reference: reference.replace(/\/[^/]+$/, '/***') },
          'Vault secret resolved',
        );
        return {
          status: 'ok',
          result: secret,
        };
      }

      default:
        return { status: 'error', error: `Unknown vault action: ${action}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { module: 'vault', requestId, action, sourceGroup, error: message },
      'Vault request failed',
    );
    return { status: 'error', error: message };
  }
}
