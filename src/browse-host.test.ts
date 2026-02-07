import { describe, expect, test } from 'bun:test';
import {
  buildScreenshotAnalysis,
  buildElementSearchQueries,
  ensureWaitForUserRequest,
  getOldestWaitForUserRequest,
  getWaitForUserRequest,
  getWaitForUserRequestByToken,
  hasWaitingRequests,
  processBrowseRequest,
  resolveWaitForUser,
  resolveWaitForUserByToken,
} from './browse-host.js';

function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe('wait_for_user takeover state', () => {
  test('creates a stable token per request ID and updates message', () => {
    const requestId = uniqueId('wait');
    const first = ensureWaitForUserRequest(
      requestId,
      'group-alpha',
      'Please log in.',
    );
    const second = ensureWaitForUserRequest(
      requestId,
      'group-alpha',
      'Please finish login, then return control.',
    );

    expect(second.token).toBe(first.token);
    expect(second.requestId).toBe(requestId);
    expect(second.message).toContain('finish login');
    expect(getWaitForUserRequestByToken(first.token)?.requestId).toBe(
      requestId,
    );
    expect(hasWaitingRequests('group-alpha')).toBe(true);

    expect(resolveWaitForUserByToken(first.token)).toBe(true);
    expect(getWaitForUserRequest(requestId)).toBeNull();
  });

  test('resolveWaitForUserByToken unblocks processBrowseRequest', async () => {
    const requestId = uniqueId('wait');
    const waitPromise = processBrowseRequest(
      requestId,
      'wait_for_user',
      { message: 'Take over in browser.' },
      'group-beta',
      '/tmp',
    );

    const pending = getWaitForUserRequest(requestId);
    expect(pending).not.toBeNull();
    expect(pending?.groupFolder).toBe('group-beta');

    expect(resolveWaitForUserByToken(String(pending?.token))).toBe(true);

    const result = await waitPromise;
    expect(result.status).toBe('ok');
    expect(result.result).toBe('User continued');
    expect(getWaitForUserRequest(requestId)).toBeNull();
  });

  test('resolveWaitForUser keeps group scoping', async () => {
    const requestId = uniqueId('wait');
    const waitPromise = processBrowseRequest(
      requestId,
      'wait_for_user',
      { message: 'Enter MFA code.' },
      'group-gamma',
      '/tmp',
    );

    const pending = getWaitForUserRequest(requestId);
    expect(pending).not.toBeNull();
    expect(resolveWaitForUser('wrong-group', requestId)).toBe(false);
    expect(resolveWaitForUser('group-gamma', requestId)).toBe(true);

    const result = await waitPromise;
    expect(result.status).toBe('ok');
    expect(getWaitForUserRequestByToken(String(pending?.token))).toBeNull();
  });

  test('getOldestWaitForUserRequest filters by group', () => {
    const reqA = uniqueId('wait');
    const reqB = uniqueId('wait');

    const first = ensureWaitForUserRequest(reqA, 'group-delta', 'A');
    const second = ensureWaitForUserRequest(reqB, 'group-epsilon', 'B');

    expect(getOldestWaitForUserRequest('group-delta')?.requestId).toBe(reqA);
    expect(getOldestWaitForUserRequest('group-epsilon')?.requestId).toBe(reqB);
    expect(getOldestWaitForUserRequest()?.requestId).toBe(first.requestId);

    expect(resolveWaitForUserByToken(first.token)).toBe(true);
    expect(resolveWaitForUserByToken(second.token)).toBe(true);
  });
});

describe('buildElementSearchQueries', () => {
  test('uses text= prefix as direct query', () => {
    const queries = buildElementSearchQueries('text=Sign In');
    expect(queries).toEqual(['Sign In']);
  });

  test('derives search queries from type=search selector', () => {
    const queries = buildElementSearchQueries('input[type="search"]');
    expect(queries).toContain('input[type="search"]');
    expect(queries).toContain('search');
    expect(queries).toContain('search box');
  });

  test('extracts aria label and normalizes id/class tokens', () => {
    const queries = buildElementSearchQueries(
      'input[aria-label="Search Twitch"]#global_search.search-input',
    );
    expect(queries).toContain('Search Twitch');
    expect(queries).toContain('global search');
    expect(queries).toContain('search input');
  });

  test('deduplicates repeated search candidates', () => {
    const queries = buildElementSearchQueries(
      'input[type="search"][placeholder="Search"]',
    );
    const searchCount = queries.filter(
      (query) => query.toLowerCase() === 'search',
    ).length;
    expect(searchCount).toBe(1);
  });
});

describe('buildScreenshotAnalysis', () => {
  test('extracts labeled elements and assigns grid cells', () => {
    const snapshot = {
      tree: {
        role: 'Window',
        title: 'Chromium',
        position: { x: 0, y: 0 },
        size: { width: 1024, height: 768 },
        children: [
          {
            role: 'button',
            title: 'Search',
            position: { x: 100, y: 80 },
            size: { width: 120, height: 30 },
            children: [],
          },
          {
            role: 'textbox',
            title: 'Email',
            position: { x: 300, y: 300 },
            size: { width: 220, height: 40 },
            children: [],
          },
        ],
      },
    };

    const analysis = buildScreenshotAnalysis(snapshot, {
      width: 1024,
      height: 768,
    });

    expect(analysis.grid.cols).toBe(12);
    expect(analysis.grid.rows).toBe(8);
    expect(analysis.elementCount).toBe(2);
    expect(analysis.elements[0]?.label).toBe('Search');
    expect(analysis.elements[0]?.grid.key).toBe('B1');
    expect(analysis.elements[1]?.label).toBe('Email');
    expect(analysis.elements[1]?.interactive).toBe(true);
  });

  test('supports normalized bounds from detectors', () => {
    const snapshot = {
      tree: {
        role: 'window',
        children: [
          {
            type: 'text',
            content: 'Continue',
            bounds: { x: 0.5, y: 0.5, width: 0.2, height: 0.1 },
          },
        ],
      },
    };

    const analysis = buildScreenshotAnalysis(
      snapshot,
      { width: 1000, height: 800 },
      { rows: 8, cols: 10 },
    );

    expect(analysis.elementCount).toBe(1);
    expect(analysis.elements[0]?.label).toBe('Continue');
    expect(analysis.elements[0]?.center).toEqual({ x: 600, y: 440 });
    expect(analysis.elements[0]?.grid.key).toBe('G5');
  });

  test('truncates large element lists', () => {
    const children = Array.from({ length: 6 }, (_, index) => ({
      role: 'button',
      title: `Button ${index + 1}`,
      position: { x: 40 + index * 60, y: 100 },
      size: { width: 40, height: 24 },
      children: [],
    }));

    const analysis = buildScreenshotAnalysis(
      { tree: { role: 'window', children } },
      { width: 800, height: 600 },
      { maxElements: 3 },
    );

    expect(analysis.elementCount).toBe(6);
    expect(analysis.elements).toHaveLength(3);
    expect(analysis.truncated).toBe(true);
  });
});
