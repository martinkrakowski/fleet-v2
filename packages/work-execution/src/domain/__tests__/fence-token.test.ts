import { describe, expect, it } from 'vitest';

import {
  FENCE_REFUSALS,
  decideFencedWrite,
  fenceTokenOf,
  readFenceToken,
  type FenceToken,
} from '../fence-token.js';
import type { LaneRunLeaseRecord } from '../lane-run-records.js';

const NOW = '2026-10-27T10:00:00.000Z';
const IN_2_MIN = '2026-10-27T10:02:00.000Z';
const LEASE: LaneRunLeaseRecord = { holderId: 'driver-example-1', fence: 3, leaseUntilIso: IN_2_MIN };

/**
 * Secret-shaped fakes are assembled at runtime from inert pieces so this file
 * never contains a credential-shaped literal; the scanner still recognises the
 * shape, which is the point under test.
 */
function fakeSecretShape(): string {
  return `gh${'p_'}${'A'.repeat(30)}`;
}

/** A default valid token, with per-test overrides. */
function token(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { holderId: 'driver-example-1', fence: 3, ...overrides };
}

describe('FENCE_REFUSALS', () => {
  it('labels the seven refusals in the fixed order', () => {
    expect(FENCE_REFUSALS).toEqual([
      'invalid-token', 'no-lease', 'stale-fence', 'fence-ahead', 'holder-mismatch',
      'lease-expired', 'no-lease-readable',
    ]);
  });
});

describe('decideFencedWrite', () => {
  it('a token with the current fence and holder is ok', () => {
    expect(decideFencedWrite({ current: LEASE, token: token(), nowIso: NOW })).toEqual({ ok: true });
  });

  it('a token with a lower fence is stale-fence even when the holder matches', () => {
    expect(decideFencedWrite({ current: LEASE, token: token({ fence: 2 }), nowIso: NOW })).toEqual({
      ok: false,
      reason: 'stale-fence',
    });
  });

  it('a token with a higher fence is fence-ahead', () => {
    expect(decideFencedWrite({ current: LEASE, token: token({ fence: 4 }), nowIso: NOW })).toEqual({
      ok: false,
      reason: 'fence-ahead',
    });
  });

  it('the same fence with another holder is holder-mismatch', () => {
    expect(decideFencedWrite({ current: LEASE, token: token({ holderId: 'driver-b' }), nowIso: NOW })).toEqual({
      ok: false,
      reason: 'holder-mismatch',
    });
  });

  it('an expired current lease refuses lease-expired', () => {
    expect(
      decideFencedWrite({ current: LEASE, token: token(), nowIso: '2026-10-27T10:02:00.000Z' }),
    ).toEqual({ ok: false, reason: 'lease-expired' });
    expect(
      decideFencedWrite({ current: LEASE, token: token(), nowIso: '2026-10-27T11:00:00.000Z' }),
    ).toEqual({ ok: false, reason: 'lease-expired' });
  });

  it('a null lease refuses no-lease', () => {
    expect(decideFencedWrite({ current: null, token: token(), nowIso: NOW })).toEqual({
      ok: false,
      reason: 'no-lease',
    });
  });

  it('decideFencedWrite refuses invalid-token before no-lease', () => {
    expect(decideFencedWrite({ current: null, token: null, nowIso: NOW })).toEqual({
      ok: false,
      reason: 'invalid-token',
    });
    expect(decideFencedWrite({ current: LEASE, token: { holderId: 'h' }, nowIso: NOW })).toEqual({
      ok: false,
      reason: 'invalid-token',
    });
  });

  it('decideFencedWrite refuses lease-expired on malformed nowIso', () => {
    expect(decideFencedWrite({ current: LEASE, token: token(), nowIso: 'not-a-time' })).toEqual({
      ok: false,
      reason: 'lease-expired',
    });
  });

  it('the check order puts the fence distinctions ahead of lease-expired on a mismatched token', () => {
    // An expired lease with a lower fence and another holder: the shared
    // checkLeaseHeld answers lease-not-held before its expiry check, so the
    // refinement classifies the fence distinction, not lease-expired.
    expect(
      decideFencedWrite({
        current: LEASE,
        token: token({ fence: 1, holderId: 'driver-b' }),
        nowIso: '2026-10-27T11:00:00.000Z',
      }),
    ).toEqual({ ok: false, reason: 'stale-fence' });
  });
});

describe('fenceTokenOf', () => {
  it('fenceTokenOf a held lease returns its holderId and fence', () => {
    expect(fenceTokenOf(LEASE)).toEqual({ holderId: 'driver-example-1', fence: 3 });
  });

  it('fenceTokenOf a null lease is null', () => {
    expect(fenceTokenOf(null)).toBeNull();
  });
});

describe('readFenceToken', () => {
  it('refuses null, undefined, primitives, arrays and non-plain objects', () => {
    expect(readFenceToken(null)).toBeNull();
    expect(readFenceToken(undefined)).toBeNull();
    expect(readFenceToken(7)).toBeNull();
    expect(readFenceToken('token')).toBeNull();
    expect(readFenceToken(true)).toBeNull();
    expect(readFenceToken([3])).toBeNull();
    expect(readFenceToken(() => 3)).toBeNull();
    expect(readFenceToken(new Date())).toBeNull();
  });

  it('refuses a throwing Proxy without throwing', () => {
    const hostile = new Proxy(token(), {
      ownKeys() {
        throw new Error('boom');
      },
    });
    expect(readFenceToken(hostile)).toBeNull();
    const { proxy: revoked, revoke } = Proxy.revocable(token(), {});
    revoke();
    expect(readFenceToken(revoked)).toBeNull();
  });

  it('refuses a getter-backed token without running the getter', () => {
    const withGetFence: Record<string, unknown> = { holderId: 'driver-example-1' };
    Object.defineProperty(withGetFence, 'fence', {
      get() {
        throw new Error('getter ran');
      },
      enumerable: true,
    });
    expect(readFenceToken(withGetFence)).toBeNull();
    const withGetHolder: Record<string, unknown> = { fence: 3 };
    Object.defineProperty(withGetHolder, 'holderId', {
      get() {
        throw new Error('getter ran');
      },
      enumerable: true,
    });
    expect(readFenceToken(withGetHolder)).toBeNull();
  });

  it('refuses missing, extra, symbol, non-enumerable and __proto__ keys', () => {
    const missing: Record<string, unknown> = { holderId: 'h' };
    expect(readFenceToken(missing)).toBeNull();
    const extra: Record<string, unknown> = { ...token(), extra: true };
    expect(readFenceToken(extra)).toBeNull();
    const symbolKey: Record<string, unknown> = { ...token() };
    Object.defineProperty(symbolKey, 'tag', { value: 'x', enumerable: false });
    expect(readFenceToken(symbolKey)).toBeNull();
    const hiddenFence: Record<string, unknown> = { holderId: 'driver-example-1' };
    Object.defineProperty(hiddenFence, 'fence', { value: 3, enumerable: false });
    expect(readFenceToken(hiddenFence)).toBeNull();
    const protoKey: Record<string, unknown> = JSON.parse('{"holderId":"h","fence":1,"__proto__":{}}') as Record<
      string,
      unknown
    >;
    expect(readFenceToken(protoKey)).toBeNull();
  });

  it('refuses an array-like or enormous-length object', () => {
    const arrayLike: Record<string, unknown> = { 0: 'a', length: 1e9, holderId: 'driver-example-1', fence: 1 };
    expect(readFenceToken(arrayLike)).toBeNull();
  });

  it('refuses a fence of zero and a fractional fence', () => {
    expect(readFenceToken(token({ fence: 0 }))).toBeNull();
    expect(readFenceToken(token({ fence: 1.5 }))).toBeNull();
  });

  it('refuses negative, NaN, Infinity and string fences', () => {
    expect(readFenceToken(token({ fence: -1 }))).toBeNull();
    expect(readFenceToken(token({ fence: Number.NaN }))).toBeNull();
    expect(readFenceToken(token({ fence: Number.POSITIVE_INFINITY }))).toBeNull();
    expect(readFenceToken(token({ fence: '3' }))).toBeNull();
  });

  it('refuses empty, over-256-byte and secret-shaped holderId', () => {
    expect(readFenceToken(token({ holderId: '' }))).toBeNull();
    expect(readFenceToken(token({ holderId: '   ' }))).toBeNull();
    expect(readFenceToken(token({ holderId: 'h'.repeat(257) }))).toBeNull();
    expect(readFenceToken(token({ holderId: fakeSecretShape() }))).toBeNull();
  });

  it('reads a valid token through its own property descriptors and freezes it', () => {
    const parsed = readFenceToken(token());
    expect(parsed).toEqual({ holderId: 'driver-example-1', fence: 3 });
    expect(Object.isFrozen(parsed)).toBe(true);
    const typed: FenceToken | null = parsed;
    expect(typed?.fence).toBe(3);
  });
});
