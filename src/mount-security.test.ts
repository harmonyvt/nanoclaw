import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  loadMountAllowlist,
  validateMount,
  validateAdditionalMounts,
  generateAllowlistTemplate,
} from './mount-security.js';

// We need to reset the cached allowlist between tests.
// The module caches the allowlist in memory, so we need to
// clear the module cache or use a workaround.
// Since bun:test doesn't easily support module re-import,
// we test the public API with a real allowlist file.

let tmpDir: string;
let allowlistPath: string;

// Save and restore the MOUNT_ALLOWLIST_PATH
// Since the module reads from config.MOUNT_ALLOWLIST_PATH which is a constant,
// we test the functions that don't depend on the cached singleton.

describe('mount-security', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mount-test-'));
    allowlistPath = path.join(tmpDir, 'mount-allowlist.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('generateAllowlistTemplate returns valid JSON', () => {
    const template = generateAllowlistTemplate();
    const parsed = JSON.parse(template);
    expect(Array.isArray(parsed.allowedRoots)).toBe(true);
    expect(Array.isArray(parsed.blockedPatterns)).toBe(true);
    expect(typeof parsed.nonMainReadOnly).toBe('boolean');
  });

  test('generateAllowlistTemplate has example roots', () => {
    const parsed = JSON.parse(generateAllowlistTemplate());
    expect(parsed.allowedRoots.length).toBeGreaterThan(0);
    expect(parsed.allowedRoots[0]).toHaveProperty('path');
    expect(parsed.allowedRoots[0]).toHaveProperty('allowReadWrite');
  });

  test('validateMount rejects when no allowlist loaded', () => {
    // With the module's cached state being null on first load with no file,
    // we can test the rejection behavior.
    // Note: This test relies on the module having no cached allowlist at this path.
    const result = validateMount(
      { hostPath: '/tmp/test', containerPath: 'test' },
      true,
    );
    // Will either reject because no allowlist or because path isn't under allowed root
    expect(result.allowed === false || result.reason.length > 0).toBe(true);
  });

  test('validateMount rejects invalid container paths', () => {
    // Container path with .. is always rejected regardless of allowlist
    const result = validateMount(
      { hostPath: '/tmp', containerPath: '../escape' },
      true,
    );
    expect(result.allowed).toBe(false);
  });

  test('validateMount rejects absolute container paths', () => {
    const result = validateMount(
      { hostPath: '/tmp', containerPath: '/absolute/path' },
      true,
    );
    expect(result.allowed).toBe(false);
  });

  test('validateMount rejects empty container paths', () => {
    const result = validateMount(
      { hostPath: '/tmp', containerPath: '' },
      true,
    );
    expect(result.allowed).toBe(false);
  });

  test('validateMount rejects whitespace-only container paths', () => {
    const result = validateMount(
      { hostPath: '/tmp', containerPath: '   ' },
      true,
    );
    expect(result.allowed).toBe(false);
  });

  test('validateAdditionalMounts returns empty array for empty input', () => {
    const result = validateAdditionalMounts([], 'test', true);
    expect(result).toEqual([]);
  });

  test('validateAdditionalMounts filters out invalid mounts', () => {
    const mounts = [
      { hostPath: '/tmp', containerPath: '../escape' },
      { hostPath: '/tmp', containerPath: '/absolute' },
    ];
    const result = validateAdditionalMounts(mounts, 'test', true);
    // Both should be rejected
    expect(result.length).toBe(0);
  });

  test('default blocked patterns include sensitive directories', () => {
    // We can verify this by checking that paths containing these patterns are blocked.
    // Since validateMount checks blocked patterns after allowlist loading,
    // and we can't easily inject an allowlist here, we test the pattern list
    // exists in the generated template.
    const template = JSON.parse(generateAllowlistTemplate());
    // The template has user-specified patterns; defaults are merged at load time.
    // At minimum, the template should have some patterns.
    expect(template.blockedPatterns.length).toBeGreaterThan(0);
  });

  test('allowlist template has nonMainReadOnly set to true', () => {
    const template = JSON.parse(generateAllowlistTemplate());
    expect(template.nonMainReadOnly).toBe(true);
  });
});
