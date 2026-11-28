/**
 * FC17E tests for `decideDriverLease`: boundary behaviour and hostile-input
 * refusals. Every refusal is the typed reason and no rejected value is ever
 * echoed. Fixtures are local and frozen; no network, no clock, no randomness,
 * no credential-shaped literals (the secret-shape string is assembled at
 * runtime from inert pieces). The `isProxy` detector is mandatory in the
 * domain unit, so every call here passes `types.isProxy` from `node:util`
 * unless a specific test exercises an untrusted or absent detector.
 */

import { describe, expect, it } from 'vitest';
import { types } from 'util';

import {
  DEFAULT_DRIVER_LEASE_TTL_MS,
  MAX_COMPETING_CANDIDATES,
  decideDriverLease,
} from '../driver-lease.js';
import { LANE_RUN_LEASE_MAX_MS } from '../lane-run-lease.js';
import type { LaneRunLeaseRecord } from '../lane-run-records.js';

/** Every boundary call passes the trusted `node:util` detector (mandatory). */
function decide(input: unknown, isProxy?: unknown): unknown {
  return decideDriverLease(
    input,
    (isProxy ?? types.isProxy) as (value: unknown) => boolean,
  );
}

function proxied(value: object): unknown {
  return new Proxy(value, {});
}

const NOW = '2026-11-27T12:00:00.000Z';
const UNTIL = '2026-11-27T12:01:00.000Z';
const BEFORE_EXPIRY = '2026-11-27T12:00:59.999Z';

function leaseWith(fence: number, until: string, holderId = 'driver-a'): LaneRunLeaseRecord {
  return Object.freeze({ holderId, fence, leaseUntilIso: until });
}

function acquireInput(
  candidateId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { candidateId, nowIso: NOW, lease: null, ...overrides };
}

/** A secret-shaped string built at runtime from inert pieces (never a literal). */
function secretShapedId(): string {
  return ['sk', '-', 'a'.repeat(24)].join('') + ['-', 'b'.repeat(20)].join('');
}

/** A Proxy whose `ownKeys` trap throws (recording that it was reached). */
function throwingOwnKeysProxy(length: number): unknown {
  return new Proxy([1, 2, 3], {
    getOwnPropertyDescriptor(t, prop) {
      const descriptor = Reflect.getOwnPropertyDescriptor(t, prop);
      if (prop === 'length' && descriptor !== undefined) {
        return { ...descriptor, value: length };
      }
      return descriptor;
    },
    ownKeys() {
      throw new Error('ownKeys must never be reached past the O(1) pre-gate');
    },
  });
}

describe('decideDriverLease', () => {
  it('acquires from a null lease with fence 1, the default ttl, and a frozen lease record', () => {
    const result = decide(acquireInput('driver-a'));
    expect(result).toEqual({
      outcome: 'acquired',
      lease: { holderId: 'driver-a', fence: 1, leaseUntilIso: UNTIL },
    });
    expect(Object.isFrozen((result as { lease: unknown }).lease)).toBe(true);
    expect(DEFAULT_DRIVER_LEASE_TTL_MS).toBe(60_000);
  });

  it('refuses a takeover before expiry (nowIso 1ms before leaseUntilIso) with lease-held', () => {
    const input = acquireInput('driver-b', { nowIso: BEFORE_EXPIRY, lease: leaseWith(3, UNTIL) });
    expect(decide(input)).toEqual({ outcome: 'refused', reason: 'lease-held' });
  });

  it('acquires a takeover at the exact expiry instant and after expiry, incrementing the fence by 1', () => {
    const atExpiry = acquireInput('driver-b', { nowIso: UNTIL, lease: leaseWith(3, UNTIL) });
    expect(decide(atExpiry)).toEqual({
      outcome: 'acquired',
      lease: { holderId: 'driver-b', fence: 4, leaseUntilIso: '2026-11-27T12:02:00.000Z' },
    });
    const afterExpiry = acquireInput('driver-b', {
      nowIso: '2026-11-27T12:03:00.000Z',
      lease: leaseWith(3, UNTIL),
    });
    expect(decide(afterExpiry)).toEqual({
      outcome: 'acquired',
      lease: { holderId: 'driver-b', fence: 4, leaseUntilIso: '2026-11-27T12:04:00.000Z' },
    });
  });

  it('renews for the holder before expiry, keeping the fence and advancing leaseUntilIso', () => {
    const input = acquireInput('driver-a', { nowIso: BEFORE_EXPIRY, lease: leaseWith(3, UNTIL) });
    expect(decide(input)).toEqual({
      outcome: 'renewed',
      lease: { holderId: 'driver-a', fence: 3, leaseUntilIso: '2026-11-27T12:01:59.999Z' },
    });
  });

  it('lets the holder reacquire at the exact expiry instant, incrementing the fence by 1', () => {
    const input = acquireInput('driver-a', { nowIso: UNTIL, lease: leaseWith(3, UNTIL) });
    expect(decide(input)).toEqual({
      outcome: 'acquired',
      lease: { holderId: 'driver-a', fence: 4, leaseUntilIso: '2026-11-27T12:02:00.000Z' },
    });
  });

  it('resolves two contending candidates deterministically by code-unit id order regardless of array order', () => {
    const forA = acquireInput('driver-a', {
      nowIso: UNTIL,
      lease: leaseWith(1, UNTIL),
      competingCandidateIds: ['driver-b'],
    });
    expect(decide(forA)).toEqual({
      outcome: 'acquired',
      lease: { holderId: 'driver-a', fence: 2, leaseUntilIso: '2026-11-27T12:02:00.000Z' },
    });
    const forB = acquireInput('driver-b', {
      nowIso: UNTIL,
      lease: leaseWith(1, UNTIL),
      competingCandidateIds: ['driver-a'],
    });
    expect(decide(forB)).toEqual({ outcome: 'refused', reason: 'lost-tiebreak' });
  });

  it('does not mutate deep-frozen inputs', () => {
    const input = Object.freeze({
      candidateId: 'driver-b',
      nowIso: UNTIL,
      lease: Object.freeze({ holderId: 'driver-a', fence: 1, leaseUntilIso: UNTIL }),
      competingCandidateIds: Object.freeze(['driver-a']),
    });
    const before = JSON.stringify(input);
    decide(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('honours a valid leaseDurationMs for the next leaseUntilIso and accepts the full max duration', () => {
    const input = acquireInput('driver-a', { leaseDurationMs: 120_000 });
    expect(decide(input)).toEqual({
      outcome: 'acquired',
      lease: { holderId: 'driver-a', fence: 1, leaseUntilIso: '2026-11-27T12:02:00.000Z' },
    });
    const maxInput = acquireInput('driver-a', { leaseDurationMs: LANE_RUN_LEASE_MAX_MS });
    expect(decide(maxInput)).toEqual({
      outcome: 'acquired',
      lease: { holderId: 'driver-a', fence: 1, leaseUntilIso: '2026-11-27T12:10:00.000Z' },
    });
  });

  it('refuses null, undefined, primitives, non-plain input, prototype-polluting keys, and an unknown-key getter without invoking it as invalid-input', () => {
    const expected = { outcome: 'refused', reason: 'invalid-input' };
    expect(decide(null)).toEqual(expected);
    expect(decide(undefined)).toEqual(expected);
    expect(decide(42)).toEqual(expected);
    expect(decide('driver-a')).toEqual(expected);
    expect(decide(['driver-a'])).toEqual(expected);
    expect(
      decide(Object.assign(Object.create({ inherited: true }), { candidateId: 'driver-a' })),
    ).toEqual(expected);
    // A computed '__proto__' key (no JSON.parse in domain/ tests).
    const hostile: Record<string, unknown> = {
      ['__proto__']: {},
      candidateId: 'driver-a',
      nowIso: NOW,
      lease: null,
    };
    expect(decide(hostile)).toEqual(expected);
    // An enumerable getter on an unknown input key is refused without invoking it.
    let getterRan = false;
    const withGetter: Record<string, unknown> = acquireInput('driver-a');
    Object.defineProperty(withGetter, 'evil', {
      enumerable: true,
      get() {
        getterRan = true;
        return 1;
      },
    });
    expect(decide(withGetter)).toEqual(expected);
    expect(getterRan).toBe(false);
  });

  it('refuses a Proxy input via the injected isProxy detector before any property reflection', () => {
    const expected = { outcome: 'refused', reason: 'invalid-input' };
    expect(decide(new Proxy(acquireInput('driver-a'), {}))).toEqual(expected);
    const { proxy, revoke } = Proxy.revocable(acquireInput('driver-a'), {});
    revoke();
    expect(() => decide(proxy)).not.toThrow();
    expect(decide(proxy)).toEqual(expected);
    const throwing = new Proxy(acquireInput('driver-a'), {
      ownKeys() {
        throw new Error('ownKeys must never be reached');
      },
    });
    expect(() => decide(throwing)).not.toThrow();
    expect(decide(throwing)).toEqual(expected);
  });

  it('refuses an absent or throwing detector with invalid-input before any input reflection', () => {
    const expected = { outcome: 'refused', reason: 'invalid-input' };
    let trapRan = false;
    const plain = acquireInput('driver-a');
    const trapped = new Proxy(plain, {
      ownKeys() {
        trapRan = true;
        return Reflect.ownKeys(plain);
      },
    });
    // No detector at all: the previous default was `() => false`, which let
    // the Proxy's reflection traps run and accept trap-supplied data. There
    // is no default any more, so the call is refused before reflection.
    expect(decideDriverLease(trapped, undefined as never)).toEqual(expected);
    // A throwing detector is untrusted and refused without running traps.
    const throwingDetector = () => {
      throw new Error('detector must not throw');
    };
    expect(decideDriverLease(plain, throwingDetector)).toEqual(expected);
    expect(trapRan).toBe(false);
    // The trusted detector still decides a plain input normally.
    expect(decide(plain)).toEqual({
      outcome: 'acquired',
      lease: { holderId: 'driver-a', fence: 1, leaseUntilIso: UNTIL },
    });
  });

  it('refuses missing, empty, untrimmed, overlong, non-string, getter-bearing, and secret-shaped candidateId with invalid-candidate-id', () => {
    const expected = { outcome: 'refused', reason: 'invalid-candidate-id' };
    const missing = { nowIso: NOW, lease: null };
    expect(decide(missing)).toEqual(expected);
    for (const bad of [null, undefined, 42, '', '   ', ' driver-a ', 'driver-a ', '\tdriver-a']) {
      expect(decide(acquireInput(bad as string))).toEqual(expected);
    }
    expect(decide(acquireInput('d'.repeat(257)))).toEqual(expected);
    expect(decide(acquireInput(secretShapedId()))).toEqual(expected);
    let getterRan = false;
    const withGetter = acquireInput('x');
    Object.defineProperty(withGetter, 'candidateId', {
      enumerable: true,
      get() {
        getterRan = true;
        return 'driver-a';
      },
    });
    expect(decide(withGetter)).toEqual(expected);
    expect(getterRan).toBe(false);
  });

  it('refuses missing, malformed, unzoned, getter-bearing, and calendar-rollover nowIso values with invalid-now-iso', () => {
    const expected = { outcome: 'refused', reason: 'invalid-now-iso' };
    expect(decide({ candidateId: 'driver-a', lease: null })).toEqual(expected);
    for (const bad of [null, undefined, 42, '', '2026-11-27T12:00:00', '2026-11-31T12:00:00Z']) {
      expect(decide(acquireInput('driver-a', { nowIso: bad }))).toEqual(expected);
    }
    let getterRan = false;
    const withGetter = acquireInput('driver-a');
    Object.defineProperty(withGetter, 'nowIso', {
      enumerable: true,
      get() {
        getterRan = true;
        return NOW;
      },
    });
    expect(decide(withGetter)).toEqual(expected);
    expect(getterRan).toBe(false);
  });

  it('refuses missing, malformed, getter-bearing, proxied, non-v1, and fence-overflow lease records with invalid-lease', () => {
    const expected = { outcome: 'refused', reason: 'invalid-lease' };
    expect(decide({ candidateId: 'driver-a', nowIso: NOW })).toEqual(expected);
    for (const badLease of [
      undefined,
      42,
      'lease',
      ['holder'],
      {},
      { holderId: 'driver-a', fence: 0, leaseUntilIso: UNTIL },
      { holderId: 'driver-a', fence: 1.5, leaseUntilIso: UNTIL },
      { holderId: '', fence: 1, leaseUntilIso: UNTIL },
      { holderId: 'driver-a', fence: 1, leaseUntilIso: '2026-11-27T12:00:00' },
      { holderId: 'driver-a', fence: 1, leaseUntilIso: UNTIL, version: 2 },
      { holderId: 'driver-a', fence: 1, leaseUntilIso: UNTIL, evil: 1 },
    ]) {
      expect(decide(acquireInput('driver-b', { lease: badLease }))).toEqual(expected);
    }
    // Fence overflow: the record itself is valid but the next fence is not a safe integer.
    const atCeiling = {
      holderId: 'driver-a',
      fence: Number.MAX_SAFE_INTEGER,
      leaseUntilIso: UNTIL,
      version: 1,
    };
    expect(
      decide(acquireInput('driver-b', { nowIso: UNTIL, lease: atCeiling })),
    ).toEqual(expected);
    let getterRan = false;
    const withGetter = acquireInput('driver-a');
    Object.defineProperty(withGetter, 'lease', {
      enumerable: true,
      get() {
        getterRan = true;
        return leaseWith(1, UNTIL);
      },
    });
    expect(decide(withGetter)).toEqual(expected);
    expect(getterRan).toBe(false);
    expect(
      decide(acquireInput('driver-b', { lease: proxied(leaseWith(1, UNTIL)) })),
    ).toEqual({ outcome: 'refused', reason: 'invalid-lease' });
  });

  it('refuses non-array, array-like, sparse, getter-bearing, proxied, and invalid-element competingCandidateIds with invalid-competing-candidates', () => {
    const expected = { outcome: 'refused', reason: 'invalid-competing-candidates' };
    for (const bad of [null, undefined, 42, 'driver-a', { length: 1, 0: 'a' }, [''], ['  '], [42], ['driver-a', 7]]) {
      expect(decide(acquireInput('driver-b', { competingCandidateIds: bad }))).toEqual(expected);
    }
    const sparse = new Array(3);
    sparse[1] = 'driver-a';
    expect(decide(acquireInput('driver-b', { competingCandidateIds: sparse }))).toEqual(expected);
    let getterRan = false;
    const withGetter = acquireInput('driver-b');
    Object.defineProperty(withGetter, 'competingCandidateIds', {
      enumerable: true,
      get() {
        getterRan = true;
        return ['driver-a'];
      },
    });
    expect(decide(withGetter)).toEqual(expected);
    expect(getterRan).toBe(false);
    expect(
      decide(
        acquireInput('driver-b', { competingCandidateIds: proxied(['driver-a']) }),
        types.isProxy,
      ),
    ).toEqual(expected);
  });

  it('refuses competingCandidateIds exceeding 64 entries in O(1) before ownKeys', () => {
    const tooMany = { outcome: 'refused', reason: 'too-many-competing-candidates' };
    const long = Array.from({ length: MAX_COMPETING_CANDIDATES + 1 }, (_, i) => 'driver-' + i);
    expect(decide(acquireInput('driver-a', { competingCandidateIds: long }))).toEqual(tooMany);
    // A lying length >= 2**32 - 1 never reaches ownKeys: the trusted detector
    // refuses the Proxy first (the fixture's ownKeys trap throws when reached).
    const lying = throwingOwnKeysProxy(2 ** 32 - 1);
    expect(() => decide(acquireInput('driver-a', { competingCandidateIds: lying }))).not.toThrow();
    expect(decide(acquireInput('driver-a', { competingCandidateIds: lying }))).toEqual({
      outcome: 'refused',
      reason: 'invalid-competing-candidates',
    });
  });

  it('refuses non-positive, non-integer, getter-bearing, and over-limit leaseDurationMs with invalid-lease-duration', () => {
    const expected = { outcome: 'refused', reason: 'invalid-lease-duration' };
    for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '60000', null, LANE_RUN_LEASE_MAX_MS + 1]) {
      expect(decide(acquireInput('driver-a', { leaseDurationMs: bad }))).toEqual(expected);
    }
    let getterRan = false;
    const withGetter = acquireInput('driver-a');
    Object.defineProperty(withGetter, 'leaseDurationMs', {
      enumerable: true,
      get() {
        getterRan = true;
        return 60_000;
      },
    });
    expect(decide(withGetter)).toEqual(expected);
    expect(getterRan).toBe(false);
  });
});
