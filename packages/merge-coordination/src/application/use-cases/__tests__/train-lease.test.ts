import { describe, expect, it } from 'vitest';

import {
  TRAIN_LEASE_MAX_MS,
  checkTrainLeaseHeld,
  decideTrainLeaseAcquire,
  decideTrainLeaseRelease,
  decideTrainLeaseRenew,
  readTrainLeaseRecord,
  type TrainLeaseRecord,
} from '../train-lease.js';

const NOW = '2026-11-02T12:00:00.000Z';
const UNTIL = '2026-11-02T12:05:00.000Z';

/** A lease held by a holder at a fence. */
function held(holderId = 'worker-1', fence = 1): TrainLeaseRecord {
  return { holderId, fence, leaseUntilIso: UNTIL };
}

describe('decideTrainLeaseAcquire', () => {
  it('acquires from null and starts the fence at 1', () => {
    const decision = decideTrainLeaseAcquire(null, { holderId: 'worker-1', observedFence: 0, leaseUntilIso: UNTIL }, NOW);
    expect(decision).toEqual({
      ok: true,
      lease: { holderId: 'worker-1', fence: 1, leaseUntilIso: UNTIL },
    });
  });

  it('refuses acquiring while the lease is unexpired', () => {
    const decision = decideTrainLeaseAcquire(held(), { holderId: 'worker-2', observedFence: 1, leaseUntilIso: UNTIL }, NOW);
    expect(decision).toEqual({ ok: false, reason: 'lease-held' });
  });

  it('acquires after expiry with the observed fence and raises it', () => {
    const now = '2026-11-02T12:06:00.000Z';
    const until = '2026-11-02T12:11:00.000Z';
    const decision = decideTrainLeaseAcquire(held(), { holderId: 'worker-2', observedFence: 1, leaseUntilIso: until }, now);
    expect(decision).toEqual({
      ok: true,
      lease: { holderId: 'worker-2', fence: 2, leaseUntilIso: until },
    });
  });

  it('refuses acquiring with a wrong observed fence', () => {
    const decision = decideTrainLeaseAcquire(held('worker-1', 2), { holderId: 'worker-2', observedFence: 5, leaseUntilIso: '2026-11-02T12:11:00.000Z' }, '2026-11-02T12:06:00.000Z');
    expect(decision).toEqual({ ok: false, reason: 'lease-moved' });
  });

  it('refuses a leaseUntilIso in the past', () => {
    const decision = decideTrainLeaseAcquire(null, {
      holderId: 'worker-1',
      observedFence: 0,
      leaseUntilIso: '2026-11-02T11:00:00.000Z',
    }, NOW);
    expect(decision).toEqual({ ok: false, reason: 'invalid-request' });
  });

  it('refuses a leaseUntilIso beyond the maximum lease length', () => {
    const decision = decideTrainLeaseAcquire(null, {
      holderId: 'worker-1',
      observedFence: 0,
      leaseUntilIso: new Date(Date.parse(NOW) + TRAIN_LEASE_MAX_MS + 1).toISOString(),
    }, NOW);
    expect(decision).toEqual({ ok: false, reason: 'invalid-request' });
  });
});

describe('decideTrainLeaseRenew', () => {
  it('renews by the holder with its fence and keeps the fence', () => {
    const decision = decideTrainLeaseRenew(held(), { holderId: 'worker-1', fence: 1, leaseUntilIso: UNTIL }, NOW);
    expect(decision).toEqual({ ok: true, lease: { holderId: 'worker-1', fence: 1, leaseUntilIso: UNTIL } });
  });

  it('refuses a renewal by a stale holder', () => {
    const decision = decideTrainLeaseRenew(held('worker-1'), { holderId: 'worker-2', fence: 1, leaseUntilIso: UNTIL }, NOW);
    expect(decision).toEqual({ ok: false, reason: 'lease-not-held' });
  });

  it('refuses a renewal with a stale fence', () => {
    const decision = decideTrainLeaseRenew(held('worker-1', 3), { holderId: 'worker-1', fence: 2, leaseUntilIso: UNTIL }, NOW);
    expect(decision).toEqual({ ok: false, reason: 'lease-not-held' });
  });
});

describe('decideTrainLeaseRelease', () => {
  it('releases keeping holder and fence', () => {
    const decision = decideTrainLeaseRelease(held(), { holderId: 'worker-1', fence: 1 }, NOW);
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.lease.holderId).toBe('worker-1');
      expect(decision.lease.fence).toBe(1);
    }
  });
});

describe('checkTrainLeaseHeld', () => {
  it('answers null while the lease is held', () => {
    expect(checkTrainLeaseHeld(held(), { holderId: 'worker-1', fence: 1 }, NOW)).toBeNull();
  });

  it('answers lease-expired after expiry', () => {
    expect(checkTrainLeaseHeld(held(), { holderId: 'worker-1', fence: 1 }, '2026-11-02T12:06:00.000Z')).toBe('lease-expired');
  });
});

describe('input hardening', () => {
  const BAD_INPUTS: readonly unknown[] = [null, undefined, 42, {}];

  it('refuses bad input for every function with invalid-request and never throws', () => {
    for (const bad of BAD_INPUTS) {
      expect(decideTrainLeaseAcquire(null, bad, NOW)).toEqual({ ok: false, reason: 'invalid-request' });
      expect(decideTrainLeaseRenew(held(), bad, NOW)).toEqual({ ok: false, reason: 'invalid-request' });
      expect(decideTrainLeaseRelease(held(), bad, NOW)).toEqual({ ok: false, reason: 'invalid-request' });
      expect(checkTrainLeaseHeld(held(), bad, NOW)).toBe('invalid-request');
      expect(readTrainLeaseRecord(bad)).toBeNull();
    }
  });

  it('reads a well-formed lease record', () => {
    expect(readTrainLeaseRecord({ holderId: 'worker-1', fence: 1, leaseUntilIso: UNTIL })).toEqual(held());
  });
});
