import { describe, expect, test } from 'bun:test';
import { buildElementSearchQueries } from './browse-host.js';

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
