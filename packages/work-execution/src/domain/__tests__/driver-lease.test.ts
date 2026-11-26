/**
 * FC17E hostile-input and behaviour tests for the pure driver standby lease
 * takeover decider: every refusal is the typed reason, nothing ever throws,
 * and no rejected value is ever echoed.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_DRIVER_LEASE_TTL_MS, decideDriverLease } from '../driver-lease.js';

/** A revoked Proxy throws on every trap, including [[GetPrototypeOf]]. */
function revokedProxy(): unknown {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

/** A getter-bearing record whose getters record any invocation. */
function getterOn(key: string, value: unknown, target: Record<string, unknown>): unknown {
  const probe: Record<string, unknown> = { ...target, [key]: value };
  return new Proxy(probe, {
    getOwnPropertyDescriptor(t, prop) {
      const descriptor = Reflect.getOwnPropertyDescriptor(t, prop);
      if (prop === key && descriptor !== undefined) {
        return { ...descriptor, get: () => (invokedGetters.push(key), descriptor.value) };
      }
      return descriptor;
    },
  });
}
const invokedGetters: string[] = [];

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function baseRequest(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    candidateId: 'driver-b',
    nowIso: '2026-01-01T00:00:00.000Z',
    lease: null,
    ...overrides,
  };
}

function liveLease(holderId: string, fence: number, leaseUntilIso: string): Record<string, unknown> {
  return { holderId, fence, leaseUntilIso, version: 1 };
}

describe('decideDriverLease', () => {
  it('acquires from a null lease with fence 1 and a frozen lease record using the default ttl', () => {
    const decision = decideDriverLease(
      baseRequest({ lease: null }),
    );
    expect(decision).toEqual({
      outcome: 'acquired',
      lease: {
        holderId: 'driver-b',
        fence: 1,
        leaseUntilIso: '2026-01-01T00:01:00.000Z',
      },
    });
    expect(DEFAULT_DRIVER_LEASE_TTL_MS).toBe(60_000);
    expect(Object.isFrozen((decision as { lease: unknown }).lease)).toBe(true);
  });

  it('refuses a takeover before expiry (1ms before leaseUntilIso) with lease-held', () => {
    const decision = decideDriverLease(
      baseRequest({
        lease: liveLease('driver-a', 3, '2026-01-01T00:01:00.000Z'),
      }),
    );
    expect(decision).toEqual({ outcome: 'refused', reason: 'lease-held' });
  });

  it('acquires a takeover at the exact expiry instant and after it, incrementing fence by 1', () => {
    const atExpiry = decideDriverLease(
      baseRequest({
        nowIso: '2026-01-01T01:00:00.000Z',
        lease: liveLease('driver-a', 3, '2026-01-01T01:00:00.000Z'),
      }),
    );
    expect(atExpiry).toEqual({
      outcome: 'acquired',
      lease: { holderId: 'driver-b', fence: 4, leaseUntilIso: '2026-01-01T01:01:00.000Z' },
    });
    const afterExpiry = decideDriverLease(
      baseRequest({
        nowIso: '2026-01-01T02:00:00.000Z',
        lease: liveLease('driver-a', 7, '2026-01-01T01:00:00.000Z'),
      }),
    );
    expect(afterExpiry).toEqual({
      outcome: 'acquired',
      lease: { holderId: 'driver-b', fence: 8, leaseUntilIso: '2026-01-01T02:01:00.000Z' },
    });
  });

  it('renews for the holder before expiry (1ms before leaseUntilIso), keeping the fence and advancing leaseUntilIso', () => {
    const decision = decideDriverLease(
      baseRequest({
        candidateId: 'driver-a',
        nowIso: '2026-01-01T00:00:59.999Z',
        lease: liveLease('driver-a', 3, '2026-01-01T00:01:00.000Z'),
      }),
    );
    expect(decision).toEqual({
      outcome: 'renewed',
      lease: {
        holderId: 'driver-a',
        fence: 3,
        leaseUntilIso: '2026-01-01T00:01:59.999Z',
      },
    });
  });

  it('reacquires as the holder at or after expiry (nowIso === leaseUntilIso), incrementing fence by 1', () => {
    const decision = decideDriverLease(
      baseRequest({
        candidateId: 'driver-a',
        nowIso: '2026-01-01T01:00:00.000Z',
        lease: liveLease('driver-a', 3, '2026-01-01T01:00:00.000Z'),
      }),
    );
    expect(decision).toEqual({
      outcome: 'acquired',
      lease: { holderId: 'driver-a', fence: 4, leaseUntilIso: '2026-01-01T01:01:00.000Z' },
    });
  });

  it('resolves two contending candidates deterministically by code-unit lexicographic id regardless of array order', () => {
    const request = baseRequest({
      nowIso: '2026-01-01T01:00:00.000Z',
      lease: liveLease('driver-a', 3, '2026-01-01T01:00:00.000Z'),
    });
    expect(decideDriverLease({ ...request, candidateId: 'driver-a', competingCandidateIds: ['driver-b'] })).toEqual({
      outcome: 'acquired',
      lease: { holderId: 'driver-a', fence: 4, leaseUntilIso: '2026-01-01T01:01:00.000Z' },
    });
    expect(decideDriverLease({ ...request, candidateId: 'driver-b', competingCandidateIds: ['driver-a'] })).toEqual({
      outcome: 'refused',
      reason: 'lost-tiebreak',
    });
  });

  it('does not mutate deep-frozen inputs', () => {
    const request = deepFreeze(
      baseRequest({ lease: liveLease('driver-a', 1, '2020-01-01T00:00:00.000Z') }),
    );
    const before = JSON.stringify(request);
    decideDriverLease(request);
    expect(JSON.stringify(request)).toBe(before);
  });

  it('refuses null, undefined, primitives, non-plain input, prototype-polluting keys, and an unknown-key getter without invoking it as invalid-input', () => {
    for (const input of [
      null,
      undefined,
      42,
      'driver-b',
      true,
      ['driver-b'],
      new Date(0),
      JSON.parse('{"__proto__":1}'),
      { ...baseRequest({}), extra: 1 },
    ]) {
      expect(decideDriverLease(input)).toEqual({ outcome: 'refused', reason: 'invalid-input' });
    }
    const getterInput = getterOn('unknownKey', 1, { ...baseRequest({}), unknownKey: 1 });
    expect(decideDriverLease(getterInput)).toEqual({ outcome: 'refused', reason: 'invalid-input' });
    expect(invokedGetters).toEqual([]);
  });

  it('refuses a Proxy input via the injected isProxy detector before any property reflection', () => {
    let reflected = false;
    const proxied = new Proxy(baseRequest({}), {
      ownKeys() {
        reflected = true;
        throw new Error('ownKeys must never be reached');
      },
    });
    const detectorInvocations: number[] = [];
    const decision = decideDriverLease(proxied, (value) => {
      detectorInvocations.push(1);
      return value === proxied;
    });
    expect(decision).toEqual({ outcome: 'refused', reason: 'invalid-input' });
    expect(reflected).toBe(false);
    expect(detectorInvocations.length).toBeGreaterThan(0);
    // A throwing or revoked-Proxy-shaped input via the default detector path.
    expect(decideDriverLease(revokedProxy())).toEqual({ outcome: 'refused', reason: 'invalid-input' });
  });

  it('refuses missing, empty, untrimmed, overlong, non-string, getter-bearing, and secret-shaped candidateId with invalid-candidate-id', () => {
    const secretShaped = ['sk', '-', 'a'.repeat(24)].join('');
    for (const candidateId of [
      undefined,
      null,
      42,
      '',
      '   ',
      ' driver-b',
      'x'.repeat(257),
      secretShaped,
    ]) {
      expect(decideDriverLease(baseRequest({ candidateId }))).toEqual({
        outcome: 'refused',
        reason: 'invalid-candidate-id',
      });
    }
    expect(decideDriverLease({ nowIso: '2026-01-01T00:00:00.000Z', lease: null })).toEqual({
      outcome: 'refused',
      reason: 'invalid-candidate-id',
    });
    const getterInput = getterOn('candidateId', 'driver-b', baseRequest({}));
    expect(decideDriverLease(getterInput)).toEqual({
      outcome: 'refused',
      reason: 'invalid-candidate-id',
    });
    expect(invokedGetters).toEqual([]);
  });

  it('refuses missing, malformed, unzoned, getter-bearing, and calendar-rollover nowIso values with invalid-now-iso', () => {
    for (const nowIso of [
      undefined,
      null,
      42,
      '',
      '2026-01-01T00:00:00',
      '2026-01-01T00:00:00Z ',
      '2026-02-31T00:00:00.000Z',
    ]) {
      expect(decideDriverLease(baseRequest({ nowIso }))).toEqual({
        outcome: 'refused',
        reason: 'invalid-now-iso',
      });
    }
    expect(decideDriverLease({ candidateId: 'driver-b', lease: null })).toEqual({
      outcome: 'refused',
      reason: 'invalid-now-iso',
    });
    const getterInput = getterOn('nowIso', '2026-01-01T00:00:00.000Z', baseRequest({}));
    expect(decideDriverLease(getterInput)).toEqual({
      outcome: 'refused',
      reason: 'invalid-now-iso',
    });
    expect(invokedGetters).toEqual([]);
  });

  it('refuses missing, malformed, getter-bearing, proxied, non-v1, and fence-overflow lease records with invalid-lease', () => {
    const atExpiry = '2026-01-01T01:00:00.000Z';
    for (const lease of [
      undefined,
      42,
      'lease',
      ['lease'],
      liveLease('driver-a', 0, atExpiry),
      liveLease('driver-a', 1.5, atExpiry),
      liveLease('driver-a', Number.MAX_SAFE_INTEGER, atExpiry),
      { ...liveLease('driver-a', 1, atExpiry), version: 2 },
      { ...liveLease('driver-a', 1, atExpiry), version: 1, __proto__: null, extra: 1 },
      { holderId: '', fence: 1, leaseUntilIso: atExpiry, version: 1 },
      { holderId: 'driver-a', fence: 1, leaseUntilIso: '2026-01-01T00:00:00', version: 1 },
      revokedProxy(),
    ]) {
      expect(
        decideDriverLease(baseRequest({ nowIso: atExpiry, lease })),
      ).toEqual({ outcome: 'refused', reason: 'invalid-lease' });
    }
    expect(decideDriverLease({ candidateId: 'driver-b', nowIso: atExpiry })).toEqual({
      outcome: 'refused',
      reason: 'invalid-lease',
    });
    const getterInput = getterOn('lease', liveLease('driver-a', 1, atExpiry), baseRequest({ nowIso: atExpiry }));
    expect(decideDriverLease(getterInput)).toEqual({ outcome: 'refused', reason: 'invalid-lease' });
    expect(invokedGetters).toEqual([]);
  });

  it('refuses non-array, array-like, sparse, getter-bearing, proxied, and invalid-element competingCandidateIds with invalid-competing-candidates', () => {
    const sparse: unknown = new Array(2);
    for (const competingCandidateIds of [
      null,
      undefined,
      42,
      'driver-a',
      { length: 1, 0: 'driver-a' },
      sparse,
      revokedProxy(),
      ['driver-a', 42],
      ['driver-a', ''],
      ['driver-a', ' '],
      ['driver-a', 'x'.repeat(257)],
      ['driver-a', ['driver-b']],
    ]) {
      expect(decideDriverLease(baseRequest({ competingCandidateIds }))).toEqual({
        outcome: 'refused',
        reason: 'invalid-competing-candidates',
      });
    }
    const getterInput = getterOn('competingCandidateIds', ['driver-a'], baseRequest({}));
    expect(decideDriverLease(getterInput)).toEqual({
      outcome: 'refused',
      reason: 'invalid-competing-candidates',
    });
    expect(invokedGetters).toEqual([]);
  });

  it('refuses competingCandidateIds exceeding 64 entries in O(1) before ownKeys', () => {
    let ownKeysReached = false;
    const proxied = new Proxy([['driver-a']], {
      getOwnPropertyDescriptor(t, prop) {
        const descriptor = Reflect.getOwnPropertyDescriptor(t, prop);
        if (prop === 'length' && descriptor !== undefined) {
          return { ...descriptor, value: 2 ** 32 - 1 };
        }
        return descriptor;
      },
      ownKeys() {
        ownKeysReached = true;
        throw new Error('ownKeys must never be reached past the O(1) pre-gate');
      },
    });
    expect(decideDriverLease(baseRequest({ competingCandidateIds: proxied }))).toEqual({
      outcome: 'refused',
      reason: 'too-many-competing-candidates',
    });
    expect(ownKeysReached).toBe(false);
    const tooLong = new Array(65).fill('driver-a');
    expect(decideDriverLease(baseRequest({ competingCandidateIds: tooLong }))).toEqual({
      outcome: 'refused',
      reason: 'too-many-competing-candidates',
    });
  });

  it('refuses non-positive, non-integer, getter-bearing, and over-limit leaseDurationMs with invalid-lease-duration', () => {
    for (const leaseDurationMs of [
      undefined,
      null,
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      '60000',
      10 * 60 * 1000 + 1,
    ]) {
      expect(decideDriverLease(baseRequest({ leaseDurationMs }))).toEqual({
        outcome: 'refused',
        reason: 'invalid-lease-duration',
      });
    }
    const getterInput = getterOn('leaseDurationMs', 60_000, baseRequest({}));
    expect(decideDriverLease(getterInput)).toEqual({
      outcome: 'refused',
      reason: 'invalid-lease-duration',
    });
    expect(invokedGetters).toEqual([]);
  });

  it('refuses a second driver while the lease is live 1ms before expiry with lease-held', () => {
    const decision = decideDriverLease(
      baseRequest({
        nowIso: '2026-01-01T00:00:59.999Z',
        lease: liveLease('driver-a', 1, '2026-01-01T00:01:00.000Z'),
      }),
    );
    expect(decision).toEqual({ outcome: 'refused', reason: 'lease-held' });
  });

  it('refuses the lexicographically larger candidate with lost-tiebreak when two candidates contend at the same instant', () => {
    const decision = decideDriverLease(
      baseRequest({
        nowIso: '2026-01-01T01:00:00.000Z',
        lease: liveLease('driver-a', 1, '2026-01-01T01:00:00.000Z'),
        competingCandidateIds: ['driver-z', 'driver-a'],
      }),
    );
    expect(decision).toEqual({ outcome: 'refused', reason: 'lost-tiebreak' });
  });
});
