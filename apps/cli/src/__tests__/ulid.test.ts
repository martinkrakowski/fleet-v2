// newUlid tests — K7-4.
/**
 * A ULID is 48-bit milliseconds then 80 random bits, Crockford base32, 26
 * characters, matching the O1b-1 `REQUEST_ID_PATTERN`. The clock and the
 * random source are injectable, so the pinned outputs below are exact.
 */

import { describe, expect, it } from 'vitest';

import { REQUEST_ID_PATTERN } from '@fleet/work-execution';

import { newUlid } from '../ulid.js';

const NOW_MS = 1_793_095_200_000; // 2026-10-27T10:00:00.000Z

/** A deterministic all-zero random source. */
function zeroRandom(): Uint8Array {
  return new Uint8Array(10);
}

describe('newUlid', () => {
  it('matches the O1b-1 REQUEST_ID_PATTERN', () => {
    expect(REQUEST_ID_PATTERN.test(newUlid())).toBe(true);
    for (let index = 0; index < 32; index += 1) {
      expect(REQUEST_ID_PATTERN.test(newUlid(NOW_MS + index))).toBe(true);
    }
  });

  it('pins the exact output for a fixed clock and a zero random source', () => {
    expect(newUlid(NOW_MS, zeroRandom)).toBe('01M5YCTV800000000000000000');
    expect(newUlid(NOW_MS + 1, zeroRandom)).toBe('01M5YCTV810000000000000000');
    expect(newUlid(NOW_MS, () => new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 1]))).toBe(
      '01M5YCTV800000000000000001',
    );
  });

  it('gives two calls different values', () => {
    expect(newUlid(NOW_MS)).not.toBe(newUlid(NOW_MS));
  });

  it('orders by time', () => {
    const earlier = newUlid(NOW_MS, zeroRandom);
    const later = newUlid(NOW_MS + 1, zeroRandom);
    expect(earlier < later).toBe(true);
  });

  it('throws a RangeError for a clock outside 0 .. 2^48 - 1 or not an integer', () => {
    expect(() => newUlid(-1)).toThrow(RangeError);
    expect(() => newUlid(2 ** 48)).toThrow(RangeError);
    expect(() => newUlid(1.5)).toThrow(RangeError);
    expect(() => newUlid(Number.NaN)).toThrow(RangeError);
  });
});
