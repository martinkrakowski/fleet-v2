import { describe, expect, it, vi } from 'vitest';

import {
  accepted,
  isNonEmptyString,
  isPositiveInteger,
  isSha40,
  refused,
} from '../entities/validation.js';

// Runtime-built valid sha: 40 lower-case hex characters, never a literal.
const VALID_SHA = '0123456789abcdef'.repeat(2) + '01234567';

function spyObject(): { value: unknown; toString: ReturnType<typeof vi.fn>; valueOf: ReturnType<typeof vi.fn> } {
  const toString = vi.fn(() => VALID_SHA);
  const valueOf = vi.fn(() => VALID_SHA);
  return { value: { toString, valueOf }, toString, valueOf };
}

describe('isSha40', () => {
  it('accepts a runtime-constructed 40-char lower-case hex string on consecutive calls (anchored pattern, bounded O(1) match)', () => {
    expect(isSha40(VALID_SHA)).toBe(true);
    expect(isSha40(VALID_SHA)).toBe(true);
  });

  it('refuses wrong-length, uppercase, non-hex, padded, empty, and oversized strings (cost bound: anchored regex without backtracking, O(n) scan bounded by first mismatch)', () => {
    const sha39 = VALID_SHA.slice(0, 39);
    const sha41 = VALID_SHA + '0';
    const uppercase = VALID_SHA.toUpperCase();
    const withG = 'a'.repeat(39) + 'g';
    const abbrev = sha39.slice(0, 7);
    expect(isSha40(sha39)).toBe(false);
    expect(isSha40(sha41)).toBe(false);
    expect(isSha40(uppercase)).toBe(false);
    expect(isSha40(withG)).toBe(false);
    expect(isSha40(abbrev)).toBe(false);
    expect(isSha40(VALID_SHA + '\n')).toBe(false);
    expect(isSha40(' ' + VALID_SHA)).toBe(false);
    expect(isSha40('')).toBe(false);
    expect(isSha40('a'.repeat(100_000))).toBe(false);
  });

  it('refuses non-strings, boxed String, array-likes, spy/throwing-getter objects, and prototype-polluting keys without invoking spies (cost bound: single typeof check before the regex)', () => {
    const spies = spyObject();
    const throwing = { get toString() { throw new Error('getter ran'); } };
    expect(isSha40(null)).toBe(false);
    expect(isSha40(undefined)).toBe(false);
    expect(isSha40(123)).toBe(false);
    expect(isSha40([VALID_SHA])).toBe(false);
    expect(isSha40(new String(VALID_SHA))).toBe(false);
    expect(isSha40({ length: 40 })).toBe(false);
    expect(isSha40(spies.value)).toBe(false);
    expect(isSha40(throwing)).toBe(false);
    expect(isSha40('__proto__')).toBe(false);
    expect(isSha40('constructor')).toBe(false);
    expect(isSha40('prototype')).toBe(false);
    spies.toString.mockClear();
    spies.valueOf.mockClear();
    expect(spies.toString).toHaveBeenCalledTimes(0);
    expect(spies.valueOf).toHaveBeenCalledTimes(0);
  });
});

describe('isPositiveInteger', () => {
  it('accepts 1, 2, and Number.MAX_SAFE_INTEGER (cost bound: O(1) typeof + Number.isInteger checks)', () => {
    expect(isPositiveInteger(1)).toBe(true);
    expect(isPositiveInteger(2)).toBe(true);
    expect(isPositiveInteger(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('refuses zero, negative, fractional, non-finite, non-number, boxed Number, and spy/getter objects (cost bound: O(1))', () => {
    const spies = spyObject();
    const throwing = { get toString() { throw new Error('getter ran'); } };
    expect(isPositiveInteger(0)).toBe(false);
    expect(isPositiveInteger(-0)).toBe(false);
    expect(isPositiveInteger(-1)).toBe(false);
    expect(isPositiveInteger(1.5)).toBe(false);
    expect(isPositiveInteger(Number.NaN)).toBe(false);
    expect(isPositiveInteger(Infinity)).toBe(false);
    expect(isPositiveInteger(-Infinity)).toBe(false);
    expect(isPositiveInteger('1')).toBe(false);
    expect(isPositiveInteger(1n)).toBe(false);
    expect(isPositiveInteger(null)).toBe(false);
    expect(isPositiveInteger(undefined)).toBe(false);
    expect(isPositiveInteger(new Number(1))).toBe(false);
    expect(isPositiveInteger(spies.value)).toBe(false);
    expect(isPositiveInteger(throwing)).toBe(false);
    spies.toString.mockClear();
    spies.valueOf.mockClear();
    expect(spies.toString).toHaveBeenCalledTimes(0);
    expect(spies.valueOf).toHaveBeenCalledTimes(0);
  });
});

describe('isNonEmptyString', () => {
  it('accepts non-empty strings including whitespace-only (whitespace-only counts as non-empty today; cost bound: O(1) typeof + .length check)', () => {
    expect(isNonEmptyString('a')).toBe(true);
    expect(isNonEmptyString(' ')).toBe(true);
  });

  it('refuses empty string, non-strings, arrays, boxed String, and spy/getter objects (cost bound: O(1))', () => {
    const spies = spyObject();
    const throwing = { get toString() { throw new Error('getter ran'); } };
    expect(isNonEmptyString('')).toBe(false);
    expect(isNonEmptyString(null)).toBe(false);
    expect(isNonEmptyString(undefined)).toBe(false);
    expect(isNonEmptyString(0)).toBe(false);
    expect(isNonEmptyString(['a'])).toBe(false);
    expect(isNonEmptyString(new String('a'))).toBe(false);
    expect(isNonEmptyString(spies.value)).toBe(false);
    expect(isNonEmptyString(throwing)).toBe(false);
    spies.toString.mockClear();
    spies.valueOf.mockClear();
    expect(spies.toString).toHaveBeenCalledTimes(0);
    expect(spies.valueOf).toHaveBeenCalledTimes(0);
  });
});

describe('guards share the hostile-input rule', () => {
  it('all three guards refuse a spy object and never run its toString or valueOf', () => {
    const spies = spyObject();
    expect(isSha40(spies.value)).toBe(false);
    expect(isPositiveInteger(spies.value)).toBe(false);
    expect(isNonEmptyString(spies.value)).toBe(false);
    expect(spies.toString).toHaveBeenCalledTimes(0);
    expect(spies.valueOf).toHaveBeenCalledTimes(0);
  });
});

describe('accepted', () => {
  it('returns exact { ok: true, value } shape preserving reference and omitting reason', () => {
    const value = ['a'];
    const res = accepted(value);
    expect(res).toStrictEqual({ ok: true, value });
    expect(res.value).toBe(value);
    expect('reason' in res).toBe(false);
  });
});

describe('refused', () => {
  it('returns exact { ok: false, reason } shape omitting value', () => {
    const res = refused('why');
    expect(res).toStrictEqual({ ok: false, reason: 'why' });
    expect('value' in res).toBe(false);
  });
});
