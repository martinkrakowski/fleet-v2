// Lane SH5c: tests for the S8 intake evaluator (queue intake and import
// fidelity over two samples). Hostile-input cases included per the brief:
// every test asserts the specific evaluation, not merely that nothing threw.
import { describe, expect, it } from 'vitest';

import { evaluateShadowIntake, SHADOW_INTAKE_MIN_GAP_MS } from '../shadow-day-intake.js';
import { SHADOW_DIVERGENCE_MAX } from '../shadow-comparators.js';

const HEAD = '0123456789abcdef0123456789abcdef01234567';
const T0 = '2026-11-17T10:00:00Z';
const T10 = '2026-11-17T10:10:00Z';
const T_PLUS_60S = '2026-11-17T10:01:00Z';

/** One enqueue key built from inert pieces. */
function key(pullRequest: number, headOid: string = HEAD, base: string = 'main') {
  return { pullRequest, headOid, base };
}

/** `count` keys whose pull requests run `from`..`from + count - 1`. */
function rangeKeys(from: number, count: number) {
  return Array.from({ length: count }, (_, index) => key(from + index));
}

/** One sample; every field is an own data property. */
function sample(overrides: Record<string, unknown> = {}) {
  return {
    takenAtIso: T0,
    complete: true,
    shellLive: [],
    fleetLive: [],
    importPresent: [],
    importUnknownLines: 0,
    ...overrides,
  };
}

/** Two samples the minimum gap apart, with per-sample overrides. */
function twoSamples(first: Record<string, unknown> = {}, second: Record<string, unknown> = {}) {
  return { samples: [sample({ takenAtIso: T0, ...first }), sample({ takenAtIso: T10, ...second })] };
}

/** A getter whose runs are counted, planted as an own enumerable property. */
function withCountingGetter(object: Record<string, unknown>, name: string, counter: { calls: number }): object {
  Object.defineProperty(object, name, {
    enumerable: true,
    get() {
      counter.calls += 1;
      return undefined;
    },
  });
  return object;
}

describe('shadow day intake (S8)', () => {
  it('two samples with fully equal shell/fleet/import sets pass', () => {
    const shellLive = [key(1), key(2)];
    const input = twoSamples(
      { shellLive, fleetLive: shellLive, importPresent: [key(1), key(2)] },
      { shellLive, fleetLive: shellLive, importPresent: [key(1), key(2)] },
    );
    expect(evaluateShadowIntake(input)).toEqual({ status: 'pass', reason: 'intake-equal' });
  });

  it('a divergence present in sample 1 only, resolved by sample 2, is not persistent and passes', () => {
    const shellLive = [key(1)];
    const input = twoSamples(
      { shellLive, fleetLive: [], importPresent: [] },
      { shellLive, fleetLive: [key(1)], importPresent: [key(1)] },
    );
    expect(evaluateShadowIntake(input)).toEqual({ status: 'pass', reason: 'intake-equal' });
  });

  it('the same divergence present in both samples fails as enqueue-coverage-divergence', () => {
    const shellLive = [key(1)];
    const input = twoSamples(
      { shellLive, fleetLive: [] },
      { shellLive, fleetLive: [] },
    );
    expect(evaluateShadowIntake(input)).toEqual({ status: 'fail', reason: 'enqueue-coverage-divergence' });
  });

  it('a shared divergence beyond the 50-entry cap in both samples still fails as enqueue-coverage-divergence', () => {
    const missing = rangeKeys(10, SHADOW_DIVERGENCE_MAX + 10);
    const input = twoSamples(
      { shellLive: missing, fleetLive: [], importPresent: missing },
      { shellLive: missing, fleetLive: [], importPresent: missing },
    );
    expect(evaluateShadowIntake(input)).toEqual({ status: 'fail', reason: 'enqueue-coverage-divergence' });
  });

  it('a shared import divergence beyond the 50-entry cap in both samples still fails as import-divergence', () => {
    const parked = rangeKeys(10, SHADOW_DIVERGENCE_MAX + 11);
    const input = twoSamples(
      { shellLive: parked, fleetLive: parked, importPresent: [] },
      { shellLive: parked, fleetLive: parked, importPresent: [] },
    );
    expect(evaluateShadowIntake(input)).toEqual({ status: 'fail', reason: 'import-divergence' });
  });

  it('a truncated sample beside a single different divergence in the other sample is not persistent and passes', () => {
    const input = twoSamples(
      { shellLive: rangeKeys(10, SHADOW_DIVERGENCE_MAX + 1), fleetLive: [], importPresent: [] },
      { shellLive: [key(999)], fleetLive: [], importPresent: [] },
    );
    expect(evaluateShadowIntake(input)).toEqual({ status: 'pass', reason: 'intake-equal' });
  });

  it('a divergence hidden beyond the cap in one sample and listed in the other is persistent and fails', () => {
    const first = rangeKeys(10, SHADOW_DIVERGENCE_MAX + 10);
    const input = twoSamples(
      { shellLive: first, fleetLive: [], importPresent: [] },
      { shellLive: [key(10 + SHADOW_DIVERGENCE_MAX)], fleetLive: [], importPresent: [] },
    );
    expect(evaluateShadowIntake(input)).toEqual({ status: 'fail', reason: 'enqueue-coverage-divergence' });
  });

  it('the import dry-run missing a parked key in both samples fails as import-divergence', () => {
    const shellLive = [key(1)];
    const input = twoSamples(
      { shellLive, fleetLive: [key(1)], importPresent: [] },
      { shellLive, fleetLive: [key(1)], importPresent: [] },
    );
    expect(evaluateShadowIntake(input)).toEqual({ status: 'fail', reason: 'import-divergence' });
  });

  it('a chain-base shell key present in both samples fails as chain-base-not-importable', () => {
    const shellLive = [key(1, HEAD, 'chain/a')];
    const input = twoSamples(
      { shellLive, fleetLive: [key(1, HEAD, 'chain/a')], importPresent: [] },
      { shellLive, fleetLive: [key(1, HEAD, 'chain/a')], importPresent: [] },
    );
    expect(evaluateShadowIntake(input)).toEqual({ status: 'fail', reason: 'chain-base-not-importable' });
  });

  it('a chain-base shell key present in only one sample is a snapshot artifact and passes', () => {
    const input = twoSamples(
      { shellLive: [key(1, HEAD, 'chain/a')], fleetLive: [key(1, HEAD, 'chain/a')], importPresent: [] },
      { shellLive: [], fleetLive: [], importPresent: [] },
    );
    expect(evaluateShadowIntake(input)).toEqual({ status: 'pass', reason: 'intake-equal' });
  });

  it('a gap between the two samples of only 60 seconds is samples-invalid', () => {
    const input = twoSamples({}, { takenAtIso: T_PLUS_60S });
    expect(SHADOW_INTAKE_MIN_GAP_MS).toBe(120_000);
    expect(evaluateShadowIntake(input)).toEqual({ status: 'unknown', reason: 'samples-invalid' });
  });

  it('either sample marked incomplete is shell-state-incomplete', () => {
    const oneIncomplete = twoSamples({ complete: false });
    expect(evaluateShadowIntake(oneIncomplete)).toEqual({ status: 'unknown', reason: 'shell-state-incomplete' });
    const otherIncomplete = twoSamples({}, { complete: false });
    expect(evaluateShadowIntake(otherIncomplete)).toEqual({ status: 'unknown', reason: 'shell-state-incomplete' });
  });

  it('either sample with importPresent null is import-unavailable', () => {
    const firstNull = twoSamples({ importPresent: null });
    expect(evaluateShadowIntake(firstNull)).toEqual({ status: 'unknown', reason: 'import-unavailable' });
    const secondNull = twoSamples({}, { importPresent: null });
    expect(evaluateShadowIntake(secondNull)).toEqual({ status: 'unknown', reason: 'import-unavailable' });
  });

  it('importUnknownLines wins: fail/import-unknown-lines is returned before the B divergence check', () => {
    const shellLive = [key(1)];
    const input = twoSamples(
      { shellLive, fleetLive: [key(1)], importPresent: [], importUnknownLines: 2 },
      { shellLive, fleetLive: [key(1)], importPresent: [], importUnknownLines: 2 },
    );
    expect(evaluateShadowIntake(input)).toEqual({ status: 'fail', reason: 'import-unknown-lines' });
  });

  it('non-persistent B divergence with unknown lines still fails on the unknown lines', () => {
    const input = twoSamples({ importPresent: [key(1)], importUnknownLines: 1 }, { importPresent: [] });
    expect(evaluateShadowIntake(input)).toEqual({ status: 'fail', reason: 'import-unknown-lines' });
  });

  it('a wrong primitive (a number where the record is due) is samples-invalid', () => {
    expect(evaluateShadowIntake(7)).toEqual({ status: 'unknown', reason: 'samples-invalid' });
  });

  it('null is samples-invalid', () => {
    expect(evaluateShadowIntake(null)).toEqual({ status: 'unknown', reason: 'samples-invalid' });
  });

  it('undefined is samples-invalid', () => {
    expect(evaluateShadowIntake(undefined)).toEqual({ status: 'unknown', reason: 'samples-invalid' });
  });

  it('a string where the samples list is due is samples-invalid', () => {
    expect(evaluateShadowIntake({ samples: 'nope' })).toEqual({ status: 'unknown', reason: 'samples-invalid' });
  });

  it('a number where takenAtIso is due is samples-invalid', () => {
    const input = twoSamples({ takenAtIso: 1_000 });
    expect(evaluateShadowIntake(input)).toEqual({ status: 'unknown', reason: 'samples-invalid' });
  });

  it('a non-iterable object where the samples list is due is samples-invalid', () => {
    expect(evaluateShadowIntake({ samples: { length: 2 } })).toEqual({ status: 'unknown', reason: 'samples-invalid' });
  });

  it('an array hole in the samples list is samples-invalid', () => {
    const sparse: unknown[] = [sample(), sample()];
    delete sparse[1];
    expect(evaluateShadowIntake({ samples: sparse })).toEqual({ status: 'unknown', reason: 'samples-invalid' });
  });

  it('an array hole in a key list is samples-invalid', () => {
    const sparse: unknown[] = [key(1)];
    delete sparse[0];
    const input = twoSamples({ shellLive: sparse }, { shellLive: sparse });
    expect(evaluateShadowIntake(input)).toEqual({ status: 'unknown', reason: 'samples-invalid' });
  });

  it('an array-like object { length: 2, 0: … } is samples-invalid', () => {
    const arrayLike = { length: 2, 0: sample(), 1: sample() };
    expect(evaluateShadowIntake({ samples: arrayLike })).toEqual({ status: 'unknown', reason: 'samples-invalid' });
  });

  it('an enormous sparse length (2**32 - 1) is refused before any traversal', () => {
    const enormous: unknown[] = [];
    Object.defineProperty(enormous, 'length', { value: 2 ** 32 - 1 });
    expect(evaluateShadowIntake({ samples: enormous })).toEqual({ status: 'unknown', reason: 'samples-invalid' });
    const input = twoSamples({ shellLive: enormous });
    expect(evaluateShadowIntake(input)).toEqual({ status: 'unknown', reason: 'samples-invalid' });
  });

  it('a getter on the samples list never runs', () => {
    const counter = { calls: 0 };
    const withGetter = withCountingGetter({ length: 2, 0: sample(), 1: sample() }, 'samples', counter);
    expect(evaluateShadowIntake({ samples: withGetter })).toEqual({ status: 'unknown', reason: 'samples-invalid' });
    expect(counter.calls).toBe(0);
  });

  it('a getter on a sample field never runs', () => {
    const counter = { calls: 0 };
    const first = withCountingGetter(sample(), 'shellLive', counter);
    const input = { samples: [first, sample({ takenAtIso: T10 })] };
    expect(evaluateShadowIntake(input)).toEqual({ status: 'unknown', reason: 'samples-invalid' });
    expect(counter.calls).toBe(0);
  });

  it('a getter on a key field never runs', () => {
    const counter = { calls: 0 };
    const badKey = withCountingGetter({ pullRequest: 1, headOid: HEAD, base: 'main' }, 'pullRequest', counter);
    const input = twoSamples({ shellLive: [badKey] }, { shellLive: [badKey] });
    expect(evaluateShadowIntake(input)).toEqual({ status: 'unknown', reason: 'samples-invalid' });
    expect(counter.calls).toBe(0);
  });

  it('a Proxy over a valid input yields exactly the plain-data result with no get trap run', () => {
    const plain = twoSamples({ shellLive: [key(1)], fleetLive: [key(1)], importPresent: [key(1)] });
    let getTraps = 0;
    const proxy = new Proxy(plain, {
      get(_target, property, receiver) {
        getTraps += 1;
        return Reflect.get(_target, property, receiver);
      },
    });
    expect(evaluateShadowIntake(proxy)).toEqual({ status: 'pass', reason: 'intake-equal' });
    expect(getTraps).toBe(0);
  });

  it('a Proxy over an invalid input is refused with no get trap run', () => {
    let getTraps = 0;
    const proxy = new Proxy({}, {
      get() {
        getTraps += 1;
        return undefined;
      },
    });
    expect(evaluateShadowIntake(proxy)).toEqual({ status: 'unknown', reason: 'samples-invalid' });
    expect(getTraps).toBe(0);
  });

  it('a prototype-polluting __proto__ own key from JSON.parse is refused and never merged', () => {
    const polluted = JSON.parse(`{"samples": ${JSON.stringify([sample(), sample({ takenAtIso: T10 })])}, "__proto__": {"polluted": true}}`);
    expect(evaluateShadowIntake(polluted)).toEqual({ status: 'unknown', reason: 'samples-invalid' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('a key with a prototype-polluting own key is refused', () => {
    const badKey = JSON.parse(`{"pullRequest": 1, "headOid": "${HEAD}", "base": "main", "constructor": "x"}`);
    const input = twoSamples({ shellLive: [badKey] }, { shellLive: [badKey] });
    expect(evaluateShadowIntake(input)).toEqual({ status: 'unknown', reason: 'samples-invalid' });
  });

  it('a constant-verdict function would fail: a passing input and a failing input give different verdicts', () => {
    const passing = twoSamples(
      { shellLive: [key(1)], fleetLive: [key(1)], importPresent: [key(1)] },
      { shellLive: [key(1)], fleetLive: [key(1)], importPresent: [key(1)] },
    );
    const failing = twoSamples({ shellLive: [key(1)], fleetLive: [] }, { shellLive: [key(1)], fleetLive: [] });
    expect(evaluateShadowIntake(passing)).toEqual({ status: 'pass', reason: 'intake-equal' });
    expect(evaluateShadowIntake(failing)).toEqual({ status: 'fail', reason: 'enqueue-coverage-divergence' });
    expect(evaluateShadowIntake(passing)).not.toEqual(evaluateShadowIntake(failing));
  });

  it('an identity echo would fail: the result never contains the input', () => {
    const input = twoSamples({ shellLive: [key(1)], fleetLive: [] }, { shellLive: [key(1)], fleetLive: [] });
    const result = evaluateShadowIntake(input);
    expect(result).toEqual({ status: 'fail', reason: 'enqueue-coverage-divergence' });
    expect(JSON.stringify(result)).not.toContain('0123456789abcdef');
    expect(JSON.stringify(result)).not.toContain('samples');
  });

  it('an extra sample (three) is samples-invalid', () => {
    const input = { samples: [sample(), sample({ takenAtIso: T10 }), sample()] };
    expect(evaluateShadowIntake(input)).toEqual({ status: 'unknown', reason: 'samples-invalid' });
  });

  it('a single sample is samples-invalid', () => {
    expect(evaluateShadowIntake({ samples: [sample()] })).toEqual({ status: 'unknown', reason: 'samples-invalid' });
  });

  it('a malformed key (missing headOid) is samples-invalid', () => {
    const badKey = { pullRequest: 1, base: 'main' };
    const input = twoSamples({ shellLive: [badKey] }, { shellLive: [badKey] });
    expect(evaluateShadowIntake(input)).toEqual({ status: 'unknown', reason: 'samples-invalid' });
  });

  it('a non-main base in importPresent is tolerated shape-wise and compared on its own merit', () => {
    const shellLive = [key(1)];
    const input = twoSamples(
      { shellLive, fleetLive: [key(1)], importPresent: [key(1, HEAD, 'main')] },
      { shellLive, fleetLive: [key(1)], importPresent: [key(1, HEAD, 'main')] },
    );
    expect(evaluateShadowIntake(input)).toEqual({ status: 'pass', reason: 'intake-equal' });
  });

  it('a sample with extra keys is samples-invalid', () => {
    const extra = { ...sample(), extra: 1 };
    const input = { samples: [extra, sample({ takenAtIso: T10 })] };
    expect(evaluateShadowIntake(input)).toEqual({ status: 'unknown', reason: 'samples-invalid' });
  });

  it('a returned fail verdict is frozen: an attempt to flip it to pass throws and does not corrupt a later unrelated fail call', () => {
    const divergentA = twoSamples({ shellLive: [key(1)], fleetLive: [] }, { shellLive: [key(1)], fleetLive: [] });
    const first = evaluateShadowIntake(divergentA);
    expect(first).toEqual({ status: 'fail', reason: 'enqueue-coverage-divergence' });
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => {
      (first as { status: string }).status = 'pass';
    }).toThrow();

    // This is the test that actually proves the bug is fixed, not just that
    // freezing happened: a second, unrelated call with different inputs
    // that lands on the SAME verdict shape must report its own true result,
    // not a shape corrupted by the mutation attempted on the first call's
    // result above. Before the fix, `enqueue-coverage-divergence` was one
    // shared, unfrozen object reused across every call, so the attempted
    // mutation above would have silently rewritten it and this call would
    // wrongly report 'pass'.
    const divergentB = twoSamples({ shellLive: [key(2)], fleetLive: [] }, { shellLive: [key(2)], fleetLive: [] });
    const second = evaluateShadowIntake(divergentB);
    expect(second).toEqual({ status: 'fail', reason: 'enqueue-coverage-divergence' });
  });
});
