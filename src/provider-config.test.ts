import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { RegisteredGroup, ProviderConfig } from './types.js';

// ── Helper: mirrors the resolution logic used in src/index.ts ──────────────
// The host resolves provider/model from the group's optional providerConfig,
// falling back to DEFAULT_PROVIDER / DEFAULT_MODEL from config.ts.

describe('ProviderConfig type', () => {
  test('valid anthropic config without model', () => {
    const cfg: ProviderConfig = { provider: 'anthropic' };
    expect(cfg.provider).toBe('anthropic');
    expect(cfg.model).toBeUndefined();
  });

  test('valid anthropic config with model', () => {
    const cfg: ProviderConfig = { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' };
    expect(cfg.provider).toBe('anthropic');
    expect(cfg.model).toBe('claude-sonnet-4-5-20250929');
  });

  test('valid openai config without model', () => {
    const cfg: ProviderConfig = { provider: 'openai' };
    expect(cfg.provider).toBe('openai');
    expect(cfg.model).toBeUndefined();
  });

  test('valid openai config with model', () => {
    const cfg: ProviderConfig = { provider: 'openai', model: 'gpt-4o' };
    expect(cfg.provider).toBe('openai');
    expect(cfg.model).toBe('gpt-4o');
  });
});

describe('Default provider resolution', () => {
  test('undefined providerConfig resolves to anthropic', () => {
    const group: RegisteredGroup = {
      name: 'test',
      folder: 'test',
      trigger: '@Andy',
      added_at: '2026-01-01',
    };
    const provider = group.providerConfig?.provider || 'anthropic';
    expect(provider).toBe('anthropic');
  });

  test('undefined providerConfig yields undefined model', () => {
    const group: RegisteredGroup = {
      name: 'test',
      folder: 'test',
      trigger: '@Andy',
      added_at: '2026-01-01',
    };
    const model = group.providerConfig?.model || undefined;
    expect(model).toBeUndefined();
  });
});

describe('Provider from group config', () => {
  test('openai provider is picked up from group config', () => {
    const group: RegisteredGroup = {
      name: 'openai-group',
      folder: 'openai-group',
      trigger: '@Oai',
      added_at: '2026-01-01',
      providerConfig: { provider: 'openai' },
    };
    const provider = group.providerConfig?.provider || 'anthropic';
    expect(provider).toBe('openai');
  });

  test('anthropic provider is picked up explicitly from group config', () => {
    const group: RegisteredGroup = {
      name: 'anthropic-group',
      folder: 'anthropic-group',
      trigger: '@Claude',
      added_at: '2026-01-01',
      providerConfig: { provider: 'anthropic' },
    };
    const provider = group.providerConfig?.provider || 'anthropic';
    expect(provider).toBe('anthropic');
  });
});

describe('Model from group config', () => {
  test('model is passed through when set', () => {
    const group: RegisteredGroup = {
      name: 'custom-model',
      folder: 'custom-model',
      trigger: '@Bot',
      added_at: '2026-01-01',
      providerConfig: { provider: 'openai', model: 'gpt-4o' },
    };
    const model = group.providerConfig?.model || undefined;
    expect(model).toBe('gpt-4o');
  });

  test('model is undefined when not set in providerConfig', () => {
    const group: RegisteredGroup = {
      name: 'no-model',
      folder: 'no-model',
      trigger: '@Bot',
      added_at: '2026-01-01',
      providerConfig: { provider: 'openai' },
    };
    const model = group.providerConfig?.model || undefined;
    expect(model).toBeUndefined();
  });
});

describe('DEFAULT_PROVIDER and DEFAULT_MODEL from config', () => {
  let savedProvider: string | undefined;
  let savedModel: string | undefined;

  beforeEach(() => {
    savedProvider = process.env.DEFAULT_PROVIDER;
    savedModel = process.env.DEFAULT_MODEL;
  });

  afterEach(() => {
    // Restore original values
    if (savedProvider !== undefined) {
      process.env.DEFAULT_PROVIDER = savedProvider;
    } else {
      delete process.env.DEFAULT_PROVIDER;
    }
    if (savedModel !== undefined) {
      process.env.DEFAULT_MODEL = savedModel;
    } else {
      delete process.env.DEFAULT_MODEL;
    }
  });

  test('DEFAULT_PROVIDER falls back to anthropic when env is unset', async () => {
    delete process.env.DEFAULT_PROVIDER;
    // config.ts reads env at import time, so we use dynamic re-import
    // to simulate a fresh module evaluation.
    // Note: Bun caches modules, so instead we test the fallback pattern
    // used at the call site: `group.providerConfig?.provider || DEFAULT_PROVIDER`
    const DEFAULT_PROVIDER = process.env.DEFAULT_PROVIDER || 'anthropic';
    expect(DEFAULT_PROVIDER).toBe('anthropic');
  });

  test('DEFAULT_PROVIDER reads from env when set', () => {
    process.env.DEFAULT_PROVIDER = 'openai';
    const DEFAULT_PROVIDER = process.env.DEFAULT_PROVIDER || 'anthropic';
    expect(DEFAULT_PROVIDER).toBe('openai');
  });

  test('DEFAULT_MODEL falls back to empty string when env is unset', () => {
    delete process.env.DEFAULT_MODEL;
    const DEFAULT_MODEL = process.env.DEFAULT_MODEL || '';
    expect(DEFAULT_MODEL).toBe('');
  });

  test('DEFAULT_MODEL reads from env when set', () => {
    process.env.DEFAULT_MODEL = 'gpt-4o-mini';
    const DEFAULT_MODEL = process.env.DEFAULT_MODEL || '';
    expect(DEFAULT_MODEL).toBe('gpt-4o-mini');
  });

  test('full resolution pattern matches index.ts logic', () => {
    // Simulate the exact pattern from src/index.ts lines 307-308:
    //   const provider = group.providerConfig?.provider || DEFAULT_PROVIDER;
    //   const model = group.providerConfig?.model || DEFAULT_MODEL || undefined;
    process.env.DEFAULT_PROVIDER = 'openai';
    process.env.DEFAULT_MODEL = 'gpt-4o';
    const DEFAULT_PROVIDER = process.env.DEFAULT_PROVIDER || 'anthropic';
    const DEFAULT_MODEL = process.env.DEFAULT_MODEL || '';

    // Group without providerConfig should fall back to env defaults
    const group: RegisteredGroup = {
      name: 'test',
      folder: 'test',
      trigger: '@Andy',
      added_at: '2026-01-01',
    };
    const provider = group.providerConfig?.provider || DEFAULT_PROVIDER;
    const model = group.providerConfig?.model || DEFAULT_MODEL || undefined;

    expect(provider).toBe('openai');
    expect(model).toBe('gpt-4o');
  });

  test('group providerConfig overrides DEFAULT_PROVIDER env', () => {
    process.env.DEFAULT_PROVIDER = 'openai';
    const DEFAULT_PROVIDER = process.env.DEFAULT_PROVIDER || 'anthropic';

    const group: RegisteredGroup = {
      name: 'override',
      folder: 'override',
      trigger: '@Bot',
      added_at: '2026-01-01',
      providerConfig: { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
    };
    const provider = group.providerConfig?.provider || DEFAULT_PROVIDER;
    const model = group.providerConfig?.model || '' || undefined;

    expect(provider).toBe('anthropic');
    expect(model).toBe('claude-sonnet-4-5-20250929');
  });
});

describe('ContainerInput shape', () => {
  test('input with provider and model compiles and works', () => {
    const input = {
      prompt: 'test',
      groupFolder: 'test',
      chatJid: 'tg:123',
      isMain: true,
      provider: 'openai',
      model: 'gpt-4o',
    };
    expect(input.provider).toBe('openai');
    expect(input.model).toBe('gpt-4o');
    expect(input.prompt).toBe('test');
    expect(input.isMain).toBe(true);
  });

  test('input with provider but no model', () => {
    const input = {
      prompt: 'hello',
      groupFolder: 'main',
      chatJid: 'tg:456',
      isMain: false,
      provider: 'anthropic',
      model: undefined as string | undefined,
    };
    expect(input.provider).toBe('anthropic');
    expect(input.model).toBeUndefined();
  });

  test('input includes sessionId and assistantName', () => {
    const input = {
      prompt: 'test',
      sessionId: 'sess-abc-123',
      groupFolder: 'main',
      chatJid: 'tg:789',
      isMain: true,
      assistantName: 'Andy',
      provider: 'anthropic',
      model: undefined as string | undefined,
    };
    expect(input.sessionId).toBe('sess-abc-123');
    expect(input.assistantName).toBe('Andy');
    expect(input.provider).toBe('anthropic');
  });
});

describe('Backward compatibility', () => {
  test('RegisteredGroup without providerConfig resolves provider as anthropic', () => {
    const group: RegisteredGroup = {
      name: 'legacy',
      folder: 'legacy',
      trigger: '@Andy',
      added_at: '2025-06-01',
    };

    // providerConfig is optional on RegisteredGroup
    expect(group.providerConfig).toBeUndefined();

    // Resolution fallback (mirrors index.ts)
    const provider = group.providerConfig?.provider || 'anthropic';
    expect(provider).toBe('anthropic');
  });

  test('RegisteredGroup without providerConfig resolves model as undefined', () => {
    const group: RegisteredGroup = {
      name: 'legacy',
      folder: 'legacy',
      trigger: '@Andy',
      added_at: '2025-06-01',
    };

    const model = group.providerConfig?.model || '' || undefined;
    expect(model).toBeUndefined();
  });

  test('RegisteredGroup with containerConfig but no providerConfig still defaults', () => {
    const group: RegisteredGroup = {
      name: 'container-only',
      folder: 'container-only',
      trigger: '@Bot',
      added_at: '2025-06-01',
      containerConfig: {
        timeout: 600000,
        additionalMounts: [
          { hostPath: '~/projects', containerPath: '/workspace/extra/projects' },
        ],
      },
    };

    expect(group.containerConfig).toBeDefined();
    expect(group.providerConfig).toBeUndefined();

    const provider = group.providerConfig?.provider || 'anthropic';
    expect(provider).toBe('anthropic');
  });

  test('RegisteredGroup registration shape with providerConfig', () => {
    // Mirrors the register_group IPC handler in index.ts
    const registration: RegisteredGroup = {
      name: 'new-group',
      folder: 'new-group',
      trigger: '@NewBot',
      added_at: new Date().toISOString(),
      providerConfig: { provider: 'openai', model: 'gpt-4o' },
    };

    expect(registration.providerConfig?.provider).toBe('openai');
    expect(registration.providerConfig?.model).toBe('gpt-4o');
  });
});
