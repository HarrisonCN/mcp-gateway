/** MGW-2026-013 backport: glob matching is linear (no catastrophic backtracking on client-supplied patterns). */
import { describe, it, expect } from 'vitest';
import { globToRegExp } from '../src/utils/tool-filter.js';
import { narrowScope } from '../src/features/agent-identity.js';

describe('13.5.0 glob matching is linear (MGW-2026-013)', () => {
  it('a hostile pattern against a long name finishes fast and still matches correctly', () => {
    const t = Date.now();
    expect(globToRegExp('*a'.repeat(30) + 'x').test('a'.repeat(200))).toBe(false);
    expect(globToRegExp('*a'.repeat(30) + 'x').test('a'.repeat(60) + 'x')).toBe(true);
    expect(Date.now() - t).toBeLessThan(500);
  });
  it('agent-identity scope narrowing with a client-supplied hostile glob does not hang', () => {
    const catalog = Array.from({ length: 50 }, (_, i) => `srv/${'a'.repeat(60)}${i}`);
    const t = Date.now();
    expect(narrowScope(['srv/*'], ['*a'.repeat(25) + 'zz'], catalog)).toEqual([]);
    expect(Date.now() - t).toBeLessThan(500);
  });
  it('semantics unchanged: * / ? / literal metacharacters', () => {
    expect(globToRegExp('github/search_*').test('github/search_code')).toBe(true);
    expect(globToRegExp('a?c').test('abc')).toBe(true);
    expect(globToRegExp('a?c').test('ac')).toBe(false);
    expect(globToRegExp('a.c').test('abc')).toBe(false);
    expect(globToRegExp('(x)+[y]').test('(x)+[y]')).toBe(true);
    expect(globToRegExp('*').test('multi\nline')).toBe(true);
    expect(globToRegExp('').test('')).toBe(true);
    expect(globToRegExp('').test('a')).toBe(false);
  });
});
