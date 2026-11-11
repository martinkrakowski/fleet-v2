import { describe, expect, it } from 'vitest';

import {
  isPullRequestTierLabel,
  pullRequestTierLabel,
} from '../pull-request-tier-label.js';

const INVALID_TIER = { ok: false, reason: 'invalid-tier' as const };

describe('pullRequestTierLabel', () => {
  it('returns label tier:1 for the number 1', () => {
    expect(pullRequestTierLabel(1)).toEqual({ ok: true, label: 'tier:1' });
  });

  it('returns label tier:2 for the number 2', () => {
    expect(pullRequestTierLabel(2)).toEqual({ ok: true, label: 'tier:2' });
  });

  it('refuses null with invalid-tier', () => {
    expect(() => pullRequestTierLabel(null)).not.toThrow();
    expect(pullRequestTierLabel(null)).toEqual(INVALID_TIER);
  });

  it('refuses undefined with invalid-tier', () => {
    expect(() => pullRequestTierLabel(undefined)).not.toThrow();
    expect(pullRequestTierLabel(undefined)).toEqual(INVALID_TIER);
  });

  it('refuses a string, a boolean, a bigint, a symbol, and a function with invalid-tier', () => {
    const values: unknown[] = [
      'tier:1',
      '',
      true,
      false,
      1n,
      Symbol('tier'),
      () => 1,
    ];
    for (const value of values) {
      expect(() => pullRequestTierLabel(value)).not.toThrow();
      expect(pullRequestTierLabel(value)).toEqual(INVALID_TIER);
    }
  });

  it('refuses 0, 3, 1.5, NaN, and Infinity with invalid-tier', () => {
    const values: unknown[] = [0, 3, 1.5, NaN, Infinity, -Infinity];
    for (const value of values) {
      expect(() => pullRequestTierLabel(value)).not.toThrow();
      expect(pullRequestTierLabel(value)).toEqual(INVALID_TIER);
    }
  });

  it('refuses an array with a hole and a throwing index getter without calling the getter', () => {
    let getterCalls = 0;
    const arr: unknown[] = [];
    Object.defineProperty(arr, '0', {
      get() {
        getterCalls += 1;
        throw new Error('boom');
      },
      enumerable: true,
      configurable: true,
    });
    expect(() => pullRequestTierLabel(arr)).not.toThrow();
    expect(pullRequestTierLabel(arr)).toEqual(INVALID_TIER);
    expect(getterCalls).toBe(0);
  });

  it('refuses an object with an enormous length getter without calling it', () => {
    let lengthCalls = 0;
    const obj = {};
    Object.defineProperty(obj, 'length', {
      get() {
        lengthCalls += 1;
        return 1e15;
      },
      enumerable: true,
      configurable: true,
    });
    expect(() => pullRequestTierLabel(obj)).not.toThrow();
    expect(pullRequestTierLabel(obj)).toEqual(INVALID_TIER);
    expect(lengthCalls).toBe(0);
  });

  it('refuses a Proxy without invoking its get trap', () => {
    let getCalls = 0;
    const proxy = new Proxy({}, {
      get() {
        getCalls += 1;
        return 1;
      },
    });
    expect(() => pullRequestTierLabel(proxy)).not.toThrow();
    expect(pullRequestTierLabel(proxy)).toEqual(INVALID_TIER);
    expect(getCalls).toBe(0);
  });

  it('refuses a prototype-polluting object and leaves Object.prototype clean', () => {
    const polluted = JSON.parse(
      '{"__proto__": {"polluted": true}, "constructor": {"prototype": {"polluted": true}}}',
    );
    expect(() => pullRequestTierLabel(polluted)).not.toThrow();
    expect(pullRequestTierLabel(polluted)).toEqual(INVALID_TIER);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });
});

describe('isPullRequestTierLabel', () => {
  it('accepts only the two label strings of length 6', () => {
    expect(isPullRequestTierLabel('tier:1')).toBe(true);
    expect(isPullRequestTierLabel('tier:2')).toBe(true);

    expect(isPullRequestTierLabel('tier:0')).toBe(false);
    expect(isPullRequestTierLabel('tier:3')).toBe(false);
    expect(isPullRequestTierLabel('tier:1\n')).toBe(false);
    expect(isPullRequestTierLabel('TIER:1')).toBe(false);
    expect(isPullRequestTierLabel('x'.repeat(100000))).toBe(false);
    expect(isPullRequestTierLabel(1)).toBe(false);
    expect(isPullRequestTierLabel(null)).toBe(false);
    expect(isPullRequestTierLabel(new Proxy({}, { get() { return 'tier:1'; } }))).toBe(false);
  });
});
