import { describe, expect, it } from 'vitest';

import {
  CONDUCTOR_DRIVER_LEASE_RECORD_VERSION,
  LANE_RUN_LEASE_MAX_MS,
  LEASE_REFUSALS,
  checkLeaseHeld,
  decideLeaseAcquire,
  decideLeaseRelease,
  decideLeaseRenew,
  isLeaseLapsed,
  readConductorDriverLease,
} from '../lane-run-lease.js';
import type { LaneRunLeaseRecord } from '../lane-run-records.js';

const NOW = '2026-10-27T10:00:00.000Z';
const IN_2_MIN = '2026-10-27T10:02:00.000Z';
const IN_11_MIN = '2026-10-27T10:11:00.000Z';
const LEASE: LaneRunLeaseRecord = { holderId: 'driver-example-1', fence: 3, leaseUntilIso: IN_2_MIN };

/**
 * Secret-shaped fakes are assembled at runtime from inert pieces so this file
 * never contains a credential-shaped literal; the scanner still recognises the
 * shape, which is the point under test.
 */
function fakeSecretShape(): string {
  return `gh${'p_'}${'A'.repeat(30)}`;
}

/**
 * Request builders: the default holder, fence and times each decision accepts,
 * with per-test overrides. The three shapes stay separate so no builder ever
 * carries a key the corresponding reader would refuse.
 */
function acquireRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    holderId: 'driver-example-1',
    observedFence: 0,
    leaseUntilIso: IN_2_MIN,
    nowIso: NOW,
    ...overrides,
  };
}
function holdRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { holderId: 'driver-example-1', fence: 3, nowIso: NOW, ...overrides };
}
function renewRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...holdRequest(), leaseUntilIso: IN_2_MIN, ...overrides };
}

describe('lease constants', () => {
  it('labels the five refusals', () => {
    expect(LEASE_REFUSALS).toEqual([
      'invalid-request', 'lease-held', 'lease-moved', 'lease-not-held', 'lease-expired',
    ]);
  });

  it('caps a single lease step at ten minutes', () => {
    expect(LANE_RUN_LEASE_MAX_MS).toBe(10 * 60 * 1000);
  });
});

describe('decideLeaseAcquire', () => {
  it('acquires from null with fence 1', () => {
    const decision = decideLeaseAcquire(null, acquireRequest());
    expect(decision).toEqual({ ok: true, lease: { holderId: 'driver-example-1', fence: 1, leaseUntilIso: IN_2_MIN } });
  });

  it('acquires over an expired lease raising the fence to 4 with the new holder', () => {
    const expired: LaneRunLeaseRecord = { holderId: 'driver-old', fence: 3, leaseUntilIso: NOW };
    const decision = decideLeaseAcquire(expired, acquireRequest({ holderId: 'driver-new', observedFence: 3 }));
    expect(decision).toEqual({ ok: true, lease: { holderId: 'driver-new', fence: 4, leaseUntilIso: IN_2_MIN } });
  });

  it('refuses over a live lease even with a stale observed fence', () => {
    const decision = decideLeaseAcquire(LEASE, acquireRequest({ holderId: 'driver-another', observedFence: 2 }));
    expect(decision).toEqual({ ok: false, reason: 'lease-held' });
  });

  it('refuses when the observed fence is not the current fence of an expired lease', () => {
    const expired: LaneRunLeaseRecord = { holderId: 'driver-example-1', fence: 3, leaseUntilIso: NOW };
    const decision = decideLeaseAcquire(expired, acquireRequest({ observedFence: 2 }));
    expect(decision).toEqual({ ok: false, reason: 'lease-moved' });
  });

  it.each([
    [NOW],
    ['2026-10-27T09:59:00.000Z'],
    [IN_11_MIN],
  ])('refuses a leaseUntilIso outside the window (%s)', (leaseUntilIso) => {
    const decision = decideLeaseAcquire(null, acquireRequest({ leaseUntilIso }));
    expect(decision).toEqual({ ok: false, reason: 'invalid-request' });
  });

  it('counts a lease whose leaseUntilIso equals NOW as expired', () => {
    const atNow: LaneRunLeaseRecord = { holderId: 'driver-example-1', fence: 3, leaseUntilIso: NOW };
    const decision = decideLeaseAcquire(atNow, acquireRequest({ observedFence: 3 }));
    expect(decision).toEqual({ ok: true, lease: { holderId: 'driver-example-1', fence: 4, leaseUntilIso: IN_2_MIN } });
  });

  it('two drivers with one expired lease: first acquires, second is lease-held, stale fence later is lease-moved', () => {
    const expired: LaneRunLeaseRecord = { holderId: 'driver-a', fence: 3, leaseUntilIso: NOW };
    const first = decideLeaseAcquire(expired, acquireRequest({ holderId: 'driver-a', observedFence: 3 }));
    expect(first).toEqual({ ok: true, lease: { holderId: 'driver-a', fence: 4, leaseUntilIso: IN_2_MIN } });
    if (!first.ok) return;

    const second = decideLeaseAcquire(first.lease, acquireRequest({ holderId: 'driver-b', observedFence: 3 }));
    expect(second).toEqual({ ok: false, reason: 'lease-held' });

    const lapsed = decideLeaseAcquire(
      { ...first.lease, leaseUntilIso: NOW },
      acquireRequest({ holderId: 'driver-b', observedFence: 3 }),
    );
    expect(lapsed).toEqual({ ok: false, reason: 'lease-moved' });
  });
});

describe('decideLeaseRenew', () => {
  const IN_5_MIN = '2026-10-27T10:05:00.000Z';

  it('renews with the same fence and a new time', () => {
    const decision = decideLeaseRenew(LEASE, renewRequest({ leaseUntilIso: IN_5_MIN }));
    expect(decision).toEqual({ ok: true, lease: { holderId: 'driver-example-1', fence: 3, leaseUntilIso: IN_5_MIN } });
  });

  it('refuses another holder', () => {
    const decision = decideLeaseRenew(LEASE, renewRequest({ holderId: 'driver-another' }));
    expect(decision).toEqual({ ok: false, reason: 'lease-not-held' });
  });

  it('refuses another fence', () => {
    const decision = decideLeaseRenew(LEASE, renewRequest({ fence: 2 }));
    expect(decision).toEqual({ ok: false, reason: 'lease-not-held' });
  });

  it('refuses an expired lease', () => {
    const expired: LaneRunLeaseRecord = { holderId: 'driver-example-1', fence: 3, leaseUntilIso: NOW };
    const decision = decideLeaseRenew(expired, renewRequest({ nowIso: '2026-10-27T10:01:00.000Z' }));
    expect(decision).toEqual({ ok: false, reason: 'lease-expired' });
  });

  it('refuses a null lease', () => {
    const decision = decideLeaseRenew(null, renewRequest());
    expect(decision).toEqual({ ok: false, reason: 'lease-not-held' });
  });
});

describe('decideLeaseRelease', () => {
  it('ends a live lease now, keeping holder and fence', () => {
    const decision = decideLeaseRelease(LEASE, holdRequest());
    expect(decision).toEqual({ ok: true, lease: { holderId: 'driver-example-1', fence: 3, leaseUntilIso: NOW } });
  });

  it('leaves an expired lease unchanged', () => {
    const expired: LaneRunLeaseRecord = {
      holderId: 'driver-example-1',
      fence: 3,
      leaseUntilIso: '2026-10-27T09:58:00.000Z',
    };
    const decision = decideLeaseRelease(expired, holdRequest());
    expect(decision).toEqual({ ok: true, lease: expired });
  });

  it('refuses a wrong fence', () => {
    const decision = decideLeaseRelease(LEASE, holdRequest({ fence: 2 }));
    expect(decision).toEqual({ ok: false, reason: 'lease-not-held' });
  });

  it('lets another holder acquire at fence 4 after the release', () => {
    const released = decideLeaseRelease(LEASE, holdRequest());
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    const acquired = decideLeaseAcquire(released.lease, acquireRequest({ holderId: 'driver-another', observedFence: 3 }));
    expect(acquired).toEqual({ ok: true, lease: { holderId: 'driver-another', fence: 4, leaseUntilIso: IN_2_MIN } });
  });
});

describe('checkLeaseHeld', () => {
  it('returns null for the holder with its fence before expiry', () => {
    expect(checkLeaseHeld(LEASE, holdRequest())).toBeNull();
  });

  it('returns lease-expired after expiry', () => {
    const atNow: LaneRunLeaseRecord = { holderId: 'driver-example-1', fence: 3, leaseUntilIso: NOW };
    expect(checkLeaseHeld(atNow, holdRequest())).toBe('lease-expired');
  });

  it('returns lease-not-held for a stale fence', () => {
    expect(checkLeaseHeld(LEASE, holdRequest({ fence: 2 }))).toBe('lease-not-held');
  });
});

describe('isLeaseLapsed', () => {
  it('is true for a null lease', () => {
    expect(isLeaseLapsed(null, NOW)).toBe(true);
  });

  it('is false for a live lease', () => {
    expect(isLeaseLapsed(LEASE, NOW)).toBe(false);
  });

  it('is true for an expired lease', () => {
    const expired: LaneRunLeaseRecord = { holderId: 'driver-example-1', fence: 3, leaseUntilIso: NOW };
    expect(isLeaseLapsed(expired, NOW)).toBe(true);
  });

  it('is false for a malformed nowIso', () => {
    expect(isLeaseLapsed(LEASE, '2026-10-27T10:00:00')).toBe(false);
    expect(isLeaseLapsed(null, '2026-10-27T10:00:00')).toBe(false);
  });
});

describe('hostile lease requests', () => {
  const hostile: Array<() => unknown> = [
    () => null,
    () => [],
    () => acquireRequest({ observedFence: 3, extra: true }),
    () => acquireRequest({ nowIso: undefined }),
    () => renewRequest({ fence: 1.5 }),
    () => acquireRequest({ observedFence: -1 }),
    () => acquireRequest({ nowIso: '2026-10-27T10:00:00' }),
    () => acquireRequest({ nowIso: '2026-02-31T10:00:00Z' }),
    () => {
      const record = acquireRequest({ observedFence: 3 }) as Record<string, unknown>;
      Object.defineProperty(record, 'nowIso', {
        get() {
          throw new Error('boom');
        },
        enumerable: true,
      });
      return record;
    },
    () => new Proxy(acquireRequest({ observedFence: 3 }), {
      ownKeys() {
        throw new Error('boom');
      },
    }),
    () => acquireRequest({ observedFence: 3, holderId: fakeSecretShape() }),
  ];

  it('never throws and refuses every hostile request with invalid-request', () => {
    for (const make of hostile) {
      const input = make();
      expect(decideLeaseAcquire(LEASE, input)).toEqual({ ok: false, reason: 'invalid-request' });
      expect(decideLeaseRenew(LEASE, input)).toEqual({ ok: false, reason: 'invalid-request' });
      expect(decideLeaseRelease(LEASE, input)).toEqual({ ok: false, reason: 'invalid-request' });
      expect(checkLeaseHeld(LEASE, input)).toBe('invalid-request');
    }
  });
});

describe('readConductorDriverLease', () => {
  const VALID_DRIVER_LEASE = {
    version: 1,
    holderId: 'driver-example-1',
    fence: 3,
    leaseUntilIso: '2026-10-27T12:02:00+02:00',
  };

  const VALID_LEASE_ISO = '2026-10-27T10:02:00Z';

  it('reads a valid record and normalises the offset to Z', () => {
    const result = readConductorDriverLease(VALID_DRIVER_LEASE);
    expect(result).toEqual({
      ok: true,
      record: {
        version: 1,
        holderId: 'driver-example-1',
        fence: 3,
        leaseUntilIso: '2026-10-27T10:02:00.000Z',
      },
    });
  });

  it.each([
    [
      { ...VALID_DRIVER_LEASE, extra: true },
      'ConductorDriverLease must be a record with exactly version, holderId, fence and leaseUntilIso',
    ],
    [
      { version: 2, holderId: 'driver-example-1', fence: 3, leaseUntilIso: VALID_LEASE_ISO },
      'ConductorDriverLease version must be 1',
    ],
    [
      { version: 1, holderId: '', fence: 3, leaseUntilIso: VALID_LEASE_ISO },
      'ConductorDriverLease holderId must be a non-empty id of at most 256 bytes',
    ],
    [
      { version: 1, holderId: fakeSecretShape(), fence: 3, leaseUntilIso: VALID_LEASE_ISO },
      'ConductorDriverLease holderId contains a secret-shaped value and was refused',
    ],
    [
      { version: 1, holderId: 'driver-example-1', fence: 0, leaseUntilIso: VALID_LEASE_ISO },
      'ConductorDriverLease fence must be a positive integer',
    ],
    [
      { version: 1, holderId: 'driver-example-1', fence: 3, leaseUntilIso: '2026-10-27T10:00:00' },
      'ConductorDriverLease leaseUntilIso must be an ISO-8601 time with a zone',
    ],
    [
      { version: 1, holderId: 'driver-example-1', fence: 3, leaseUntilIso: '2026-02-31T10:00:00Z' },
      'ConductorDriverLease leaseUntilIso must be an ISO-8601 time with a zone',
    ],
  ])('refuses %j with the fixed message', (input, message) => {
    const result = readConductorDriverLease(input);
    expect(result).toEqual({ ok: false, error: message });
  });

  it('never throws and refuses unreadable input', () => {
    const proxy = new Proxy(
      { version: 1, holderId: 'driver-example-1', fence: 3, leaseUntilIso: VALID_LEASE_ISO },
      {
        ownKeys() {
          throw new Error('boom');
        },
      },
    );
    const result = readConductorDriverLease(proxy);
    expect(result).toEqual({ ok: false, error: 'ConductorDriverLease input could not be read' });
  });

  it('never echoes a distinctive input or the secret fake', () => {
    const inputs: unknown[] = [
      { version: 'XYZZY', holderId: 'driver-example-1', fence: 3, leaseUntilIso: VALID_LEASE_ISO },
      { version: 1, holderId: 'driver-example-1', fence: 3, leaseUntilIso: VALID_LEASE_ISO, extra: 'XYZZY' },
      { version: 1, holderId: fakeSecretShape(), fence: 3, leaseUntilIso: VALID_LEASE_ISO },
      { version: 1, holderId: 'driver-example-1', fence: 3, leaseUntilIso: 'XYZZY' },
    ];
    for (const input of inputs) {
      const result = readConductorDriverLease(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).not.toContain('XYZZY');
      expect(result.error).not.toContain(fakeSecretShape());
    }
  });

  it('declares the driver lease record version 1', () => {
    expect(CONDUCTOR_DRIVER_LEASE_RECORD_VERSION).toBe(1);
  });
});
