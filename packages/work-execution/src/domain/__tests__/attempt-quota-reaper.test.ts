/**
 * FC8G hostile-input and behaviour tests for the per-attempt quota reaper
 * decider: the input is read exactly once through `snapshotPlainData`,
 * hostile values are refused without running getters or Proxy traps, an
 * unreadable or invalid input is never `keep`, and every result is a literal
 * that echoes no supplied value.
 */

import { describe, expect, it } from 'vitest';
import { types } from 'node:util';

import {
  decideAttemptReap,
  MAX_CPU_SECONDS_LIMIT,
  MAX_EGRESS_BYTES_LIMIT,
  MAX_WALL_SECONDS_LIMIT,
} from '../attempt-quota-reaper.js';

const START = '2026-11-26T00:00:00.000Z';
const LEASE = '2026-11-26T02:00:00.000Z';
const NOW = '2026-11-26T00:30:00.000Z';

const BASE_LIMITS = { maxWallSeconds: 3600, maxCpuSeconds: 100, maxEgressBytes: 1000 };

function attemptRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    attemptId: 'a1',
    startedAtIso: START,
    leaseExpiresAtIso: LEASE,
    cpuSeconds: 10,
    egressBytes: 100,
    state: 'running',
    ...overrides,
  };
}

/** A valid input that would be kept under every quota. */
function keepInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    attempt: attemptRecord(overrides.attempt as Record<string, unknown> | undefined),
    limits: { ...BASE_LIMITS, ...(overrides.limits as Record<string, unknown> | undefined) },
    nowIso: overrides.nowIso === undefined ? NOW : overrides.nowIso,
  };
}

/** A revoked Proxy throws on every trap, including [[GetPrototypeOf]]. */
function revokedProxy(): unknown {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

/** Replaces one key of the valid input at the top level. */
function withRoot(key: string, value: unknown): Record<string, unknown> {
  const input = keepInput();
  if (key === '__proto__') {
    Object.defineProperty(input, '__proto__', { value, enumerable: true, writable: true, configurable: true });
    return input;
  }
  input[key] = value;
  return input;
}

/** Replaces one key inside `attempt`. */
function withAttempt(key: string, value: unknown): Record<string, unknown> {
  const input = keepInput();
  if (key === '__proto__') {
    const attempt = input['attempt'] as Record<string, unknown>;
    Object.defineProperty(attempt, '__proto__', { value, enumerable: true, writable: true, configurable: true });
    return input;
  }
  (input['attempt'] as Record<string, unknown>)[key] = value;
  return input;
}

/** Replaces one key inside `limits`. */
function withLimits(key: string, value: unknown): Record<string, unknown> {
  const input = keepInput();
  (input['limits'] as Record<string, unknown>)[key] = value;
  return input;
}

/** Builds an input from raw key/value pairs, so `__proto__` can be a literal own data key. */

describe('decideAttemptReap boundaries and precedence', () => {
  it('keeps when wall time, cpuSeconds, and egressBytes equal their limits and nowIso is before leaseExpiresAtIso', () => {
    const input = keepInput({
      limits: { maxWallSeconds: 1800, maxCpuSeconds: 10, maxEgressBytes: 100 },
    });
    expect(decideAttemptReap(input)).toEqual({ action: 'keep' });
    expect(decideAttemptReap(keepInput())).toEqual({ action: 'keep' });
  });

  it('reaps with lease-expired at the exact leaseExpiresAtIso instant', () => {
    expect(decideAttemptReap(keepInput({ nowIso: LEASE }))).toEqual({
      action: 'reap',
      reason: 'lease-expired',
    });
  });

  it('reaps with wall-time when elapsed exceeds maxWallSeconds by one unit', () => {
    // one millisecond over the wall limit
    const msOver = keepInput({
      limits: { maxWallSeconds: 1799, maxCpuSeconds: 10_000, maxEgressBytes: 10_000 },
    });
    expect(decideAttemptReap(msOver)).toEqual({ action: 'reap', reason: 'wall-time' });
    // exactly one second over, with an integral-second clock reading
    const sOver = keepInput({
      limits: { maxWallSeconds: 1799, maxCpuSeconds: 10_000, maxEgressBytes: 10_000 },
      nowIso: '2026-11-26T00:30:01.000Z',
    });
    expect(decideAttemptReap(sOver)).toEqual({ action: 'reap', reason: 'wall-time' });
  });

  it('reaps with cpu-quota when cpuSeconds exceeds maxCpuSeconds by one', () => {
    expect(
      decideAttemptReap(keepInput({ attempt: { cpuSeconds: 101 } })),
    ).toEqual({ action: 'reap', reason: 'cpu-quota' });
  });

  it('reaps with egress-quota when egressBytes exceeds maxEgressBytes by one', () => {
    expect(
      decideAttemptReap(keepInput({ attempt: { egressBytes: 1001 } })),
    ).toEqual({ action: 'reap', reason: 'egress-quota' });
  });

  it('applies fixed precedence lease-expired > wall-time > cpu-quota > egress-quota when all four apply', () => {
    const all = keepInput({
      attempt: { cpuSeconds: 999, egressBytes: 999 },
      limits: { maxWallSeconds: 60, maxCpuSeconds: 1, maxEgressBytes: 1 },
      nowIso: LEASE,
    });
    expect(decideAttemptReap(all)).toEqual({ action: 'reap', reason: 'lease-expired' });

    const noLease = keepInput({
      attempt: { cpuSeconds: 999, egressBytes: 999 },
      limits: { maxWallSeconds: 60, maxCpuSeconds: 1, maxEgressBytes: 1 },
    });
    expect(decideAttemptReap(noLease)).toEqual({ action: 'reap', reason: 'wall-time' });

    const noWall = keepInput({
      attempt: { cpuSeconds: 999, egressBytes: 999 },
      limits: { maxWallSeconds: 3600, maxCpuSeconds: 1, maxEgressBytes: 1 },
    });
    expect(decideAttemptReap(noWall)).toEqual({ action: 'reap', reason: 'cpu-quota' });

    const noCpu = keepInput({
      attempt: { egressBytes: 999 },
      limits: { maxWallSeconds: 3600, maxCpuSeconds: 100, maxEgressBytes: 1 },
    });
    expect(decideAttemptReap(noCpu)).toEqual({ action: 'reap', reason: 'egress-quota' });
  });

  it('keeps a valid destroyed attempt idempotently even when lease is expired and all quotas are exceeded', () => {
    const destroyed = keepInput({
      attempt: { state: 'destroyed', cpuSeconds: 999_999, egressBytes: 999_999 },
      nowIso: '2027-01-01T00:00:00.000Z',
    });
    expect(decideAttemptReap(destroyed)).toEqual({ action: 'keep' });
  });

  it('keeps a sealing attempt within quotas like a running one', () => {
    expect(decideAttemptReap(keepInput({ attempt: { state: 'sealing' } }))).toEqual({
      action: 'keep',
    });
  });
});

describe('decideAttemptReap hostile inputs', () => {
  it('refuses null, undefined, primitives, arrays, and array-likes without throwing', () => {
    for (const bad of [
      null,
      undefined,
      7,
      'x',
      true,
      Symbol('s'),
      [],
      ['a'],
      { length: 1, 0: {} },
      new Map(),
    ]) {
      expect(decideAttemptReap(bad)).toEqual({ action: 'refused', reason: 'invalid-input' });
    }
  });

  it('refuses getter properties on input, attempt, and limits without invoking them', () => {
    let getterRuns = 0;
    const getter = () => {
      getterRuns += 1;
      return 1;
    };

    const onRoot = keepInput();
    Object.defineProperty(onRoot, 'nowIso', { get: getter, enumerable: true });
    expect(decideAttemptReap(onRoot)).toEqual({ action: 'refused', reason: 'invalid-input' });

    const onAttempt = keepInput();
    Object.defineProperty(onAttempt['attempt'], 'cpuSeconds', { get: getter, enumerable: true });
    expect(decideAttemptReap(onAttempt)).toEqual({ action: 'refused', reason: 'invalid-input' });

    const onLimits = keepInput();
    Object.defineProperty(onLimits['limits'], 'maxCpuSeconds', { get: getter, enumerable: true });
    expect(decideAttemptReap(onLimits)).toEqual({ action: 'refused', reason: 'invalid-input' });

    expect(getterRuns).toBe(0);
  });

  it('refuses Proxy inputs with types.isProxy without running traps and refuses revoked Proxies', () => {
    let traps = 0;
    const counting = (target: object): unknown =>
      new Proxy(target, {
        get: (t, k) => {
          traps += 1;
          return Reflect.get(t, k);
        },
        has: (t, k) => {
          traps += 1;
          return Reflect.has(t, k);
        },
        ownKeys: (t) => {
          traps += 1;
          return Reflect.ownKeys(t);
        },
        getOwnPropertyDescriptor: (t, k) => {
          traps += 1;
          return Reflect.getOwnPropertyDescriptor(t, k);
        },
      });

    expect(decideAttemptReap(counting(keepInput()), types.isProxy)).toEqual({
      action: 'refused',
      reason: 'invalid-input',
    });
    expect(traps).toBe(0);

    const nested = keepInput();
    nested['attempt'] = counting(attemptRecord());
    expect(decideAttemptReap(nested, types.isProxy)).toEqual({
      action: 'refused',
      reason: 'invalid-input',
    });
    expect(traps).toBe(0);

    expect(decideAttemptReap(revokedProxy(), types.isProxy)).toEqual({
      action: 'refused',
      reason: 'invalid-input',
    });
  });

  it('refuses NaN, Infinity, and -0 counters or limits from the single snapshot', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0]) {
      expect(decideAttemptReap(withAttempt('cpuSeconds', bad))).toEqual({
        action: 'refused',
        reason: 'invalid-input',
      });
      expect(decideAttemptReap(withAttempt('egressBytes', bad))).toEqual({
        action: 'refused',
        reason: 'invalid-input',
      });
      expect(decideAttemptReap(withLimits('maxWallSeconds', bad))).toEqual({
        action: 'refused',
        reason: 'invalid-input',
      });
      expect(decideAttemptReap(withLimits('maxCpuSeconds', bad))).toEqual({
        action: 'refused',
        reason: 'invalid-input',
      });
      expect(decideAttemptReap(withLimits('maxEgressBytes', bad))).toEqual({
        action: 'refused',
        reason: 'invalid-input',
      });
    }
  });

  it('refuses prototype-polluting keys, symbol keys, and extra or missing keys', () => {
    const refusedShape = { action: 'refused', reason: 'invalid-input' };

    // own __proto__ data key at the root: with a running attempt this is a
    // post-snapshot extra-key failure, so it reaps
    expect(decideAttemptReap(withRoot('__proto__', { polluted: true }))).toEqual({
      action: 'reap',
      reason: 'invalid-input',
    });
    // own __proto__ data key inside limits, with a destroyed attempt: refused
    const destroyedProtoLimits = keepInput({ attempt: { state: 'destroyed' } });
    Object.defineProperty(destroyedProtoLimits['limits'], '__proto__', {
      value: {},
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expect(decideAttemptReap(destroyedProtoLimits)).toEqual(refusedShape);
    // prototype-polluting named keys as extra keys (running attempt → reap)
    expect(decideAttemptReap(withRoot('constructor', 1))).toEqual({
      action: 'reap',
      reason: 'invalid-input',
    });
    expect(decideAttemptReap(withLimits('prototype', 1))).toEqual({
      action: 'reap',
      reason: 'invalid-input',
    });

    // symbol key on limits
    const withSymbol = keepInput();
    Reflect.defineProperty(withSymbol['limits'] as object, Symbol.for('k'), { value: 1, enumerable: true });
    expect(decideAttemptReap(withSymbol)).toEqual(refusedShape);

    // non-enumerable key
    const hidden = keepInput();
    Object.defineProperty(hidden, 'hidden', { value: 1, enumerable: false });
    expect(decideAttemptReap(hidden)).toEqual(refusedShape);

    // extra and missing keys at each level: with a valid running attempt all
    // of these are post-snapshot validation failures, so they reap
    const reapedInvalid = { action: 'reap', reason: 'invalid-input' };
    expect(decideAttemptReap(withRoot('extra', 1))).toEqual(reapedInvalid);
    expect(decideAttemptReap(withAttempt('extra', 1))).toEqual(reapedInvalid);
    expect(decideAttemptReap(withLimits('extra', 1))).toEqual(reapedInvalid);

    const missingRoot = keepInput();
    delete missingRoot['nowIso'];
    expect(decideAttemptReap(missingRoot)).toEqual(reapedInvalid);

    const missingAttemptKey = keepInput();
    delete (missingAttemptKey['attempt'] as Record<string, unknown>)['cpuSeconds'];
    expect(decideAttemptReap(missingAttemptKey)).toEqual(reapedInvalid);

    const missingLimitsKey = keepInput();
    delete (missingLimitsKey['limits'] as Record<string, unknown>)['maxEgressBytes'];
    expect(decideAttemptReap(missingLimitsKey)).toEqual(reapedInvalid);

    // the same key failures on a destroyed attempt are refused instead
    const destroyedMissingNow = keepInput({ attempt: { state: 'destroyed' } });
    delete destroyedMissingNow['nowIso'];
    expect(decideAttemptReap(destroyedMissingNow)).toEqual(refusedShape);
  });

  it('refuses unknown or non-reaper attempt states rather than treating them as keep', () => {
    for (const state of ['none', 'created', 'loaded', 'sealed', 'failed', '', 'RUNNING', 7, null, true]) {
      expect(decideAttemptReap(withAttempt('state', state))).toEqual({
        action: 'refused',
        reason: 'invalid-input',
      });
    }
  });

  it('reaps with invalid-input when a running or sealing attempt has a readable attemptId and negative, fractional, out-of-bounds, bad-timestamp, or clock-before-start values', () => {
    const reapedInvalid = { action: 'reap', reason: 'invalid-input' };
    const badValues: unknown[] = [
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      '10',
      null,
    ];
    for (const bad of badValues) {
      expect(decideAttemptReap(withAttempt('cpuSeconds', bad))).toEqual(reapedInvalid);
      expect(decideAttemptReap(withAttempt('egressBytes', bad))).toEqual(reapedInvalid);
      expect(decideAttemptReap(withLimits('maxWallSeconds', bad))).toEqual(reapedInvalid);
      expect(decideAttemptReap(withLimits('maxCpuSeconds', bad))).toEqual(reapedInvalid);
      expect(decideAttemptReap(withLimits('maxEgressBytes', bad))).toEqual(reapedInvalid);
    }
    // limits above their exported upper bounds
    expect(decideAttemptReap(withLimits('maxWallSeconds', MAX_WALL_SECONDS_LIMIT + 1))).toEqual(reapedInvalid);
    expect(decideAttemptReap(withLimits('maxCpuSeconds', MAX_CPU_SECONDS_LIMIT + 1))).toEqual(reapedInvalid);
    expect(decideAttemptReap(withLimits('maxEgressBytes', MAX_EGRESS_BYTES_LIMIT + 1))).toEqual(reapedInvalid);
    // limit of zero is not positive
    expect(decideAttemptReap(withLimits('maxCpuSeconds', 0))).toEqual(reapedInvalid);

    for (const badIso of [
      '2026-11-26 00:00:00Z',
      '2026-13-01T00:00:00Z',
      '2026-02-30T00:00:00Z',
      '2026-11-26T24:00:00Z',
      'not-a-time',
      12345,
      '2026-11-26T00:00:00+00:00',
      '2026-11-26T00:00:00.000001Z',
    ]) {
      expect(decideAttemptReap(withAttempt('startedAtIso', badIso))).toEqual(reapedInvalid);
      expect(decideAttemptReap(withAttempt('leaseExpiresAtIso', badIso))).toEqual(reapedInvalid);
      expect(decideAttemptReap(withRoot('nowIso', badIso))).toEqual(reapedInvalid);
    }

    // clock before start
    expect(
      decideAttemptReap(keepInput({ nowIso: '2026-11-25T23:59:59.999Z' })),
    ).toEqual(reapedInvalid);

    // sealing behaves like running for post-snapshot failures
    expect(
      decideAttemptReap(keepInput({ attempt: { state: 'sealing', cpuSeconds: -1 } })),
    ).toEqual(reapedInvalid);
  });

  it('refuses a destroyed attempt when limits, timestamps, or counters are invalid', () => {
    const refusedShape = { action: 'refused', reason: 'invalid-input' };
    const destroyed = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
      keepInput({
        attempt: { state: 'destroyed', ...(overrides.attempt as Record<string, unknown> | undefined) },
        ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== 'attempt')),
      });
    expect(decideAttemptReap(destroyed({ limits: { maxCpuSeconds: -1 } }))).toEqual(refusedShape);
    expect(decideAttemptReap(destroyed({ attempt: { cpuSeconds: -1 } }))).toEqual(refusedShape);
    expect(decideAttemptReap(destroyed({ attempt: { startedAtIso: 'bad' } }))).toEqual(refusedShape);
    expect(decideAttemptReap(destroyed({ nowIso: 'bad' }))).toEqual(refusedShape);
    // missing root key with destroyed attempt
    const missingNow = keepInput({ attempt: { state: 'destroyed' } });
    delete missingNow['nowIso'];
    expect(decideAttemptReap(missingNow)).toEqual(refusedShape);
    // extra attempt key with a destroyed attempt: refused, never keep
    const destroyedExtra = keepInput({ attempt: { state: 'destroyed' } });
    (destroyedExtra['attempt'] as Record<string, unknown>)['extra'] = 1;
    expect(decideAttemptReap(destroyedExtra)).toEqual(refusedShape);
    const badId = keepInput({ attempt: { state: 'destroyed', attemptId: 'not ok!' } });
    expect(decideAttemptReap(badId)).toEqual(refusedShape);
  });

  it('refuses invalid attemptId shapes', () => {
    for (const id of ['', '  ', 'has space', 'has/slash', 'has+plus', 7, null, {}, 'x'.repeat(129)]) {
      expect(decideAttemptReap(withAttempt('attemptId', id))).toEqual({
        action: 'refused',
        reason: 'invalid-input',
      });
    }
    expect(decideAttemptReap({ ...keepInput(), attempt: 'nope' })).toEqual({
      action: 'refused',
      reason: 'invalid-input',
    });
    expect(decideAttemptReap({ ...keepInput(), limits: 'nope' })).toEqual({
      action: 'refused',
      reason: 'invalid-input',
    });
  });

  it('never echoes supplied input values in any reap or refusal result', () => {
    const weirdId = 'secret-id-🦠';
    const weirdTime = '2026-11-26T00:00:00.077Z';
    const results = [
      decideAttemptReap(keepInput({ attempt: { attemptId: weirdId, startedAtIso: weirdTime } })),
      decideAttemptReap(withAttempt('attemptId', weirdId)),
      decideAttemptReap(withAttempt('cpuSeconds', -42)),
      decideAttemptReap(withRoot('nowIso', weirdTime)),
      decideAttemptReap(withLimits('maxEgressBytes', 987654321)),
      decideAttemptReap(keepInput({ nowIso: LEASE })),
      decideAttemptReap(null),
    ];
    for (const result of results) {
      expect(JSON.stringify(result)).not.toContain('secret-id');
      expect(JSON.stringify(result)).not.toContain('077');
      expect(JSON.stringify(result)).not.toContain('42');
      expect(JSON.stringify(result)).not.toContain('987654321');
    }
  });

  it('uses the injected isProxy as a separate positional parameter, defaulting to a no-op detector', () => {
    // default detector accepts the plain input
    expect(decideAttemptReap(keepInput())).toEqual({ action: 'keep' });
    // a detector claiming everything is a Proxy refuses, and is not read as a field
    const alwaysProxy = () => true;
    expect(decideAttemptReap(keepInput(), alwaysProxy)).toEqual({
      action: 'refused',
      reason: 'invalid-input',
    });
  });

  it('accepts strings up to the snapshot bounds and refuses oversized strings via the snapshot', () => {
    // a 128-char attemptId fits the regex bound
    expect(decideAttemptReap(withAttempt('attemptId', 'a'.repeat(128)))).toEqual({ action: 'keep' });
    // a > 256-char string is refused by the snapshot's maxStringLength
    expect(decideAttemptReap(withAttempt('attemptId', 'a'.repeat(300)))).toEqual({
      action: 'refused',
      reason: 'invalid-input',
    });
  });
});
