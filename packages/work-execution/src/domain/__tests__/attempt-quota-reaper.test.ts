/**
 * FC8G hostile-input and behaviour tests for the pure per-attempt quota
 * reaper: every hostile shape is a typed fail-closed refusal (never a keep),
 * the reap precedence is fixed, destroyed attempts are idempotently kept,
 * and no input value is ever echoed into a decision.
 */

import { types } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  ATTEMPT_QUOTA_REAP_LIMITS,
  decideAttemptReap,
  MAX_CPU_SECONDS_LIMIT,
  MAX_EGRESS_BYTES_LIMIT,
  MAX_WALL_SECONDS_LIMIT,
} from '../attempt-quota-reaper.js';

/** A revoked Proxy throws on every trap. */
function revokedProxy(): unknown {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

const START = '2026-11-28T00:00:00.000Z';
// Two hours after START, so the wall-time boundary (default limit: 1h) is
// reachable before the lease expires.
const LEASE = '2026-11-28T02:00:00.000Z';
const NOW = '2026-11-28T00:30:00.000Z';

interface AttemptOverrides {
  readonly attemptId?: string;
  readonly startedAtIso?: string;
  readonly leaseExpiresAtIso?: string;
  readonly cpuSeconds?: number;
  readonly egressBytes?: number;
  readonly state?: string;
}

interface InputOverrides {
  readonly attempt?: AttemptOverrides | unknown;
  readonly limits?: Record<string, unknown> | unknown;
  readonly nowIso?: string;
}

function attempt(overrides: AttemptOverrides = {}): Record<string, unknown> {
  return {
    attemptId: 'attempt-1',
    startedAtIso: START,
    leaseExpiresAtIso: LEASE,
    cpuSeconds: 0,
    egressBytes: 0,
    state: 'running',
    ...overrides,
  };
}

function limits(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    maxWallSeconds: 3600,
    maxCpuSeconds: 600,
    maxEgressBytes: 1000,
    ...overrides,
  };
}

function input(overrides: InputOverrides = {}): Record<string, unknown> {
  return {
    attempt: attempt(overrides.attempt as AttemptOverrides | undefined),
    limits: limits(overrides.limits as Record<string, unknown> | undefined),
    nowIso: overrides.nowIso ?? NOW,
  };
}

/** Same as `input` but with a sealed attempt: the other active phase. */
function sealingInput(overrides: AttemptOverrides = {}): Record<string, unknown> {
  return input({ attempt: { state: 'sealing', ...overrides } });
}

function timestamp(msAfterEpochStart: number): string {
  return new Date(Date.parse(START) + msAfterEpochStart).toISOString();
}

describe('decideAttemptReap hostile inputs', () => {
  it('refuses null, undefined, primitives, arrays, and array-likes without throwing', () => {
    for (const hostile of [
      null,
      undefined,
      7,
      'x',
      true,
      [],
      [1, 2, 3],
      { length: 1, 0: 'array-like' },
      () => 1,
    ]) {
      expect(decideAttemptReap(hostile, types.isProxy)).toEqual({
        action: 'refused',
        reason: 'invalid-input',
      });
    }
  });

  it('refuses getter properties on input, attempt, and limits without invoking them', () => {
    let getterRuns = 0;
    const spy = () => {
      getterRuns += 1;
      return 1;
    };

    const rootWithGetter: Record<string, unknown> = input();
    Object.defineProperty(rootWithGetter, 'extra', { get: spy, enumerable: true });
    expect(decideAttemptReap(rootWithGetter, types.isProxy)).toEqual({
      action: 'refused',
      reason: 'invalid-input',
    });

    const attemptWithGetter = input({ attempt: {} }) as Record<string, unknown>;
    const attemptRecord: Record<string, unknown> = attempt({ cpuSeconds: 0 });
    Object.defineProperty(attemptRecord, 'cpuSeconds', { get: spy, enumerable: true });
    attemptWithGetter['attempt'] = attemptRecord;
    expect(decideAttemptReap(attemptWithGetter, types.isProxy)).toEqual({
      action: 'refused',
      reason: 'invalid-input',
    });

    const limitsWithGetter = input() as Record<string, unknown>;
    const limitsRecord: Record<string, unknown> = limits();
    Object.defineProperty(limitsRecord, 'maxCpuSeconds', { get: spy, enumerable: true });
    limitsWithGetter['limits'] = limitsRecord;
    expect(decideAttemptReap(limitsWithGetter, types.isProxy)).toEqual({
      action: 'refused',
      reason: 'invalid-input',
    });

    expect(getterRuns).toBe(0);
  });

  it('refuses Proxy inputs with types.isProxy without running traps and refuses revoked Proxies', () => {
    let trapRuns = 0;
    const trap = (): number => {
      trapRuns += 1;
      return 1;
    };

    const proxiedRoot = new Proxy(input(), {
      get: trap,
      ownKeys: () => [],
      getOwnPropertyDescriptor: () => undefined,
    });
    expect(decideAttemptReap(proxiedRoot, types.isProxy)).toEqual({
      action: 'refused',
      reason: 'invalid-input',
    });

    const shaped = input();
    const proxiedAttempt = new Proxy(shaped['attempt'] as object, { get: trap, ownKeys: () => [] });
    shaped['attempt'] = proxiedAttempt;
    expect(decideAttemptReap(shaped, types.isProxy)).toEqual({
      action: 'refused',
      reason: 'invalid-input',
    });

    const shapedLimits = input();
    const proxiedLimits = new Proxy(shapedLimits['limits'] as object, { get: trap, ownKeys: () => [] });
    shapedLimits['limits'] = proxiedLimits;
    expect(decideAttemptReap(shapedLimits, types.isProxy)).toEqual({
      action: 'refused',
      reason: 'invalid-input',
    });

    expect(trapRuns).toBe(0);
    expect(decideAttemptReap(revokedProxy(), types.isProxy)).toEqual({
      action: 'refused',
      reason: 'invalid-input',
    });
  });

  it('refuses NaN, Infinity, and -0 counters or limits', () => {
    const counterCases = [
      { cpuSeconds: Number.NaN },
      { cpuSeconds: Number.POSITIVE_INFINITY },
      { cpuSeconds: Number.NEGATIVE_INFINITY },
      { cpuSeconds: -0 },
      { egressBytes: Number.NaN },
      { egressBytes: -0 },
    ];
    for (const overrides of counterCases) {
      expect(decideAttemptReap(input({ attempt: overrides }), types.isProxy)).toEqual({
        action: 'refused',
        reason: 'invalid-input',
      });
    }
    const limitCases = [
      { maxWallSeconds: Number.NaN },
      { maxCpuSeconds: Number.POSITIVE_INFINITY },
      { maxEgressBytes: -0 },
    ];
    for (const overrides of limitCases) {
      expect(decideAttemptReap(input({ limits: overrides }), types.isProxy)).toEqual({
        action: 'refused',
        reason: 'invalid-input',
      });
    }
  });

  it('refuses prototype-polluting keys, symbol keys, and extra or missing keys', () => {
    // Prototype-polluting own keys on the root of a running attempt with a
    // readable attemptId: reaped as invalid-input (never kept).
    const pollutedRoot: Record<string, unknown> = { ...input(), ['__proto__']: { x: 1 } };
    expect(decideAttemptReap(pollutedRoot, types.isProxy)).toEqual({
      action: 'reap',
      reason: 'invalid-input',
    });
    const pollutedRootCtor: Record<string, unknown> = { ...input(), constructor: {} };
    expect(decideAttemptReap(pollutedRootCtor, types.isProxy)).toEqual({
      action: 'reap',
      reason: 'invalid-input',
    });
    const pollutedAttempt: Record<string, unknown> = input();
    pollutedAttempt['attempt'] = { ...attempt(), ['__proto__']: { x: 1 } };
    // A running attempt with a readable attemptId reaps on any post-snapshot
    // validation failure, including an extra polluting key on `attempt`.
    expect(decideAttemptReap(pollutedAttempt, types.isProxy)).toEqual({
      action: 'reap',
      reason: 'invalid-input',
    });
    // But an unreadable attemptId or a destroyed state refuses instead.
    const pollutedAttemptBadId: Record<string, unknown> = input();
    pollutedAttemptBadId['attempt'] = { ...attempt(), attemptId: 7, ['__proto__']: { x: 1 } };
    expect(decideAttemptReap(pollutedAttemptBadId, types.isProxy)).toEqual({
      action: 'refused',
      reason: 'invalid-input',
    });
    const pollutedAttemptDestroyed: Record<string, unknown> = input();
    pollutedAttemptDestroyed['attempt'] = { ...attempt({ state: 'destroyed' }), ['__proto__']: { x: 1 } };
    expect(decideAttemptReap(pollutedAttemptDestroyed, types.isProxy)).toEqual({
      action: 'refused',
      reason: 'invalid-input',
    });
    const pollutedLimits: Record<string, unknown> = input();
    pollutedLimits['limits'] = { ...limits(), prototype: {} };
    expect(decideAttemptReap(pollutedLimits, types.isProxy)).toEqual({
      action: 'reap',
      reason: 'invalid-input',
    });

    // Symbol keys: refused by the snapshot.
    const symbolRoot: Record<string, unknown> = input();
    Object.defineProperty(symbolRoot, Symbol('extra'), { value: 1, enumerable: true });
    expect(decideAttemptReap(symbolRoot, types.isProxy)).toEqual({
      action: 'refused',
      reason: 'invalid-input',
    });

    // Extra and missing keys on each object.
    const extraRoot: Record<string, unknown> = input();
    extraRoot['extra'] = 1;
    expect(decideAttemptReap(extraRoot, types.isProxy)).toEqual({
      action: 'reap',
      reason: 'invalid-input',
    });
    const missingRoot: Record<string, unknown> = input();
    delete missingRoot['nowIso'];
    expect(decideAttemptReap(missingRoot, types.isProxy)).toEqual({
      action: 'reap',
      reason: 'invalid-input',
    });

    // Root-level key failures follow the same rule as every other post-snapshot
    // failure: a running attempt with a readable attemptId reaps, while a
    // destroyed attempt is refused.
    const destroyedExtraRoot: Record<string, unknown> = input({ attempt: { state: 'destroyed' } });
    destroyedExtraRoot['extra'] = 1;
    expect(decideAttemptReap(destroyedExtraRoot, types.isProxy)).toEqual({
      action: 'refused',
      reason: 'invalid-input',
    });
    const sealingMissingRoot: Record<string, unknown> = input({ attempt: { state: 'sealing' } });
    delete sealingMissingRoot['limits'];
    expect(decideAttemptReap(sealingMissingRoot, types.isProxy)).toEqual({
      action: 'reap',
      reason: 'invalid-input',
    });

    // Missing attempt keys with a readable attemptId and running state reaps.
    const missingAttemptKey = input();
    const attemptWithoutLease: Record<string, unknown> = attempt();
    delete attemptWithoutLease['leaseExpiresAtIso'];
    missingAttemptKey['attempt'] = attemptWithoutLease;
    expect(decideAttemptReap(missingAttemptKey, types.isProxy)).toEqual({
      action: 'reap',
      reason: 'invalid-input',
    });

    // Missing limits keys likewise reap when the attempt is readable.
    const missingLimitKey = input();
    const limitsWithoutEgress: Record<string, unknown> = limits();
    delete limitsWithoutEgress['maxEgressBytes'];
    missingLimitKey['limits'] = limitsWithoutEgress;
    expect(decideAttemptReap(missingLimitKey, types.isProxy)).toEqual({
      action: 'reap',
      reason: 'invalid-input',
    });

    // But the same missing keys on a destroyed attempt are refused.
    const destroyedMissingLimit = input({ attempt: { state: 'destroyed' } });
    destroyedMissingLimit['limits'] = limitsWithoutEgress;
    expect(decideAttemptReap(destroyedMissingLimit, types.isProxy)).toEqual({
      action: 'refused',
      reason: 'invalid-input',
    });

    // Extra attempt keys when attemptId or state is missing or invalid: refused.
    const badAttemptId: Record<string, unknown> = input();
    badAttemptId['attempt'] = { ...attempt(), attemptId: 7, extra: 1 };
    expect(decideAttemptReap(badAttemptId, types.isProxy)).toEqual({
      action: 'refused',
      reason: 'invalid-input',
    });
  });

  it('refuses unknown or non-reaper attempt states rather than treating them as keep', () => {
    for (const state of ['none', 'created', 'loaded', 'sealed', 'failed', 'running ', 'Running', '']) {
      expect(decideAttemptReap(input({ attempt: { state } }), types.isProxy)).toEqual({
        action: 'refused',
        reason: 'invalid-input',
      });
    }
    expect(decideAttemptReap(input({ attempt: { state: 7 } }), types.isProxy)).toEqual({
      action: 'refused',
      reason: 'invalid-input',
    });
  });

  it('reaps with invalid-input when a running or sealing attempt has a readable attemptId and negative, fractional, out-of-bounds, bad-timestamp, or clock-before-start values', () => {
    const fieldCases: Array<AttemptOverrides> = [
      { cpuSeconds: -1 },
      { cpuSeconds: 1.5 },
      { egressBytes: -1 },
      { egressBytes: 0.5 },
      { startedAtIso: 'not-a-timestamp' },
      { startedAtIso: '2026-02-30T00:00:00.000Z' },
      { leaseExpiresAtIso: '2026-13-01T00:00:00.000Z' },
      { leaseExpiresAtIso: 7 as unknown as string },
    ];
    for (const overrides of fieldCases) {
      expect(decideAttemptReap(input({ attempt: overrides }), types.isProxy)).toEqual({
        action: 'reap',
        reason: 'invalid-input',
      });
      expect(
        decideAttemptReap(input({ attempt: { state: 'sealing', ...overrides } }), types.isProxy),
      ).toEqual({ action: 'reap', reason: 'invalid-input' });
    }

    const limitCases = [
      { maxWallSeconds: 0 },
      { maxWallSeconds: -5 },
      { maxWallSeconds: 1.5 },
      { maxWallSeconds: MAX_WALL_SECONDS_LIMIT + 1 },
      { maxCpuSeconds: 0 },
      { maxCpuSeconds: MAX_CPU_SECONDS_LIMIT + 1 },
      { maxEgressBytes: -1 },
      { maxEgressBytes: MAX_EGRESS_BYTES_LIMIT + 1 },
    ];
    for (const limitOverrides of limitCases) {
      expect(
        decideAttemptReap(input({ limits: limitOverrides }), types.isProxy),
      ).toEqual({ action: 'reap', reason: 'invalid-input' });
      expect(
        decideAttemptReap(
          input({ attempt: { state: 'sealing' }, limits: limitOverrides }),
          types.isProxy,
        ),
      ).toEqual({ action: 'reap', reason: 'invalid-input' });
    }

    // Clock before start.
    expect(
      decideAttemptReap(input({ nowIso: '2026-11-27T23:59:59.999Z' }), types.isProxy),
    ).toEqual({ action: 'reap', reason: 'invalid-input' });
  });

  it('refuses a destroyed attempt when limits, timestamps, or counters are invalid', () => {
    const destroyedCases: AttemptOverrides[] = [
      { cpuSeconds: -1 },
      { egressBytes: 2.5 },
      { startedAtIso: 'nope' },
      { leaseExpiresAtIso: '2026-02-30T00:00:00.000Z' },
    ];
    for (const overrides of destroyedCases) {
      expect(decideAttemptReap(input({ attempt: { state: 'destroyed', ...overrides } }), types.isProxy)).toEqual({
        action: 'refused',
        reason: 'invalid-input',
      });
    }
    expect(
      decideAttemptReap(input({ attempt: { state: 'destroyed' }, limits: { maxCpuSeconds: 0 } }), types.isProxy),
    ).toEqual({ action: 'refused', reason: 'invalid-input' });
    expect(
      decideAttemptReap(input({ attempt: { state: 'destroyed' }, nowIso: 'bad' }), types.isProxy),
    ).toEqual({ action: 'refused', reason: 'invalid-input' });
  });

  it('never echoes supplied input values in any reap or refusal result', () => {
    const secretInput = input({
      attempt: { attemptId: 'SECRET-attempt-424242', cpuSeconds: 987654321, startedAtIso: '2020-01-01T00:00:00.000Z' },
      nowIso: '2019-01-01T00:00:00.000Z',
    });
    const decisions = [
      decideAttemptReap(secretInput, types.isProxy),
      decideAttemptReap(null, types.isProxy),
      decideAttemptReap(input({ attempt: { state: 'destroyed' } }), types.isProxy),
      decideAttemptReap(new Proxy({}, {}), types.isProxy),
    ];
    for (const decision of decisions) {
      const rendered = JSON.stringify(decision);
      expect(rendered).not.toContain('SECRET-attempt-424242');
      expect(rendered).not.toContain('424242');
      expect(rendered).not.toContain('987654321');
      expect(rendered).not.toContain('2019-01-01');
      expect(rendered).not.toContain('2020-01-01');
      expect(Object.isFrozen(decision)).toBe(true);
    }
  });
});

describe('decideAttemptReap boundaries and precedence', () => {
  it('keeps when wall time, cpuSeconds, and egressBytes equal their limits and nowIso is before leaseExpiresAtIso', () => {
    // One millisecond before the wall limit, counters exactly at their limits.
    const decision = decideAttemptReap(
      input({
        attempt: { cpuSeconds: 600, egressBytes: 1000 },
        nowIso: timestamp(3600 * 1000 - 1),
      }),
      types.isProxy,
    );
    expect(decision).toEqual({ action: 'keep' });
  });

  it('reaps with lease-expired at the exact leaseExpiresAtIso instant', () => {
    expect(decideAttemptReap(input({ nowIso: LEASE }), types.isProxy)).toEqual({
      action: 'reap',
      reason: 'lease-expired',
    });
    expect(decideAttemptReap(input({ nowIso: '2026-11-28T02:00:00.001Z' }), types.isProxy)).toEqual({
      action: 'reap',
      reason: 'lease-expired',
    });
  });

  it('reaps with wall-time when elapsed exceeds maxWallSeconds by one unit', () => {
    // One second past the wall limit, still before the lease.
    expect(
      decideAttemptReap(input({ nowIso: timestamp(3600 * 1000 + 1000) }), types.isProxy),
    ).toEqual({ action: 'reap', reason: 'wall-time' });
    // One millisecond past the wall limit.
    expect(
      decideAttemptReap(input({ nowIso: timestamp(3600 * 1000 + 1) }), types.isProxy),
    ).toEqual({ action: 'reap', reason: 'wall-time' });
    // Exactly at the wall limit is keep.
    expect(decideAttemptReap(input({ nowIso: timestamp(3600 * 1000) }), types.isProxy)).toEqual({
      action: 'keep',
    });
  });

  it('reaps with cpu-quota when cpuSeconds exceeds maxCpuSeconds by one', () => {
    expect(decideAttemptReap(input({ attempt: { cpuSeconds: 601 } }), types.isProxy)).toEqual({
      action: 'reap',
      reason: 'cpu-quota',
    });
    expect(decideAttemptReap(input({ attempt: { cpuSeconds: 600 } }), types.isProxy)).toEqual({
      action: 'keep',
    });
  });

  it('reaps with egress-quota when egressBytes exceeds maxEgressBytes by one', () => {
    expect(decideAttemptReap(input({ attempt: { egressBytes: 1001 } }), types.isProxy)).toEqual({
      action: 'reap',
      reason: 'egress-quota',
    });
    expect(decideAttemptReap(input({ attempt: { egressBytes: 1000 } }), types.isProxy)).toEqual({
      action: 'keep',
    });
  });

  it('applies fixed precedence lease-expired > wall-time > cpu-quota > egress-quota when all four apply', () => {
    const all = input({
      attempt: { cpuSeconds: 9999, egressBytes: 9999 },
      nowIso: LEASE,
    });
    expect(decideAttemptReap(all, types.isProxy)).toEqual({ action: 'reap', reason: 'lease-expired' });

    const noLease = input({
      attempt: { cpuSeconds: 9999, egressBytes: 9999 },
      nowIso: timestamp(3600 * 1000 + 1),
    });
    expect(decideAttemptReap(noLease, types.isProxy)).toEqual({ action: 'reap', reason: 'wall-time' });

    const noWall = input({ attempt: { cpuSeconds: 9999, egressBytes: 9999 } });
    expect(decideAttemptReap(noWall, types.isProxy)).toEqual({ action: 'reap', reason: 'cpu-quota' });

    const onlyEgress = input({ attempt: { egressBytes: 9999 } });
    expect(decideAttemptReap(onlyEgress, types.isProxy)).toEqual({ action: 'reap', reason: 'egress-quota' });
  });

  it('keeps a valid destroyed attempt idempotently even when lease is expired and all quotas are exceeded', () => {
    const destroyed = input({
      attempt: { state: 'destroyed', cpuSeconds: 9999, egressBytes: 9999 },
      nowIso: '2026-12-30T00:00:00.000Z',
    });
    expect(decideAttemptReap(destroyed, types.isProxy)).toEqual({ action: 'keep' });
  });

  it('keeps a valid sealing attempt the same way it keeps a running one', () => {
    expect(decideAttemptReap(sealingInput(), types.isProxy)).toEqual({ action: 'keep' });
    expect(decideAttemptReap(input(), types.isProxy)).toEqual({ action: 'keep' });
  });

  it('bounds the snapshot with the declared domain-sized limits', () => {
    expect(ATTEMPT_QUOTA_REAP_LIMITS).toEqual({
      maxDepth: 4,
      maxKeys: 16,
      maxArrayLength: 0,
      maxNodes: 32,
      maxStringLength: 256,
    });
  });
});
