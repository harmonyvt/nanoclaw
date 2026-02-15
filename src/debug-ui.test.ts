import { describe, test, expect } from 'bun:test';
import { InlineKeyboard } from 'grammy';
import {
  SERVICE_ICONS,
  buildDebugOverview,
  buildDebugServiceKeyboard,
  formatLogLine,
  buildServiceLogView,
} from './debug-ui.js';
import { SERVICE_NAMES } from './service-log-writer.js';
import type { LogEntry } from './db.js';

// ─── SERVICE_ICONS ──────────────────────────────────────────────────────────

describe('SERVICE_ICONS', () => {
  test('has an icon for every SERVICE_NAME', () => {
    for (const name of SERVICE_NAMES) {
      expect(SERVICE_ICONS).toHaveProperty(name);
    }
  });

  test('all values are non-empty strings', () => {
    for (const icon of Object.values(SERVICE_ICONS)) {
      expect(typeof icon).toBe('string');
      expect(icon.length).toBeGreaterThan(0);
    }
  });
});

// ─── buildDebugOverview ─────────────────────────────────────────────────────

describe('buildDebugOverview', () => {
  test('returns HTML string containing Debug Log Viewer', () => {
    const html = buildDebugOverview();
    expect(html).toContain('Debug Log Viewer');
  });

  test('returns non-empty string', () => {
    expect(buildDebugOverview().length).toBeGreaterThan(0);
  });
});

// ─── buildDebugServiceKeyboard ──────────────────────────────────────────────

describe('buildDebugServiceKeyboard', () => {
  test('returns an InlineKeyboard instance', () => {
    const kb = buildDebugServiceKeyboard();
    expect(kb).toBeInstanceOf(InlineKeyboard);
  });

  test('includes Export Full Report button', () => {
    const kb = buildDebugServiceKeyboard();
    const json = JSON.stringify(kb);
    expect(json).toContain('d:export');
  });

  test('includes buttons for each service', () => {
    const kb = buildDebugServiceKeyboard();
    const json = JSON.stringify(kb);
    for (const name of SERVICE_NAMES) {
      expect(json).toContain(`d:svc:${name}`);
    }
  });
});

// ─── formatLogLine ──────────────────────────────────────────────────────────

describe('formatLogLine', () => {
  function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
    return {
      id: 1,
      time: new Date('2026-02-15T10:30:45.000Z').getTime(),
      level: 30,
      msg: 'Test log message',
      module: 'telegram',
      ...overrides,
    };
  }

  test('formats timestamp as HH:MM:SS', () => {
    const entry = makeEntry({ time: new Date('2026-02-15T10:30:45.000Z').getTime() });
    const line = formatLogLine(entry);
    // The local time format depends on timezone, but should match HH:MM:SS pattern
    expect(line).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  test('maps Pino level 30 to INFO', () => {
    const line = formatLogLine(makeEntry({ level: 30 }));
    expect(line).toContain('[INFO]');
  });

  test('maps Pino level 40 to WARN', () => {
    const line = formatLogLine(makeEntry({ level: 40 }));
    expect(line).toContain('[WARN]');
  });

  test('maps Pino level 50 to ERROR', () => {
    const line = formatLogLine(makeEntry({ level: 50 }));
    expect(line).toContain('[ERROR]');
  });

  test('maps Pino level 10 to TRACE', () => {
    const line = formatLogLine(makeEntry({ level: 10 }));
    expect(line).toContain('[TRACE]');
  });

  test('maps Pino level 20 to DEBUG', () => {
    const line = formatLogLine(makeEntry({ level: 20 }));
    expect(line).toContain('[DEBUG]');
  });

  test('maps unknown level to L{n} format', () => {
    const line = formatLogLine(makeEntry({ level: 99 }));
    expect(line).toContain('[L99]');
  });

  test('HTML-escapes < and > in message', () => {
    const line = formatLogLine(makeEntry({ msg: '<script>alert</script>' }));
    expect(line).toContain('&lt;script&gt;alert&lt;/script&gt;');
    expect(line).not.toContain('<script>');
  });

  test('includes the message text', () => {
    const line = formatLogLine(makeEntry({ msg: 'Server started on port 3000' }));
    expect(line).toContain('Server started on port 3000');
  });
});

// ─── buildServiceLogView (limited - depends on queryLogs/SQLite) ────────────

describe('buildServiceLogView', () => {
  test('returns "Unknown service" for invalid service name', () => {
    const { text } = buildServiceLogView('nonexistent');
    expect(text).toContain('Unknown service');
  });

  test('returns back button for unknown service', () => {
    const { keyboard } = buildServiceLogView('nonexistent');
    const json = JSON.stringify(keyboard);
    expect(json).toContain('d:back');
  });
});
