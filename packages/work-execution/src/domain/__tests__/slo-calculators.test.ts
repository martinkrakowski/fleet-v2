/**
 * FC13A hostile-input and behaviour tests for the pure SLO latency
 * calculators: every function takes `unknown`, never throws, and every
 * refusal is the typed reason — an unknown state is never an implicit pass.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_SLO_SAMPLES,
  percentileNearestRank,
  summariseAdmissionSlo,
  summariseParkNotifySlo,
} from '../slo-calculators.js';

/** A revoked Proxy throws on every trap, including [[GetPrototypeOf]]. */
function revokedProxy(): unknown {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

/** A Proxy whose `ownKeys` trap throws (and records that it was reached). */
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
      throw new Error('ownKeys must never be reached');
    },
  });
}

/** A Proxy lying about its own `length` data descriptor value. */
function proxyWithLength(target: number[], length: number): unknown {
  return new Proxy(target, {
    getOwnPropertyDescriptor(t, prop) {
      const descriptor = Reflect.getOwnPropertyDescriptor(t, prop);
      if (prop === 'length' && descriptor !== undefined) {
        return { ...descriptor, value: length };
      }
      return descriptor;
    },
  });
}

function admissionSample(requestedAtIso: string, admittedAtIso: string): unknown {
  return { requestedAtIso, admittedAtIso };
}

function parkSample(parkedAtIso: string, notifiedAtIso: string | null | undefined): unknown {
  return { parkedAtIso, notifiedAtIso };
}

describe('percentileNearestRank', () => {
  it('picks the nearest-rank element from a fixed list (p50 of [10,20,30,40] is 20, p95 is 40)', () => {
    expect(percentileNearestRank([10, 20, 30, 40], 50)).toEqual({ ok: true, valueMs: 20 });
    expect(percentileNearestRank([10, 20, 30, 40], 95)).toEqual({ ok: true, valueMs: 40 });
  });

  it('picks the last element at p = 100 and the only sample in a 1-sample list, counting duplicates', () => {
    expect(percentileNearestRank([10, 20, 30, 40], 100)).toEqual({ ok: true, valueMs: 40 });
    expect(percentileNearestRank([7], 95)).toEqual({ ok: true, valueMs: 7 });
    expect(percentileNearestRank([5, 5, 5], 50)).toEqual({ ok: true, valueMs: 5 });
    expect(percentileNearestRank([1, 9, 9, 9], 50)).toEqual({ ok: true, valueMs: 9 });
  });

  it('leaves the caller array order unchanged (no input mutation)', () => {
    const callerArray = [40, 10, 30, 20];
    percentileNearestRank(callerArray, 50);
    expect(callerArray).toEqual([40, 10, 30, 20]);
  });

  it('refuses invalid percentiles (0, negative, > 100, NaN, Infinity, non-number) with invalid-percentile', () => {
    const samples = [1, 2, 3];
    for (const p of [0, -5, 100.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '50', null, undefined]) {
      expect(percentileNearestRank(samples, p)).toEqual({ ok: false, reason: 'invalid-percentile' });
    }
  });

  it('refuses more than 100_000 samples in O(1) before ownKeys or element traversal', () => {
    let ownKeysReached = false;
    const proxied = new Proxy([1, 2, 3], {
      getOwnPropertyDescriptor(t, prop) {
        const descriptor = Reflect.getOwnPropertyDescriptor(t, prop);
        if (prop === 'length' && descriptor !== undefined) {
          return { ...descriptor, value: MAX_SLO_SAMPLES + 1 };
        }
        return descriptor;
      },
      ownKeys() {
        ownKeysReached = true;
        throw new Error('ownKeys must never be reached past the O(1) pre-gate');
      },
    });
    expect(percentileNearestRank(proxied, 50)).toEqual({ ok: false, reason: 'too-many-samples' });
    expect(ownKeysReached).toBe(false);
  });

  it('refuses null, undefined, primitives, non-iterables, and array-likes with invalid-samples-list', () => {
    for (const samples of [null, undefined, 7, 'x', true, {}, { length: 1, 0: 10 }, () => 1]) {
      expect(percentileNearestRank(samples, 50)).toEqual({ ok: false, reason: 'invalid-samples-list' });
    }
  });

  it('refuses sparse arrays, getters without invoking them, prototype-polluting keys, revoked Proxies, and throwing ownKeys traps', () => {
    const sparse: unknown[] = [1, 2, 3];
    delete sparse[1];
    expect(percentileNearestRank(sparse, 50)).toEqual({ ok: false, reason: 'invalid-samples-list' });
    let getterRuns = 0;
    const withGetter = Object.defineProperty([1, 2], '1', {
      get() {
        getterRuns += 1;
        return 2;
      },
      enumerable: true,
      configurable: true,
    });
    expect(percentileNearestRank(withGetter, 50)).toEqual({ ok: false, reason: 'invalid-samples-list' });
    expect(getterRuns).toBe(0);
    expect(percentileNearestRank(proxyWithLength([1, 2], 4), 50)).toEqual({ ok: false, reason: 'invalid-samples-list' });
    class Sub extends Array {}
    expect(percentileNearestRank(Object.setPrototypeOf([1, 2], Sub.prototype), 50)).toEqual({ ok: false, reason: 'invalid-samples-list' });
    expect(percentileNearestRank(revokedProxy(), 50)).toEqual({ ok: false, reason: 'invalid-samples-list' });
    expect(percentileNearestRank(throwingOwnKeysProxy(3), 50)).toEqual({ ok: false, reason: 'invalid-samples-list' });
    const polluting: unknown[] = [1, 2];
    Object.defineProperty(polluting, 'constructor', { value: 3, enumerable: true, configurable: true });
    expect(percentileNearestRank(polluting, 50)).toEqual({ ok: false, reason: 'invalid-samples-list' });
  });

  it('refuses an empty sample list with no-samples rather than 0', () => {
    expect(percentileNearestRank([], 50)).toEqual({ ok: false, reason: 'no-samples' });
  });

  it('refuses negative, NaN, Infinity, and non-number sample values with invalid-sample', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '2', true, null, { 0: 2, length: 1 }, undefined]) {
      expect(percentileNearestRank([1, bad], 50)).toEqual({ ok: false, reason: 'invalid-sample' });
    }
  });
});

describe('summariseAdmissionSlo', () => {
  const objective = { p95Ms: 1000 };
  const t = (seconds: number): string =>
    `2026-11-26T00:00:${String(seconds).padStart(2, '0')}.000Z`;

  it('summarises valid samples with nearest-rank p50/p95 and met: true when p95 meets the objective', () => {
    const result = summariseAdmissionSlo(
      [admissionSample(t(0), t(10)), admissionSample(t(0), t(20)), admissionSample(t(0), t(30)), admissionSample(t(0), t(40))],
      { p95Ms: 45_000 },
    );
    expect(result).toEqual({ ok: true, count: 4, invalid: 0, p50Ms: 20_000, p95Ms: 40_000, met: true });
  });

  it('refuses null, non-plain, getter, prototype-polluting, revoked Proxy, or negative/NaN objective with invalid-objective', () => {
    const samples = [admissionSample(t(0), t(1))];
    for (const bad of [null, undefined, 7, 'x', [1], new (class {})(), revokedProxy()]) {
      expect(summariseAdmissionSlo(samples, bad)).toEqual({ ok: false, reason: 'invalid-objective' });
    }
    const getterObjective = Object.defineProperty({}, 'p95Ms', {
      get() {
        throw new Error('the objective getter must never run');
      },
      enumerable: true,
      configurable: true,
    });
    expect(summariseAdmissionSlo(samples, getterObjective)).toEqual({ ok: false, reason: 'invalid-objective' });
    expect(summariseAdmissionSlo(samples, { p95Ms: 1_000, __proto__: { p95Ms: 1 } })).toEqual({ ok: false, reason: 'invalid-objective' });
    expect(summariseAdmissionSlo(samples, { p95Ms: -1 })).toEqual({ ok: false, reason: 'invalid-objective' });
    expect(summariseAdmissionSlo(samples, { p95Ms: Number.NaN })).toEqual({ ok: false, reason: 'invalid-objective' });
    expect(summariseAdmissionSlo(samples, { p95Ms: '5' })).toEqual({ ok: false, reason: 'invalid-objective' });
    expect(summariseAdmissionSlo(samples, { p95Ms: 1_000, extra: 1 })).toEqual({ ok: false, reason: 'invalid-objective' });
  });

  it('refuses admission sample lists exceeding 100_000 entries before ownKeys', () => {
    let ownKeysReached = false;
    const proxied = new Proxy([] as number[], {
      getOwnPropertyDescriptor(t, prop) {
        const descriptor = Reflect.getOwnPropertyDescriptor(t, prop);
        if (prop === 'length' && descriptor !== undefined) {
          return { ...descriptor, value: MAX_SLO_SAMPLES + 1 };
        }
        return descriptor;
      },
      ownKeys() {
        ownKeysReached = true;
        throw new Error('ownKeys must never be reached past the O(1) pre-gate');
      },
    });
    expect(summariseAdmissionSlo(proxied, objective)).toEqual({ ok: false, reason: 'too-many-samples' });
    expect(ownKeysReached).toBe(false);
  });

  it('refuses non-array, sparse, getter-containing, revoked Proxy, or throwing-ownKeys admission sample lists with invalid-samples-list', () => {
    let getterRuns = 0;
    const withGetter = Object.defineProperty([1], '0', {
      get() {
        getterRuns += 1;
        return 1;
      },
      enumerable: true,
      configurable: true,
    });
    const sparseAdmission: unknown[] = [1, 2, 3];
    delete sparseAdmission[1];
    for (const samples of [
      null,
      undefined,
      7,
      { length: 1, 0: admissionSample(t(0), t(1)) },
      sparseAdmission,
      withGetter,
      revokedProxy(),
      throwingOwnKeysProxy(3),
    ]) {
      expect(summariseAdmissionSlo(samples, objective)).toEqual({ ok: false, reason: 'invalid-samples-list' });
    }
    expect(getterRuns).toBe(0);
  });

  it('counts non-ISO strings, calendar rollovers like 02-31, negative latencies, revoked Proxies, and malformed sample objects in invalid without throwing or treating them as 0', () => {
    const samples = [
      admissionSample(t(0), t(10)),
      admissionSample('not-a-timestamp', t(1)),
      admissionSample('2026-02-31T00:00:00.000Z', t(1)),
      admissionSample(t(10), t(0)),
      admissionSample('2026-11-26T24:00:00.000Z', t(1)),
      revokedProxy(),
      { requestedAtIso: t(0) },
      { requestedAtIso: t(0), admittedAtIso: t(1), extra: true },
    ];
    const result = summariseAdmissionSlo(samples, objective);
    expect(result).toEqual({ ok: true, count: 1, invalid: 7, p50Ms: 10_000, p95Ms: 10_000, met: false });
  });

  it('returns met: false and null percentiles when there are no valid admission samples', () => {
    expect(summariseAdmissionSlo([], objective)).toEqual({ ok: true, count: 0, invalid: 0, p50Ms: null, p95Ms: null, met: false });
    expect(summariseAdmissionSlo([admissionSample('not-iso', t(1))], objective)).toEqual({
      ok: true,
      count: 0,
      invalid: 1,
      p50Ms: null,
      p95Ms: null,
      met: false,
    });
  });

  it('returns met: false when any admission sample is invalid even if valid samples meet p95Ms', () => {
    const result = summariseAdmissionSlo([admissionSample(t(0), t(10)), admissionSample(t(10), t(0))], objective);
    expect(result).toEqual({ ok: true, count: 1, invalid: 1, p50Ms: 10_000, p95Ms: 10_000, met: false });
  });
});

describe('summariseParkNotifySlo', () => {
  const objective = { p95Ms: 1000 };
  const t = (seconds: number): string =>
    `2026-11-26T00:00:${String(seconds).padStart(2, '0')}.000Z`;

  it('summarises valid park-notify samples with nearest-rank percentiles and met: true', () => {
    const result = summariseParkNotifySlo(
      [parkSample(t(0), t(10)), parkSample(t(0), t(20)), parkSample(t(0), t(30)), parkSample(t(0), t(40))],
      { p95Ms: 40_000 },
    );
    expect(result).toEqual({ ok: true, count: 4, invalid: 0, unnotified: 0, p50Ms: 20_000, p95Ms: 40_000, met: true });
  });

  it('refuses the objective, sample-list, and too-many-samples paths identically to the admission summary', () => {
    expect(summariseParkNotifySlo([parkSample(t(0), t(1))], revokedProxy())).toEqual({ ok: false, reason: 'invalid-objective' });
    expect(summariseParkNotifySlo(throwingOwnKeysProxy(MAX_SLO_SAMPLES + 1), objective)).toEqual({ ok: false, reason: 'too-many-samples' });
    expect(summariseParkNotifySlo(throwingOwnKeysProxy(3), objective)).toEqual({ ok: false, reason: 'invalid-samples-list' });
    expect(summariseParkNotifySlo(revokedProxy(), objective)).toEqual({ ok: false, reason: 'invalid-samples-list' });
    const sparsePark: unknown[] = [parkSample(t(0), t(1)), parkSample(t(1), t(2))];
    delete sparsePark[0];
    expect(summariseParkNotifySlo(sparsePark, objective)).toEqual({ ok: false, reason: 'invalid-samples-list' });
  });

  it('counts notifiedAtIso: null in unnotified and forces met: false regardless of percentiles', () => {
    const result = summariseParkNotifySlo([parkSample(t(0), t(10)), parkSample(t(0), null)], objective);
    expect(result).toEqual({ ok: true, count: 1, invalid: 0, unnotified: 1, p50Ms: 10_000, p95Ms: 10_000, met: false });
  });

  it('counts malformed park-notify samples, non-ISO strings, 02-31 rollovers, and revoked Proxies in invalid and forces met: false', () => {
    const samples = [
      parkSample(t(0), t(10)),
      parkSample('not-a-timestamp', t(1)),
      parkSample(t(0), '2026-02-31T00:00:00.000Z'),
      parkSample(t(10), t(0)),
      parkSample('2026-02-31T00:00:00.000Z', t(1)),
      revokedProxy(),
      { parkedAtIso: t(0), notifiedAtIso: t(1), extra: true },
      parkSample(t(0), undefined),
    ];
    const result = summariseParkNotifySlo(samples, objective);
    expect(result).toEqual({ ok: true, count: 1, invalid: 7, unnotified: 0, p50Ms: 10_000, p95Ms: 10_000, met: false });
  });

  it('returns met: false and null percentiles when there are no valid park-notify samples', () => {
    expect(summariseParkNotifySlo([], objective)).toEqual({ ok: true, count: 0, invalid: 0, unnotified: 0, p50Ms: null, p95Ms: null, met: false });
    expect(summariseParkNotifySlo([parkSample(t(0), null)], objective)).toEqual({
      ok: true,
      count: 0,
      invalid: 0,
      unnotified: 1,
      p50Ms: null,
      p95Ms: null,
      met: false,
    });
  });

  it('returns met: false when a valid park-notify sample exceeds p95Ms even with no invalid or unnotified samples', () => {
    const result = summariseParkNotifySlo([parkSample(t(0), t(10))], objective);
    expect(result).toEqual({ ok: true, count: 1, invalid: 0, unnotified: 0, p50Ms: 10_000, p95Ms: 10_000, met: false });
  });
});
