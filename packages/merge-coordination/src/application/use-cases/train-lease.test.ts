import { describe, expect, it } from 'vitest';

import {
  checkTrainLeaseHeld,
  decideTrainLeaseAcquire,
  decideTrainLeaseRelease,
  decideTrainLeaseRenew,
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
        nowIso,
      });
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
        nowIso,
      });
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
        nowIso,
      });
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
        nowIso,
      });
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
        nowIso,
      });
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
        nowIso,
      });
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
        nowIso,
      });
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
        nowIso,
      });
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
          nowIso,
        }),
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
          nowIso,
        }),
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
          nowIso,
        }),
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
        nowIso,
      };

      expect(() => decideTrainLeaseAcquire(null, malformedRequest)).not.toThrow();
      expect(decideTrainLeaseAcquire(null, malformedRequest)).toEqual({
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
        nowIso,
      };

      expect(() => decideTrainLeaseAcquire(null, malformedRequest)).not.toThrow();
      expect(decideTrainLeaseAcquire(null, malformedRequest)).toEqual({
        ok: false,
        reason: 'invalid-request',
      });
    });

    it('returns invalid-request when acquire request has a throwing getter for leaseUntilIso or nowIso', () => {
      const throwingUntil = {
        holderId: 'holder-1',
        observedFence: 0,
        get leaseUntilIso(): string {
          throw new Error('throwing leaseUntilIso');
        },
        nowIso,
      };
      expect(decideTrainLeaseAcquire(null, throwingUntil)).toEqual({
        ok: false,
        reason: 'invalid-request',
      });

      const throwingNow = {
        holderId: 'holder-1',
        observedFence: 0,
        leaseUntilIso,
        get nowIso(): string {
          throw new Error('throwing nowIso');
        },
      };
      expect(decideTrainLeaseAcquire(null, throwingNow)).toEqual({
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
        nowIso,
      };
      expect(() => decideTrainLeaseRenew(current, throwingHolder)).not.toThrow();
      expect(decideTrainLeaseRenew(current, throwingHolder)).toEqual({
        ok: false,
        reason: 'invalid-request',
      });

      const throwingFence = {
        holderId: 'holder-1',
        get fence(): number {
          throw new Error('throwing fence');
        },
        leaseUntilIso,
        nowIso,
      };
      expect(decideTrainLeaseRenew(current, throwingFence)).toEqual({
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
        nowIso,
      };
      expect(() => decideTrainLeaseRelease(current, throwingHolder)).not.toThrow();
      expect(decideTrainLeaseRelease(current, throwingHolder)).toEqual({
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
        nowIso,
      };
      expect(() => checkTrainLeaseHeld(current, throwingHolder)).not.toThrow();
      expect(checkTrainLeaseHeld(current, throwingHolder)).toBe('invalid-request');
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
});
