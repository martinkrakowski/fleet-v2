/**
 * FC17E hostile-input and behaviour tests for the pure driver standby lease
 * takeover decider: every refusal is the typed reason, nothing ever throws,
 * and no rejected value is ever echoed.
 */

import { types } from 'node:util';
import { describe, expect, it } from 'vitest';

import { DEFAULT_DRIVER_LEASE_TTL_MS, decideDriverLease } from '../driver-lease.js';

/**
 * Every plain call goes through the real production detector, exactly like
 * infrastructure: there is no accepting fallback for a Proxy.
 */
function decide(input: unknown): ReturnType<typeof decideDriverLease> {
  return decideDriverLease(input, types.isProxy);
}

/** A revoked Proxy throws on every trap, including [[GetPrototypeOf]]. */
function revokedProxy(): unknown {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

/**
 * A plain record carrying one accessor on `key` whose getter records any
 * invocation: no Proxy is involved, so the real detector sees plain data and
 * the descriptor read must refuse without ever running the getter.
 */
function accessorOn(key: string, value: unknown, target: Record<string, unknown>): unknown {
  const probe: Record<string, unknown> = { ...target };
  delete probe[key];
  Object.defineProperty(probe, key, {
    enumerable: true,
    get: () => (invokedGetters.push(key), value),
  });
  return probe;
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
  it('acquires from a null lease with fence 1 and a frozen version-stamped lease record using the default ttl', () => {
    const decision = decide(baseRequest({ lease: null }));
    expect(decision).toEqual({
      outcome: 'acquired',
      lease: {
        version: 1,
        holderId: 'driver-b',
        fence: 1,
        leaseUntilIso: '2026-01-01T00:01:00.000Z',
      },
    });
    expect(DEFAULT_DRIVER_LEASE_TTL_MS).toBe(60_000);
    expect(Object.isFrozen((decision as { lease: unknown }).lease)).toBe(true);
  });

  it('refuses a takeover before expiry (1ms before leaseUntilIso) with lease-held', () => {
    const decision = decide(
      baseRequest({
        lease: liveLease('driver-a', 3, '2026-01-01T00:01:00.000Z'),
      }),
    );
    expect(decision).toEqual({ outcome: 'refused', reason: 'lease-held' });
  });

  it('acquires a takeover at the exact expiry instant and after it, incrementing fence by 1', () => {
    const atExpiry = decide(
      baseRequest({
        nowIso: '2026-01-01T01:00:00.000Z',
        lease: liveLease('driver-a', 3, '2026-01-01T01:00:00.000Z'),
      }),
    );
    expect(atExpiry).toEqual({
      outcome: 'acquired',
      lease: {
        version: 1,
        holderId: 'driver-b',
        fence: 4,
        leaseUntilIso: '2026-01-01T01:01:00.000Z',
      },
    });
    const afterExpiry = decide(
      baseRequest({
        nowIso: '2026-01-01T02:00:00.000Z',
        lease: liveLease('driver-a', 7, '2026-01-01T01:00:00.000Z'),
      }),
    );
    expect(afterExpiry).toEqual({
      outcome: 'acquired',
      lease: {
        version: 1,
        holderId: 'driver-b',
        fence: 8,
        leaseUntilIso: '2026-01-01T02:01:00.000Z',
      },
    });
  });

  it('renews for the holder before expiry (1ms before leaseUntilIso), keeping the fence and advancing leaseUntilIso', () => {
    const decision = decide(
      baseRequest({
        candidateId: 'driver-a',
        nowIso: '2026-01-01T00:00:59.999Z',
        lease: liveLease('driver-a', 3, '2026-01-01T00:01:00.000Z'),
      }),
    );
    expect(decision).toEqual({
      outcome: 'renewed',
      lease: {
        version: 1,
        holderId: 'driver-a',
        fence: 3,
        leaseUntilIso: '2026-01-01T00:01:59.999Z',
      },
    });
  });

  it('reacquires as the holder at or after expiry (nowIso === leaseUntilIso), incrementing fence by 1', () => {
    const decision = decide(
      baseRequest({
        candidateId: 'driver-a',
        nowIso: '2026-01-01T01:00:00.000Z',
        lease: liveLease('driver-a', 3, '2026-01-01T01:00:00.000Z'),
      }),
    );
    expect(decision).toEqual({
      outcome: 'acquired',
      lease: {
        version: 1,
        holderId: 'driver-a',
        fence: 4,
        leaseUntilIso: '2026-01-01T01:01:00.000Z',
      },
    });
  });

  it('resolves two contending candidates deterministically by code-unit lexicographic id regardless of array order', () => {
    const request = baseRequest({
      nowIso: '2026-01-01T01:00:00.000Z',
      lease: liveLease('driver-a', 3, '2026-01-01T01:00:00.000Z'),
    });
    expect(decide({ ...request, candidateId: 'driver-a', competingCandidateIds: ['driver-b'] })).toEqual({
      outcome: 'acquired',
      lease: {
        version: 1,
        holderId: 'driver-a',
        fence: 4,
        leaseUntilIso: '2026-01-01T01:01:00.000Z',
      },
    });
    expect(decide({ ...request, candidateId: 'driver-b', competingCandidateIds: ['driver-a'] })).toEqual({
      outcome: 'refused',
      reason: 'lost-tiebreak',
    });
  });

  it('does not mutate deep-frozen inputs', () => {
    const request = deepFreeze(
      baseRequest({ lease: liveLease('driver-a', 1, '2020-01-01T00:00:00.000Z') }),
    );
    const before = JSON.stringify(request);
    decide(request);
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
      expect(decide(input)).toEqual({ outcome: 'refused', reason: 'invalid-input' });
    }
    const getterInput = accessorOn('unknownKey', 1, { ...baseRequest({}), unknownKey: 1 });
    expect(decide(getterInput)).toEqual({ outcome: 'refused', reason: 'invalid-input' });
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
    // A revoked Proxy is refused through the same required-detector path.
    expect(decide(revokedProxy())).toEqual({ outcome: 'refused', reason: 'invalid-input' });
  });

  it('refuses a missing or non-function detector with invalid-input instead of silently accepting a Proxy', () => {
    let reflected = false;
    const proxied = new Proxy(baseRequest({}), {
      ownKeys() {
        reflected = true;
        throw new Error('ownKeys must never be reached');
      },
    });
    for (const missing of [undefined, null]) {
      expect(
        decideDriverLease(proxied, missing as never),
      ).toEqual({ outcome: 'refused', reason: 'invalid-input' });
    }
    expect(reflected).toBe(false);
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
      expect(decide(baseRequest({ candidateId }))).toEqual({
        outcome: 'refused',
        reason: 'invalid-candidate-id',
      });
    }
    expect(decide({ nowIso: '2026-01-01T00:00:00.000Z', lease: null })).toEqual({
      outcome: 'refused',
      reason: 'invalid-candidate-id',
    });
    const getterInput = accessorOn('candidateId', 'driver-b', baseRequest({}));
    expect(decide(getterInput)).toEqual({
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
      expect(decide(baseRequest({ nowIso }))).toEqual({
        outcome: 'refused',
        reason: 'invalid-now-iso',
      });
    }
    expect(decide({ candidateId: 'driver-b', lease: null })).toEqual({
      outcome: 'refused',
      reason: 'invalid-now-iso',
    });
    const getterInput = accessorOn('nowIso', '2026-01-01T00:00:00.000Z', baseRequest({}));
    expect(decide(getterInput)).toEqual({
      outcome: 'refused',
      reason: 'invalid-now-iso',
    });
    expect(invokedGetters).toEqual([]);
  });

  it('refuses missing, malformed, getter-bearing, proxied, non-v1, missing-version, and fence-overflow lease records with invalid-lease', () => {
    const atExpiry = '2026-01-01T01:00:00.000Z';
    for (const lease of [
      undefined,
      42,
      'lease',
      ['lease'],
      { holderId: 'driver-a', fence: 1, leaseUntilIso: atExpiry },
      liveLease('driver-a', 0, atExpiry),
      liveLease('driver-a', 1.5, atExpiry),
      liveLease('driver-a', Number.MAX_SAFE_INTEGER, atExpiry),
      { ...liveLease('driver-a', 1, atExpiry), version: 2 },
      { holderId: '', fence: 1, leaseUntilIso: atExpiry, version: 1 },
      { holderId: 'driver-a', fence: 1, leaseUntilIso: '2026-01-01T00:00:00', version: 1 },
      revokedProxy(),
    ]) {
      expect(decide(baseRequest({ nowIso: atExpiry, lease }))).toEqual({
        outcome: 'refused',
        reason: 'invalid-lease',
      });
    }
    expect(decide({ candidateId: 'driver-b', nowIso: atExpiry })).toEqual({
      outcome: 'refused',
      reason: 'invalid-lease',
    });
    const getterInput = accessorOn('lease', liveLease('driver-a', 1, atExpiry), baseRequest({ nowIso: atExpiry }));
    expect(decide(getterInput)).toEqual({ outcome: 'refused', reason: 'invalid-lease' });
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
      expect(decide(baseRequest({ competingCandidateIds }))).toEqual({
        outcome: 'refused',
        reason: 'invalid-competing-candidates',
      });
    }
    const getterInput = accessorOn('competingCandidateIds', ['driver-a'], baseRequest({}));
    expect(decide(getterInput)).toEqual({
      outcome: 'refused',
      reason: 'invalid-competing-candidates',
    });
    expect(invokedGetters).toEqual([]);
  });

  it('refuses competingCandidateIds exceeding 64 entries in O(1), and a Proxy candidate list before any reflection', () => {
    // A Proxy is refused by the required detector before any length or
    // own-keys read could observe a trap.
    let reflected = false;
    const proxied = new Proxy([['driver-a']], {
      getOwnPropertyDescriptor() {
        reflected = true;
        throw new Error('descriptor traps must never be reached');
      },
      ownKeys() {
        reflected = true;
        throw new Error('ownKeys must never be reached');
      },
    });
    expect(decide(baseRequest({ competingCandidateIds: proxied }))).toEqual({
      outcome: 'refused',
      reason: 'invalid-competing-candidates',
    });
    expect(reflected).toBe(false);
    // A plain array over the cap is refused by the O(1) length pre-gate.
    const tooLong = new Array(65).fill('driver-a');
    expect(decide(baseRequest({ competingCandidateIds: tooLong }))).toEqual({
      outcome: 'refused',
      reason: 'too-many-competing-candidates',
    });
    // An enormous plain length (2**32 - 1) is refused without reading keys.
    const enormous: unknown = new Array(2 ** 32 - 1);
    expect(decide(baseRequest({ competingCandidateIds: enormous }))).toEqual({
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
      expect(decide(baseRequest({ leaseDurationMs }))).toEqual({
        outcome: 'refused',
        reason: 'invalid-lease-duration',
      });
    }
    const getterInput = accessorOn('leaseDurationMs', 60_000, baseRequest({}));
    expect(decide(getterInput)).toEqual({
      outcome: 'refused',
      reason: 'invalid-lease-duration',
    });
    expect(invokedGetters).toEqual([]);
  });

  it('refuses a second driver while the lease is live 1ms before expiry with lease-held', () => {
    const decision = decide(
      baseRequest({
        nowIso: '2026-01-01T00:00:59.999Z',
        lease: liveLease('driver-a', 1, '2026-01-01T00:01:00.000Z'),
      }),
    );
    expect(decision).toEqual({ outcome: 'refused', reason: 'lease-held' });
  });

  it('refuses the lexicographically larger candidate with lost-tiebreak when two candidates contend at the same instant', () => {
    const decision = decide(
      baseRequest({
        nowIso: '2026-01-01T01:00:00.000Z',
        lease: liveLease('driver-a', 1, '2026-01-01T01:00:00.000Z'),
        competingCandidateIds: ['driver-z', 'driver-a'],
      }),
    );
    expect(decision).toEqual({ outcome: 'refused', reason: 'lost-tiebreak' });
  });
});
