/**
 * Domain unit tests for the coordinate, dense-array, held-age and secret
 * screening helpers of `held-work-order.ts`. Pure inputs only: every fixture
 * here is synthetic (`acme/fleet`, constructed dummy token shapes), never a
 * real host, address or credential.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  computeHeldAgeMinutes,
  containsAnySecretPattern,
  parseForgeRepositoryCoordinates,
  readDenseUnknownArray,
} from '../held-work-order.js';

describe('parseForgeRepositoryCoordinates', () => {
  it('parses bare, https, bare-host and ssh coordinates to the same owner and repo', () => {
    const expected = { owner: 'acme', repo: 'fleet' };
    expect(parseForgeRepositoryCoordinates('acme/fleet')).toEqual(expected);
    expect(parseForgeRepositoryCoordinates('https://github.com/acme/fleet')).toEqual(expected);
    expect(parseForgeRepositoryCoordinates('github.com/acme/fleet')).toEqual(expected);
    expect(parseForgeRepositoryCoordinates('git@github.com:acme/fleet.git')).toEqual(expected);
    // A different input must not silently map to the same coordinate, so an
    // identity/constant implementation cannot satisfy this test.
    expect(parseForgeRepositoryCoordinates('acme/other')).toEqual({ owner: 'acme', repo: 'other' });
  });

  it('strips one .git suffix only and keeps a repo whose name merely ends in git-like text', () => {
    expect(parseForgeRepositoryCoordinates('git@github.com:acme/fleet.git')).toEqual({ owner: 'acme', repo: 'fleet' });
    expect(parseForgeRepositoryCoordinates('acme/fleet.git')).toEqual({ owner: 'acme', repo: 'fleet' });
    expect(parseForgeRepositoryCoordinates('acme/fleet')).toEqual({ owner: 'acme', repo: 'fleet' });
    expect(parseForgeRepositoryCoordinates('acme/fleetgit')).toEqual({ owner: 'acme', repo: 'fleetgit' });
  });

  it('refuses empty and whitespace-only strings while still accepting a plain coordinate', () => {
    expect(parseForgeRepositoryCoordinates('acme/fleet')).toEqual({ owner: 'acme', repo: 'fleet' });
    expect(parseForgeRepositoryCoordinates('')).toBeNull();
    expect(parseForgeRepositoryCoordinates('   ')).toBeNull();
  });

  it('refuses whitespace or control characters inside coordinates while accepting a clean one', () => {
    expect(parseForgeRepositoryCoordinates('acme/fleet')).toEqual({ owner: 'acme', repo: 'fleet' });
    expect(parseForgeRepositoryCoordinates('acme/my repo')).toBeNull();
    // Interior control characters are refused; edge whitespace is trimmed (next test).
    expect(parseForgeRepositoryCoordinates('acme/re\npo')).toBeNull();
    expect(parseForgeRepositoryCoordinates('acme/repo\u0000')).toBeNull();
  });

  it('trims edge whitespace including newlines but still refuses the same text when interior', () => {
    expect(parseForgeRepositoryCoordinates('  acme/fleet  ')).toEqual({ owner: 'acme', repo: 'fleet' });
    expect(parseForgeRepositoryCoordinates('acme/fleet\n')).toEqual({ owner: 'acme', repo: 'fleet' });
    expect(parseForgeRepositoryCoordinates('\nacme/fleet')).toEqual({ owner: 'acme', repo: 'fleet' });
    expect(parseForgeRepositoryCoordinates('acme/fl\neet')).toBeNull();
  });

  it('refuses query and fragment characters while accepting the same coordinate unadorned', () => {
    expect(parseForgeRepositoryCoordinates('acme/fleet')).toEqual({ owner: 'acme', repo: 'fleet' });
    expect(parseForgeRepositoryCoordinates('acme/fleet?tab=1')).toBeNull();
    expect(parseForgeRepositoryCoordinates('acme/fleet#readme')).toBeNull();
  });

  it('refuses single-segment and three-segment inputs while accepting two segments', () => {
    expect(parseForgeRepositoryCoordinates('acme/fleet')).toEqual({ owner: 'acme', repo: 'fleet' });
    expect(parseForgeRepositoryCoordinates('acme')).toBeNull();
    expect(parseForgeRepositoryCoordinates('acme/fleet/extra')).toBeNull();
  });

  it('refuses dot and parent-directory segments while accepting a normal coordinate', () => {
    expect(parseForgeRepositoryCoordinates('acme/fleet')).toEqual({ owner: 'acme', repo: 'fleet' });
    expect(parseForgeRepositoryCoordinates('.')).toBeNull();
    expect(parseForgeRepositoryCoordinates('..')).toBeNull();
    expect(parseForgeRepositoryCoordinates('./fleet')).toBeNull();
    expect(parseForgeRepositoryCoordinates('acme/..')).toBeNull();
    expect(parseForgeRepositoryCoordinates('acme/.')).toBeNull();
  });

  it('refuses owner or repo segments exceeding 100 characters while accepting the 100-char boundary', () => {
    expect(parseForgeRepositoryCoordinates('a'.repeat(101) + '/fleet')).toBeNull();
    expect(parseForgeRepositoryCoordinates('acme/' + 'b'.repeat(101))).toBeNull();
    // Boundary: exactly 100 characters is accepted.
    expect(parseForgeRepositoryCoordinates('a'.repeat(100) + '/fleet')).toEqual({ owner: 'a'.repeat(100), repo: 'fleet' });
  });

  it('refuses strings exceeding 256 characters while accepting a string at the boundary', () => {
    expect(parseForgeRepositoryCoordinates('https://github.com/' + 'a'.repeat(240) + '/repo')).toBeNull();
    // The longest accepted coordinate is two 100-char segments: 201 characters.
    const longest = 'a'.repeat(100) + '/' + 'b'.repeat(100);
    expect(longest).toHaveLength(201);
    expect(parseForgeRepositoryCoordinates(longest)).toEqual({ owner: 'a'.repeat(100), repo: 'b'.repeat(100) });
  });

  it('refuses secret-shaped strings while accepting the same shape without the token prefix', () => {
    expect(parseForgeRepositoryCoordinates('acme/fleet')).toEqual({ owner: 'acme', repo: 'fleet' });
    expect(parseForgeRepositoryCoordinates('acme/' + 'ghp_' + 'a'.repeat(20))).toBeNull();
  });

  it('refuses non-string inputs while accepting a string coordinate', () => {
    expect(parseForgeRepositoryCoordinates('acme/fleet')).toEqual({ owner: 'acme', repo: 'fleet' });
    expect(parseForgeRepositoryCoordinates(null as unknown as string)).toBeNull();
    expect(parseForgeRepositoryCoordinates(undefined as unknown as string)).toBeNull();
    expect(parseForgeRepositoryCoordinates(123 as unknown as string)).toBeNull();
    expect(parseForgeRepositoryCoordinates({} as unknown as string)).toBeNull();
  });
});

describe('readDenseUnknownArray', () => {
  it('returns the elements of a dense array within max and an empty array when max is 0', () => {
    expect(readDenseUnknownArray(['a', 'b'], 2)).toEqual(['a', 'b']);
    expect(readDenseUnknownArray([], 0)).toEqual([]);
  });

  it('refuses null, undefined, primitives, plain objects, and array-like objects', () => {
    expect(readDenseUnknownArray(['a'], 1)).toEqual(['a']);
    expect(readDenseUnknownArray(null, 5)).toBeNull();
    expect(readDenseUnknownArray(undefined, 5)).toBeNull();
    expect(readDenseUnknownArray(42, 5)).toBeNull();
    expect(readDenseUnknownArray('abc', 5)).toBeNull();
    expect(readDenseUnknownArray({ 0: 'a', length: 1 }, 5)).toBeNull();
    expect(readDenseUnknownArray(Object.create(Array.prototype), 5)).toBeNull();
  });

  it('refuses arrays longer than max including non-empty arrays when max is 0', () => {
    expect(readDenseUnknownArray([1, 2], 2)).toEqual([1, 2]);
    expect(readDenseUnknownArray([1, 2, 3], 2)).toBeNull();
    expect(readDenseUnknownArray([1], 0)).toBeNull();
  });

  it('refuses sparse arrays with holes and new Array(n) while accepting a dense array', () => {
    expect(readDenseUnknownArray([1, 2, 3], 3)).toEqual([1, 2, 3]);
    // eslint-disable-next-line no-sparse-arrays
    expect(readDenseUnknownArray([1, , 3], 5)).toBeNull();
    expect(readDenseUnknownArray(new Array(3), 5)).toBeNull();
  });

  it('refuses an array with an index getter without invoking the getter', () => {
    const spy = vi.fn(() => 'x');
    const hostile: unknown[] = [];
    Object.defineProperty(hostile, 'length', { value: 1 });
    Object.defineProperty(hostile, 0, { get: spy });
    expect(readDenseUnknownArray(hostile, 5)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    // The same shape without the getter reads normally, proving the getter is
    // what the refusal keys on rather than the length.
    expect(readDenseUnknownArray(['x'], 5)).toEqual(['x']);
  });

  it('refuses an array whose length exceeds max without iterating', () => {
    const enormous: unknown[] = [];
    Object.defineProperty(enormous, 'length', { value: 1e9 });
    // An element getter is the witness: an implementation that iterated would run it.
    const spy = vi.fn(() => 'x');
    Object.defineProperty(enormous, 0, { get: spy });
    expect(readDenseUnknownArray(enormous, 5)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    expect(readDenseUnknownArray(['a'], 5)).toEqual(['a']);
  });
});

describe('computeHeldAgeMinutes', () => {
  it('returns floored whole minutes and clamps negative elapsed time to zero', () => {
    const heldMs = Date.parse('2026-11-07T10:00:00.000Z');
    // Exactly one minute.
    expect(computeHeldAgeMinutes('2026-11-07T10:00:00.000Z', heldMs + 60_000)).toBe(1);
    // Sub-minute elapsed time floors down to zero.
    expect(computeHeldAgeMinutes('2026-11-07T10:00:00.000Z', heldMs + 90_000)).toBe(1);
    expect(computeHeldAgeMinutes('2026-11-07T10:00:00.000Z', heldMs + 59_999)).toBe(0);
    // A clock behind the held timestamp clamps to zero instead of going negative.
    expect(computeHeldAgeMinutes('2026-11-07T10:00:00.000Z', heldMs - 1)).toBe(0);
    // Two whole minutes plus change.
    expect(computeHeldAgeMinutes('2026-11-07T10:00:00.000Z', heldMs + 2 * 60_000 + 1)).toBe(2);
  });

  it('returns null for non-canonical ISO timestamps', () => {
    const heldMs = Date.parse('2026-11-07T10:00:00.000Z');
    expect(computeHeldAgeMinutes('2026-11-07T10:00:00.000Z', heldMs + 60_000)).toBe(1);
    expect(computeHeldAgeMinutes('2026-11-07', 0)).toBeNull();
    expect(computeHeldAgeMinutes('2026-11-07T10:00:00Z', 0)).toBeNull();
    expect(computeHeldAgeMinutes('2026-02-30T10:00:00.000Z', 0)).toBeNull();
    expect(computeHeldAgeMinutes('', 0)).toBeNull();
    expect(computeHeldAgeMinutes(null as unknown as string, 0)).toBeNull();
  });

  it('returns null for non-finite nowMs', () => {
    const heldMs = Date.parse('2026-11-07T10:00:00.000Z');
    expect(computeHeldAgeMinutes('2026-11-07T10:00:00.000Z', heldMs + 60_000)).toBe(1);
    expect(computeHeldAgeMinutes('2026-11-07T10:00:00.000Z', Number.NaN)).toBeNull();
    expect(computeHeldAgeMinutes('2026-11-07T10:00:00.000Z', Number.POSITIVE_INFINITY)).toBeNull();
    expect(computeHeldAgeMinutes('2026-11-07T10:00:00.000Z', Number.NEGATIVE_INFINITY)).toBeNull();
  });
});

describe('containsAnySecretPattern', () => {
  it('flags legacy and lane-diff secret shapes and passes a plain path', () => {
    expect(containsAnySecretPattern('ghp_' + 'a'.repeat(20))).toBe(true);
    expect(containsAnySecretPattern('AIza' + '0'.repeat(30))).toBe(true);
    expect(containsAnySecretPattern('packages/work-execution/src/domain/held-work-order.ts')).toBe(false);
    expect(containsAnySecretPattern('plain value')).toBe(false);
  });

  it('resets shared regex lastIndex across repeated calls', () => {
    const secret = 'ghp_' + 'a'.repeat(20);
    expect(containsAnySecretPattern(secret)).toBe(true);
    expect(containsAnySecretPattern(secret)).toBe(true);
    // A fresh input after a match must still be scanned from the start, not
    // from a stale lastIndex left behind by the shared regexes.
    expect(containsAnySecretPattern('sk-' + 'a'.repeat(25))).toBe(true);
    expect(containsAnySecretPattern('plain value')).toBe(false);
  });
});
