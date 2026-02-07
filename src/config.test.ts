import { describe, test, expect } from 'bun:test';
import {
  makeTelegramChatId,
  extractTelegramChatId,
  isTelegramChat,
  TRIGGER_PATTERN,
  ASSISTANT_NAME,
  STORE_DIR,
  GROUPS_DIR,
  DATA_DIR,
  CONTAINER_NETWORK_MODE,
  CONTAINER_TIMEOUT,
  CONTAINER_MAX_OUTPUT_SIZE,
  SECRETLESS_MODE,
} from './config.js';

describe('makeTelegramChatId', () => {
  test('prefixes numeric ID with tg:', () => {
    expect(makeTelegramChatId(123456)).toBe('tg:123456');
  });

  test('handles negative chat IDs (groups)', () => {
    expect(makeTelegramChatId(-100123456)).toBe('tg:-100123456');
  });
});

describe('extractTelegramChatId', () => {
  test('strips tg: prefix and returns number', () => {
    expect(extractTelegramChatId('tg:123456')).toBe(123456);
  });

  test('handles negative IDs', () => {
    expect(extractTelegramChatId('tg:-100123456')).toBe(-100123456);
  });
});

describe('isTelegramChat', () => {
  test('returns true for tg: prefixed IDs', () => {
    expect(isTelegramChat('tg:123')).toBe(true);
  });

  test('returns false for non-telegram IDs', () => {
    expect(isTelegramChat('wa:123')).toBe(false);
    expect(isTelegramChat('123')).toBe(false);
  });
});

describe('TRIGGER_PATTERN', () => {
  test('matches @Name at start of message', () => {
    expect(TRIGGER_PATTERN.test(`@${ASSISTANT_NAME} hello`)).toBe(true);
  });

  test('matches case-insensitively', () => {
    expect(TRIGGER_PATTERN.test(`@${ASSISTANT_NAME.toLowerCase()} hello`)).toBe(true);
    expect(TRIGGER_PATTERN.test(`@${ASSISTANT_NAME.toUpperCase()} hello`)).toBe(true);
  });

  test('does not match mid-message', () => {
    expect(TRIGGER_PATTERN.test(`hello @${ASSISTANT_NAME}`)).toBe(false);
  });

  test('does not match partial names', () => {
    expect(TRIGGER_PATTERN.test(`@${ASSISTANT_NAME}y`)).toBe(false);
  });
});

describe('ASSISTANT_NAME', () => {
  test('is a non-empty string', () => {
    expect(typeof ASSISTANT_NAME).toBe('string');
    expect(ASSISTANT_NAME.length).toBeGreaterThan(0);
  });
});

describe('path constants', () => {
  test('are absolute paths', () => {
    expect(STORE_DIR.startsWith('/')).toBe(true);
    expect(GROUPS_DIR.startsWith('/')).toBe(true);
    expect(DATA_DIR.startsWith('/')).toBe(true);
  });
});

describe('container defaults', () => {
  test('CONTAINER_TIMEOUT is a positive number', () => {
    expect(CONTAINER_TIMEOUT).toBeGreaterThan(0);
  });

  test('CONTAINER_MAX_OUTPUT_SIZE is a positive number', () => {
    expect(CONTAINER_MAX_OUTPUT_SIZE).toBeGreaterThan(0);
  });

  test('CONTAINER_NETWORK_MODE is either default or none', () => {
    expect(['default', 'none']).toContain(CONTAINER_NETWORK_MODE);
  });

  test('SECRETLESS_MODE is a boolean', () => {
    expect(typeof SECRETLESS_MODE).toBe('boolean');
  });
});
