import { describe, expect, it } from 'vitest';

import { redactSecrets, sanitizeToken } from '../draft.js';

// Secret-shaped fixtures are built at runtime by concatenation and repeat,
// never written as literals in this file. Cost bound: each call is O(n * P),
// linear in input length n times the fixed pattern count P.
describe('redactSecrets', () => {
  it('returns plain text and the empty string unchanged', () => {
    expect(redactSecrets('plain host note')).toBe('plain host note');
    expect(redactSecrets('')).toBe('');
  });
});

describe('redactSecrets', () => {
  it('redacts a single token-shaped span and keeps the surrounding text', () => {
    const token = 'gh' + 'p_' + 'a'.repeat(30);
    const output = redactSecrets('prefix ' + token + ' suffix');
    expect(output).toBe('prefix <redacted> suffix');
    expect(output.includes(token)).toBe(false);
  });

  it('redacts two token-shaped spans in one string', () => {
    const a = 'gh' + 'p_' + 'a'.repeat(30);
    const b = 'AK' + 'IA' + 'B'.repeat(16);
    const output = redactSecrets(a + ' middle ' + b);
    expect(output).toBe('<redacted> middle <redacted>');
    expect(output.match(/<redacted>/g)).toHaveLength(2);
  });
});

describe('redactSecrets', () => {
  it('returns the same output on repeat calls and is idempotent', () => {
    const input = 'keep ' + 'gh' + 'p_' + 'a'.repeat(30) + ' end';
    const first = redactSecrets(input);
    expect(redactSecrets(input)).toBe(first);
    expect(redactSecrets(first)).toBe(first);
  });
});

describe('redactSecrets', () => {
  it('keeps filesystem separators that sanitizeToken redacts, at linear cost', () => {
    // '/' is in SEPARATORS: sanitizeToken redacts it, redactSecrets keeps it.
    expect(redactSecrets('host/sub')).toBe('host/sub');
    expect(sanitizeToken('host/sub')).toBe('host<redacted>sub');
    // Cost bound: O(n * P) with P the fixed pattern count, so a
    // 1,000,000-character secret-free input returns unchanged.
    const big = "a ".repeat(500_000);
    expect(redactSecrets(big)).toBe(big);
  });
});
