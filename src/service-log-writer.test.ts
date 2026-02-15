import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  SERVICE_MODULES,
  SERVICE_NAMES,
  createServiceLogStream,
  closeServiceLogHandles,
  rotateServiceLogs,
} from './service-log-writer.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-svc-log-test-'));
});

afterEach(() => {
  closeServiceLogHandles();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── SERVICE_MODULES ────────────────────────────────────────────────────────

describe('SERVICE_MODULES', () => {
  test('has all expected service names', () => {
    const expected = [
      'container', 'telegram', 'tts', 'browse', 'sandbox',
      'media', 'scheduler', 'supermemory', 'agent', 'replicate', 'dashboard',
    ];
    for (const name of expected) {
      expect(SERVICE_MODULES).toHaveProperty(name);
    }
  });

  test('each service has at least one module', () => {
    for (const [service, modules] of Object.entries(SERVICE_MODULES)) {
      expect(modules.length).toBeGreaterThan(0);
    }
  });

  test('no duplicate module tags across services', () => {
    const seen = new Set<string>();
    for (const modules of Object.values(SERVICE_MODULES)) {
      for (const mod of modules) {
        expect(seen.has(mod)).toBe(false);
        seen.add(mod);
      }
    }
  });
});

// ─── SERVICE_NAMES ──────────────────────────────────────────────────────────

describe('SERVICE_NAMES', () => {
  test('matches keys of SERVICE_MODULES', () => {
    expect(SERVICE_NAMES).toEqual(Object.keys(SERVICE_MODULES));
  });

  test('is a non-empty array', () => {
    expect(SERVICE_NAMES.length).toBeGreaterThan(0);
  });
});

// ─── createServiceLogStream ─────────────────────────────────────────────────

describe('createServiceLogStream', () => {
  function writeToStream(stream: NodeJS.WritableStream, data: string): Promise<void> {
    return new Promise((resolve, reject) => {
      stream.write(data, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  test('creates directory if it does not exist', () => {
    const dir = path.join(tmpDir, 'nonexistent', 'subdir');
    createServiceLogStream(dir);
    expect(fs.existsSync(dir)).toBe(true);
  });

  test('routes telegram module to telegram.log', async () => {
    const stream = createServiceLogStream(tmpDir);
    await writeToStream(stream, JSON.stringify({ module: 'telegram', msg: 'test' }) + '\n');
    // Give the write stream time to flush
    await Bun.sleep(100);

    const logPath = path.join(tmpDir, 'telegram.log');
    expect(fs.existsSync(logPath)).toBe(true);
    const content = fs.readFileSync(logPath, 'utf8');
    expect(content).toContain('"telegram"');
    expect(content).toContain('"test"');
  });

  test('routes claude-cli module to agent.log', async () => {
    const stream = createServiceLogStream(tmpDir);
    await writeToStream(stream, JSON.stringify({ module: 'claude-cli', msg: 'hi' }) + '\n');
    await Bun.sleep(100);

    const logPath = path.join(tmpDir, 'agent.log');
    expect(fs.existsSync(logPath)).toBe(true);
    const content = fs.readFileSync(logPath, 'utf8');
    expect(content).toContain('"claude-cli"');
  });

  test('routes agent module to agent.log', async () => {
    const stream = createServiceLogStream(tmpDir);
    await writeToStream(stream, JSON.stringify({ module: 'agent', msg: 'x' }) + '\n');
    await Bun.sleep(100);

    expect(fs.existsSync(path.join(tmpDir, 'agent.log'))).toBe(true);
  });

  test('skips lines without module field', async () => {
    const stream = createServiceLogStream(tmpDir);
    await writeToStream(stream, JSON.stringify({ msg: 'no module' }) + '\n');
    await Bun.sleep(100);

    const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.log'));
    expect(files.length).toBe(0);
  });

  test('skips lines with unknown module', async () => {
    const stream = createServiceLogStream(tmpDir);
    await writeToStream(stream, JSON.stringify({ module: 'unknown_svc', msg: 'x' }) + '\n');
    await Bun.sleep(100);

    const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.log'));
    expect(files.length).toBe(0);
  });

  test('skips non-JSON lines', async () => {
    const stream = createServiceLogStream(tmpDir);
    await writeToStream(stream, 'not valid json\n');
    await Bun.sleep(100);

    const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.log'));
    expect(files.length).toBe(0);
  });

  test('handles multiple services in one stream', async () => {
    const stream = createServiceLogStream(tmpDir);
    await writeToStream(stream, JSON.stringify({ module: 'telegram', msg: '1' }) + '\n');
    await writeToStream(stream, JSON.stringify({ module: 'media', msg: '2' }) + '\n');
    await Bun.sleep(100);

    expect(fs.existsSync(path.join(tmpDir, 'telegram.log'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'media.log'))).toBe(true);
  });
});

// ─── closeServiceLogHandles ─────────────────────────────────────────────────

describe('closeServiceLogHandles', () => {
  test('closes handles without error after writing', async () => {
    const stream = createServiceLogStream(tmpDir);
    stream.write(JSON.stringify({ module: 'telegram', msg: 'x' }) + '\n');
    await Bun.sleep(50);
    closeServiceLogHandles();
    // No error expected
  });

  test('can be called multiple times safely', () => {
    createServiceLogStream(tmpDir);
    closeServiceLogHandles();
    closeServiceLogHandles(); // second call should not throw
  });
});

// ─── rotateServiceLogs ──────────────────────────────────────────────────────

describe('rotateServiceLogs', () => {
  test('truncates file exceeding maxSizeMB', async () => {
    const stream = createServiceLogStream(tmpDir);
    // Write ~20KB of log lines
    const line = JSON.stringify({ module: 'telegram', msg: 'x'.repeat(200) }) + '\n';
    for (let i = 0; i < 100; i++) {
      stream.write(line);
    }
    await Bun.sleep(200);
    closeServiceLogHandles();

    const logPath = path.join(tmpDir, 'telegram.log');
    const sizeBefore = fs.statSync(logPath).size;

    // Rotate with a very small threshold (1KB = 0.001MB)
    rotateServiceLogs(0.001);

    const sizeAfter = fs.statSync(logPath).size;
    expect(sizeAfter).toBeLessThan(sizeBefore);
  });

  test('keeps files under maxSizeMB untouched', async () => {
    const stream = createServiceLogStream(tmpDir);
    stream.write(JSON.stringify({ module: 'telegram', msg: 'small' }) + '\n');
    await Bun.sleep(100);
    closeServiceLogHandles();

    const logPath = path.join(tmpDir, 'telegram.log');
    const sizeBefore = fs.statSync(logPath).size;

    // Rotate with a large threshold (100MB)
    rotateServiceLogs(100);

    const sizeAfter = fs.statSync(logPath).size;
    expect(sizeAfter).toBe(sizeBefore);
  });

  test('ignores non-.log files', async () => {
    createServiceLogStream(tmpDir);
    // Create a non-.log file that exceeds the limit
    const txtPath = path.join(tmpDir, 'notes.txt');
    fs.writeFileSync(txtPath, 'x'.repeat(10000));

    rotateServiceLogs(0.001);

    // notes.txt should be untouched
    expect(fs.statSync(txtPath).size).toBe(10000);
  });

  test('handles nonexistent logsDir gracefully', () => {
    // Call with no prior createServiceLogStream — logsDir is empty
    rotateServiceLogs(1); // should not throw
  });
});
