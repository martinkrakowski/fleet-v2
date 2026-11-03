import { describe, expect, it } from 'vitest';

import {
  TRAIN_LEASE_MAX_MS,
  checkTrainLeaseHeld,
  decideTrainLeaseAcquire,
  decideTrainLeaseRelease,
  decideTrainLeaseRenew,
  readClockIso,
  readTrainLeaseRecord,
  type TrainLeaseRecord,
} from './train-lease.js';

describe('train-lease pure rules', () => {
  const nowIso = '2026-11-02T20:00:00.000Z';
  const leaseUntilIso = '2026-11-02T20:05:00.000Z';

  describe('decideTrainLeaseAcquire', () => {
    it('acquires a lease over null', () => {
      const result = decideTrainLeaseAcquire(null, {
        holderId: 'holder-1',
        observedFence: 0,
        leaseUntilIso,
      }, nowIso);
      expect(result).toEqual({
        ok: true,
        lease: {
          holderId: 'holder-1',
          fence: 1,
          leaseUntilIso,
        },
      });
    });

    it('refuses acquire when observed fence does not match', () => {
      const current: TrainLeaseRecord = {
        holderId: 'holder-1',
        fence: 2,
        leaseUntilIso: '2026-11-02T19:50:00.000Z', // expired
      };
      const result = decideTrainLeaseAcquire(current, {
        holderId: 'holder-2',
        observedFence: 1,
        leaseUntilIso,
      }, nowIso);
      expect(result).toEqual({ ok: false, reason: 'lease-moved' });
    });

    it('refuses acquire when current lease is still held and not expired', () => {
      const current: TrainLeaseRecord = {
        holderId: 'holder-1',
        fence: 1,
        leaseUntilIso: '2026-11-02T20:10:00.000Z',
      };
      const result = decideTrainLeaseAcquire(current, {
        holderId: 'holder-2',
        observedFence: 1,
        leaseUntilIso,
      }, nowIso);
      expect(result).toEqual({ ok: false, reason: 'lease-held' });
    });
  });

  describe('decideTrainLeaseRenew', () => {
    it('renews lease for current holder with matching fence', () => {
      const current: TrainLeaseRecord = {
        holderId: 'holder-1',
        fence: 2,
        leaseUntilIso: '2026-11-02T20:02:00.000Z',
      };
      const newUntil = '2026-11-02T20:08:00.000Z';
      const result = decideTrainLeaseRenew(current, {
        holderId: 'holder-1',
        fence: 2,
        leaseUntilIso: newUntil,
      }, nowIso);
      expect(result).toEqual({
        ok: true,
        lease: {
          holderId: 'holder-1',
          fence: 2,
          leaseUntilIso: newUntil,
        },
      });
    });

    it('refuses renew when holder or fence does not match', () => {
      const current: TrainLeaseRecord = {
        holderId: 'holder-1',
        fence: 2,
        leaseUntilIso: '2026-11-02T20:05:00.000Z',
      };
      const result = decideTrainLeaseRenew(current, {
        holderId: 'holder-2',
        fence: 2,
        leaseUntilIso,
      }, nowIso);
      expect(result).toEqual({ ok: false, reason: 'lease-not-held' });
    });

    it('refuses renew when current lease is expired', () => {
      const current: TrainLeaseRecord = {
        holderId: 'holder-1',
        fence: 2,
        leaseUntilIso: '2026-11-02T19:59:00.000Z',
      };
      const result = decideTrainLeaseRenew(current, {
        holderId: 'holder-1',
        fence: 2,
        leaseUntilIso,
      }, nowIso);
      expect(result).toEqual({ ok: false, reason: 'lease-expired' });
    });
  });

  describe('decideTrainLeaseRelease', () => {
    it('releases held lease by setting leaseUntilIso to nowIso', () => {
      const current: TrainLeaseRecord = {
        holderId: 'holder-1',
        fence: 2,
        leaseUntilIso: '2026-11-02T20:10:00.000Z',
      };
      const result = decideTrainLeaseRelease(current, {
        holderId: 'holder-1',
        fence: 2,
      }, nowIso);
      expect(result).toEqual({
        ok: true,
        lease: {
          holderId: 'holder-1',
          fence: 2,
          leaseUntilIso: nowIso,
        },
      });
    });

    it('refuses release if not held', () => {
      const current: TrainLeaseRecord = {
        holderId: 'holder-1',
        fence: 2,
        leaseUntilIso: '2026-11-02T20:10:00.000Z',
      };
      const result = decideTrainLeaseRelease(current, {
        holderId: 'holder-2',
        fence: 2,
      }, nowIso);
      expect(result).toEqual({ ok: false, reason: 'lease-not-held' });
    });
  });

  describe('checkTrainLeaseHeld', () => {
    it('returns null when held and unexpired', () => {
      const current: TrainLeaseRecord = {
        holderId: 'holder-1',
        fence: 2,
        leaseUntilIso: '2026-11-02T20:10:00.000Z',
      };
      expect(
        checkTrainLeaseHeld(current, {
          holderId: 'holder-1',
          fence: 2,
        }, nowIso),
      ).toBeNull();
    });

    it('returns lease-not-held when holder differs', () => {
      const current: TrainLeaseRecord = {
        holderId: 'holder-1',
        fence: 2,
        leaseUntilIso: '2026-11-02T20:10:00.000Z',
      };
      expect(
        checkTrainLeaseHeld(current, {
          holderId: 'holder-2',
          fence: 2,
        }, nowIso),
      ).toBe('lease-not-held');
    });

    it('returns lease-expired when lease has elapsed', () => {
      const current: TrainLeaseRecord = {
        holderId: 'holder-1',
        fence: 2,
        leaseUntilIso: '2026-11-02T19:59:00.000Z',
      };
      expect(
        checkTrainLeaseHeld(current, {
          holderId: 'holder-1',
          fence: 2,
        }, nowIso),
      ).toBe('lease-expired');
    });
  });

  describe('readTrainLeaseRecord', () => {
    it('reads a valid record', () => {
      const record = readTrainLeaseRecord({
        holderId: 'holder-1',
        fence: 3,
        leaseUntilIso,
      });
      expect(record).toEqual({
        holderId: 'holder-1',
        fence: 3,
        leaseUntilIso,
      });
    });

    it('returns null for missing or invalid keys', () => {
      expect(readTrainLeaseRecord(null)).toBeNull();
      expect(readTrainLeaseRecord({})).toBeNull();
      expect(
        readTrainLeaseRecord({
          holderId: 'holder-1',
          fence: 0, // fence must be >= 1
          leaseUntilIso,
        }),
      ).toBeNull();
    });
  });

  describe('Finding 1: throwing getter in requests must return invalid-request, never throw', () => {
    it('returns invalid-request when acquire request has a throwing getter for holderId', () => {
      const malformedRequest = {
        get holderId(): string {
          throw new Error('malicious or buggy holderId getter');
        },
        observedFence: 0,
        leaseUntilIso,
      };

      expect(() => decideTrainLeaseAcquire(null, malformedRequest, nowIso)).not.toThrow();
      expect(decideTrainLeaseAcquire(null, malformedRequest, nowIso)).toEqual({
        ok: false,
        reason: 'invalid-request',
      });
    });

    it('returns invalid-request when acquire request has a throwing getter for observedFence', () => {
      const malformedRequest = {
        holderId: 'holder-1',
        get observedFence(): number {
          throw new Error('throwing fence getter');
        },
        leaseUntilIso,
      };

      expect(() => decideTrainLeaseAcquire(null, malformedRequest, nowIso)).not.toThrow();
      expect(decideTrainLeaseAcquire(null, malformedRequest, nowIso)).toEqual({
        ok: false,
        reason: 'invalid-request',
      });
    });

    it('returns invalid-request when acquire request has a throwing getter for leaseUntilIso', () => {
      const throwingUntil = {
        holderId: 'holder-1',
        observedFence: 0,
        get leaseUntilIso(): string {
          throw new Error('throwing leaseUntilIso');
        },
      };
      expect(decideTrainLeaseAcquire(null, throwingUntil, nowIso)).toEqual({
        ok: false,
        reason: 'invalid-request',
      });
    });

    it('returns invalid-request when renew request has a throwing getter', () => {
      const current: TrainLeaseRecord = {
        holderId: 'holder-1',
        fence: 1,
        leaseUntilIso: '2026-11-02T20:10:00.000Z',
      };

      const throwingHolder = {
        get holderId(): string {
          throw new Error('throwing holderId');
        },
        fence: 1,
        leaseUntilIso,
      };
      expect(() => decideTrainLeaseRenew(current, throwingHolder, nowIso)).not.toThrow();
      expect(decideTrainLeaseRenew(current, throwingHolder, nowIso)).toEqual({
        ok: false,
        reason: 'invalid-request',
      });

      const throwingFence = {
        holderId: 'holder-1',
        get fence(): number {
          throw new Error('throwing fence');
        },
        leaseUntilIso,
      };
      expect(decideTrainLeaseRenew(current, throwingFence, nowIso)).toEqual({
        ok: false,
        reason: 'invalid-request',
      });
    });

    it('returns invalid-request when release request has a throwing getter', () => {
      const current: TrainLeaseRecord = {
        holderId: 'holder-1',
        fence: 1,
        leaseUntilIso: '2026-11-02T20:10:00.000Z',
      };

      const throwingHolder = {
        get holderId(): string {
          throw new Error('throwing holderId');
        },
        fence: 1,
      };
      expect(() => decideTrainLeaseRelease(current, throwingHolder, nowIso)).not.toThrow();
      expect(decideTrainLeaseRelease(current, throwingHolder, nowIso)).toEqual({
        ok: false,
        reason: 'invalid-request',
      });
    });

    it('returns invalid-request when checkTrainLeaseHeld receives a throwing getter', () => {
      const current: TrainLeaseRecord = {
        holderId: 'holder-1',
        fence: 1,
        leaseUntilIso: '2026-11-02T20:10:00.000Z',
      };

      const throwingHolder = {
        get holderId(): string {
          throw new Error('throwing holderId');
        },
        fence: 1,
      };
      expect(() => checkTrainLeaseHeld(current, throwingHolder, nowIso)).not.toThrow();
      expect(checkTrainLeaseHeld(current, throwingHolder, nowIso)).toBe('invalid-request');
    });

    it('returns null without throwing when readTrainLeaseRecord receives a throwing getter', () => {
      const throwingRecord = {
        get holderId(): string {
          throw new Error('throwing holderId');
        },
        fence: 1,
        leaseUntilIso,
      };
      expect(() => readTrainLeaseRecord(throwingRecord)).not.toThrow();
      expect(readTrainLeaseRecord(throwingRecord)).toBeNull();
    });
  });

  describe('clock-decided expiry', () => {
    it('refuses an acquire, renew, release or check request that still carries nowIso', () => {
      const current: TrainLeaseRecord = {
        holderId: 'holder-1',
        fence: 1,
        leaseUntilIso: '2026-11-02T20:10:00.000Z',
      };

      const acquireRequest = {
        holderId: 'holder-1',
        observedFence: 0,
        leaseUntilIso,
        nowIso,
      } as unknown;
      expect(decideTrainLeaseAcquire(null, acquireRequest, nowIso)).toEqual({
        ok: false,
        reason: 'invalid-request',
      });

      const renewRequest = {
        holderId: 'holder-1',
        fence: 1,
        leaseUntilIso,
        nowIso,
      } as unknown;
      expect(decideTrainLeaseRenew(current, renewRequest, nowIso)).toEqual({
        ok: false,
        reason: 'invalid-request',
      });

      const releaseRequest = {
        holderId: 'holder-1',
        fence: 1,
        nowIso,
      } as unknown;
      expect(decideTrainLeaseRelease(current, releaseRequest, nowIso)).toEqual({
        ok: false,
        reason: 'invalid-request',
      });

      const checkRequest = {
        holderId: 'holder-1',
        fence: 1,
        nowIso,
      } as unknown;
      expect(checkTrainLeaseHeld(current, checkRequest, nowIso)).toBe('invalid-request');
    });

    it('renew of an expired lease is refused at the clock time', () => {
      const current: TrainLeaseRecord = {
        holderId: 'holder-1',
        fence: 2,
        leaseUntilIso: '2026-11-02T19:59:00.000Z',
      };
      const result = decideTrainLeaseRenew(current, { holderId: 'holder-1', fence: 2, leaseUntilIso }, nowIso);
      expect(result).toEqual({ ok: false, reason: 'lease-expired' });
    });

    it('renew cannot extend a lease held by another holder', () => {
      const current: TrainLeaseRecord = {
        holderId: 'holder-1',
        fence: 2,
        leaseUntilIso: '2026-11-02T20:10:00.000Z',
      };
      const result = decideTrainLeaseRenew(current, { holderId: 'holder-2', fence: 2, leaseUntilIso }, nowIso);
      expect(result).toEqual({ ok: false, reason: 'lease-not-held' });
    });

    it('release sets the lease end to the clock time, never a requested time', () => {
      const current: TrainLeaseRecord = {
        holderId: 'holder-1',
        fence: 2,
        leaseUntilIso: '2026-11-02T20:10:00.000Z',
      };
      const result = decideTrainLeaseRelease(current, { holderId: 'holder-1', fence: 2 }, nowIso);
      expect(result).toEqual({
        ok: true,
        lease: {
          holderId: 'holder-1',
          fence: 2,
          leaseUntilIso: nowIso,
        },
      });
    });

    it('release by a foreign holder or wrong fence is refused with lease-not-held', () => {
      const current: TrainLeaseRecord = {
        holderId: 'holder-1',
        fence: 2,
        leaseUntilIso: '2026-11-02T20:10:00.000Z',
      };
      expect(decideTrainLeaseRelease(current, { holderId: 'holder-2', fence: 2 }, nowIso)).toEqual({
        ok: false,
        reason: 'lease-not-held',
      });
      expect(decideTrainLeaseRelease(current, { holderId: 'holder-1', fence: 1 }, nowIso)).toEqual({
        ok: false,
        reason: 'lease-not-held',
      });
    });

    it('acquire is refused with lease-held while the lease is unexpired at the clock time', () => {
      const current: TrainLeaseRecord = {
        holderId: 'holder-1',
        fence: 1,
        leaseUntilIso: '2026-11-02T20:10:00.000Z',
      };
      const result = decideTrainLeaseAcquire(current, { holderId: 'holder-2', observedFence: 1, leaseUntilIso }, nowIso);
      expect(result).toEqual({ ok: false, reason: 'lease-held' });
    });

    it('acquire takes a lapsed lease at the clock time and raises the fence by one', () => {
      const current: TrainLeaseRecord = {
        holderId: 'holder-1',
        fence: 1,
        leaseUntilIso: '2026-11-02T19:50:00.000Z',
      };
      const result = decideTrainLeaseAcquire(current, { holderId: 'holder-2', observedFence: 1, leaseUntilIso }, nowIso);
      expect(result).toEqual({
        ok: true,
        lease: {
          holderId: 'holder-2',
          fence: 2,
          leaseUntilIso,
        },
      });
    });

    it('acquire and renew refuse a leaseUntilIso at or before the clock time or more than ten minutes after it', () => {
      const atClock = '2026-11-02T20:00:00.000Z';
      const justBefore = '2026-11-02T19:59:59.999Z';
      const beyondMax = new Date(Date.parse(nowIso) + TRAIN_LEASE_MAX_MS + 1).toISOString();

      expect(decideTrainLeaseAcquire(null, { holderId: 'holder-1', observedFence: 0, leaseUntilIso: atClock }, nowIso)).toEqual({ ok: false, reason: 'invalid-request' });
      expect(decideTrainLeaseAcquire(null, { holderId: 'holder-1', observedFence: 0, leaseUntilIso: justBefore }, nowIso)).toEqual({ ok: false, reason: 'invalid-request' });
      expect(decideTrainLeaseAcquire(null, { holderId: 'holder-1', observedFence: 0, leaseUntilIso: beyondMax }, nowIso)).toEqual({ ok: false, reason: 'invalid-request' });

      const current: TrainLeaseRecord = {
        holderId: 'holder-1',
        fence: 1,
        leaseUntilIso: '2026-11-02T20:10:00.000Z',
      };
      expect(decideTrainLeaseRenew(current, { holderId: 'holder-1', fence: 1, leaseUntilIso: atClock }, nowIso)).toEqual({ ok: false, reason: 'invalid-request' });
      expect(decideTrainLeaseRenew(current, { holderId: 'holder-1', fence: 1, leaseUntilIso: justBefore }, nowIso)).toEqual({ ok: false, reason: 'invalid-request' });
      expect(decideTrainLeaseRenew(current, { holderId: 'holder-1', fence: 1, leaseUntilIso: beyondMax }, nowIso)).toEqual({ ok: false, reason: 'invalid-request' });
    });

    it.each([
      ['empty string', ''],
      ['garbage', 'garbage'],
      ['no zone', '2026-11-02 20:00:00'],
      ['bad calendar date', '2026-13-45T00:00:00Z'],
      ['number', 42],
      ['undefined', undefined],
    ])('a malformed clock value %s gives clock-unreadable from every decision', (_label, badClock) => {
      const current: TrainLeaseRecord = {
        holderId: 'holder-1',
        fence: 1,
        leaseUntilIso: '2026-11-02T20:10:00.000Z',
      };
      expect(decideTrainLeaseAcquire(null, { holderId: 'holder-1', observedFence: 0, leaseUntilIso }, badClock as string)).toEqual({ ok: false, reason: 'clock-unreadable' });
      expect(decideTrainLeaseRenew(current, { holderId: 'holder-1', fence: 1, leaseUntilIso }, badClock as string)).toEqual({ ok: false, reason: 'clock-unreadable' });
      expect(decideTrainLeaseRelease(current, { holderId: 'holder-1', fence: 1 }, badClock as string)).toEqual({ ok: false, reason: 'clock-unreadable' });
      expect(checkTrainLeaseHeld(current, { holderId: 'holder-1', fence: 1 }, badClock as string)).toBe('clock-unreadable');
    });

    it('readClockIso returns the canonical ISO string for a zoned time and null otherwise', () => {
      expect(readClockIso('2026-11-02T20:00:00.000Z')).toBe('2026-11-02T20:00:00.000Z');
      expect(readClockIso('2026-11-02T21:00:00+01:00')).toBe('2026-11-02T20:00:00.000Z');
      expect(readClockIso('')).toBeNull();
      expect(readClockIso('garbage')).toBeNull();
      expect(readClockIso('2026-11-02 20:00:00')).toBeNull();
      expect(readClockIso('2026-13-45T00:00:00Z')).toBeNull();
      expect(readClockIso(42)).toBeNull();
      expect(readClockIso(undefined)).toBeNull();
    });
  });
});
