import { describe, expect, it } from 'vitest';

import { parseMergeRepositoryKey } from '../policy.js';

describe('parseMergeRepositoryKey', () => {
  it('accepts a well-formed owner/repo key and reports both segments', () => {
    expect(parseMergeRepositoryKey('acme/widgets')).toEqual({ owner: 'acme', repo: 'widgets' });
  });

  it('accepts every allowed character in both segments (dots, underscores, hyphens)', () => {
    expect(parseMergeRepositoryKey('a.b_c-1/r.1')).toEqual({ owner: 'a.b_c-1', repo: 'r.1' });
  });

  it('refuses empty, single-segment, empty-side, and multi-slash keys', () => {
    for (const key of ['', 'acme', 'acme/', '/widgets', 'a/b/c']) {
      expect(parseMergeRepositoryKey(key)).toBeUndefined();
    }
  });

  it('refuses whitespace, newlines, backslashes, and disallowed characters', () => {
    for (const key of [
      'acme/wid gets',
      'acme/wid\ngets',
      'acme/widgets\n',
      'acme\\widgets',
      'acme/wid@gets',
      'acme/wid$gets',
    ]) {
      expect(parseMergeRepositoryKey(key)).toBeUndefined();
    }
  });

  it('refuses dot and double-dot segments while accepting dot-prefixed names', () => {
    for (const key of ['./widgets', 'acme/.', '../widgets', 'acme/..']) {
      expect(parseMergeRepositoryKey(key)).toBeUndefined();
    }
    expect(parseMergeRepositoryKey('.acme/widgets')).toEqual({ owner: '.acme', repo: 'widgets' });
    expect(parseMergeRepositoryKey('acme/..x')).toEqual({ owner: 'acme', repo: '..x' });
  });

  it('enforces 100-character segment length bounds and refuses enormous inputs', () => {
    expect(parseMergeRepositoryKey('a'.repeat(100) + '/' + 'b'.repeat(100))).toEqual({
      owner: 'a'.repeat(100),
      repo: 'b'.repeat(100),
    });
    expect(parseMergeRepositoryKey('a'.repeat(101) + '/widgets')).toBeUndefined();
    expect(parseMergeRepositoryKey('acme/' + 'b'.repeat(101))).toBeUndefined();
    expect(parseMergeRepositoryKey('a'.repeat(100_000) + '/widgets')).toBeUndefined();
  });

  it('returns a plain two-key object without prototype pollution for __proto__/x', () => {
    const result = parseMergeRepositoryKey('__proto__/x');
    expect(result).toEqual({ owner: '__proto__', repo: 'x' });
    expect(Object.keys(result!)).toEqual(['owner', 'repo']);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });
});
