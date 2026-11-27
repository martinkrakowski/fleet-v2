/**
 * FC9F hostile-input and behaviour tests for the pure spend-cap admission
 * decider: every function takes `unknown` plus a REQUIRED `isProxy`
 * positional parameter, never throws, and every refusal is the typed
 * result — an unknown verdict is never an implicit admit.
 */

import { types } from 'node:util';
import { describe, expect, it } from 'vitest';

import {
  decideSpendCapAdmission,
  mapSpendDecisionToCapVerdict,
  MAX_IN_FLIGHT_RUNS,
  MAX_RUN_ID_LENGTH,
} from '../spend-cap-admission.js';

const isProxy = types.isProxy;

/** A revoked Proxy throws on every trap, including [[GetPrototypeOf]]. */
function revokedProxy(): unknown {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

/** A Proxy counting every reflection trap it is asked to run. */
function trapCountingProxy(target: object): { proxy: unknown; counts: Record<string, number> } {
  const counts: Record<string, number> = {
    get: 0,
    ownKeys: 0,
    getOwnPropertyDescriptor: 0,
    getPrototypeOf: 0,
  };
  const proxy = new Proxy(target, {
    get(t, prop, receiver) {
      counts.get += 1;
      return Reflect.get(t, prop, receiver);
    },
    ownKeys(t) {
      counts.ownKeys += 1;
      return Reflect.ownKeys(t);
    },
    getOwnPropertyDescriptor(t, prop) {
      counts.getOwnPropertyDescriptor += 1;
      return Reflect.getOwnPropertyDescriptor(t, prop);
    },
    getPrototypeOf(t) {
      counts.getPrototypeOf += 1;
      return Reflect.getPrototypeOf(t);
    },
  });
  return { proxy, counts };
}

/** A dense array of `n` distinct valid run ids. */
function runIds(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `run-${i}`);
}

/** A valid admission input with the given verdict. */
function validInput(capVerdict: string, extra: Record<string, unknown> = {}): unknown {
  return { capVerdict, runId: 'run-1', ...extra };
}

describe('decideSpendCapAdmission', () => {
  it('admits a within verdict with the candidate runId', () => {
    expect(decideSpendCapAdmission(validInput('within'), isProxy)).toEqual({
      outcome: 'admit',
      runId: 'run-1',
    });
  });

  it('parks with reason spend-cap on exceeded and invalid verdicts, and on any unknown capVerdict (fail closed)', () => {
    for (const verdict of ['exceeded', 'invalid', 'unknown-verdict', '', 'WITHIN', null, 123, true, {}, ['within']]) {
      expect(decideSpendCapAdmission(validInput(verdict as string), isProxy)).toEqual({
        outcome: 'park',
        runId: 'run-1',
        reason: 'spend-cap',
      });
    }
  });

  it('returns a decision with no kill, stop, or cancel action and leaves the in-flight list unmutated', () => {
    const inFlightRunIds = ['run-a', 'run-b'];
    const snapshot = [...inFlightRunIds];
    const decision = decideSpendCapAdmission(
      { capVerdict: 'exceeded', runId: 'run-1', inFlightRunIds },
      isProxy,
    );
    expect(decision).toEqual({ outcome: 'park', runId: 'run-1', reason: 'spend-cap' });
    expect('kill' in decision).toBe(false);
    expect('stop' in decision).toBe(false);
    expect('cancel' in decision).toBe(false);
    expect(JSON.stringify(decision)).not.toMatch(/kill|stop|cancel/i);
    expect(inFlightRunIds).toEqual(snapshot);
  });

  it('accepts an optional inFlightRunIds list of valid run ids', () => {
    expect(
      decideSpendCapAdmission(
        { capVerdict: 'within', runId: 'run-1', inFlightRunIds: ['run-a', 'run-b'] },
        isProxy,
      ),
    ).toEqual({ outcome: 'admit', runId: 'run-1' });
    expect(
      decideSpendCapAdmission({ capVerdict: 'within', runId: 'run-1', inFlightRunIds: [] }, isProxy),
    ).toEqual({ outcome: 'admit', runId: 'run-1' });
  });

  it('refuses null, undefined, primitives, functions, and arrays as input with invalid-input', () => {
    for (const input of [null, undefined, 42, 'within', true, () => {}, []]) {
      expect(decideSpendCapAdmission(input, isProxy)).toEqual({
        outcome: 'refused',
        reason: 'invalid-input',
      });
    }
  });

  it('refuses array-likes, sparse arrays with holes, non-plain prototypes, and zero-length arrays with extra properties in inFlightRunIds with invalid-input', () => {
    expect(
      decideSpendCapAdmission(
        { capVerdict: 'within', runId: 'run-1', inFlightRunIds: { length: 1, 0: 'run-1' } },
        isProxy,
      ),
    ).toEqual({ outcome: 'refused', reason: 'invalid-input' });
    const sparse: string[] = ['run-1', 'run-2'];
    delete sparse[0];
    expect(
      decideSpendCapAdmission(
        { capVerdict: 'within', runId: 'run-1', inFlightRunIds: sparse },
        isProxy,
      ),
    ).toEqual({ outcome: 'refused', reason: 'invalid-input' });
    class Sub extends Array {}
    expect(
      decideSpendCapAdmission(
        { capVerdict: 'within', runId: 'run-1', inFlightRunIds: Object.setPrototypeOf(['run-1'], Sub.prototype) },
        isProxy,
      ),
    ).toEqual({ outcome: 'refused', reason: 'invalid-input' });
    expect(
      decideSpendCapAdmission(
        { capVerdict: 'within', runId: 'run-1', inFlightRunIds: Object.assign([], { extra: 'x' }) },
        isProxy,
      ),
    ).toEqual({ outcome: 'refused', reason: 'invalid-input' });
  });

  it('refuses getters on input and inFlightRunIds without invoking them', () => {
    let getterRuns = 0;
    const withGetter = Object.defineProperty({} as Record<string, unknown>, 'capVerdict', {
      get() {
        getterRuns += 1;
        return 'within';
      },
      enumerable: true,
      configurable: true,
    });
    withGetter.runId = 'run-1';
    expect(decideSpendCapAdmission(withGetter, isProxy)).toEqual({
      outcome: 'refused',
      reason: 'invalid-input',
    });
    expect(getterRuns).toBe(0);
    let elementGetterRuns = 0;
    const elements = Object.defineProperty(['run-a'] as unknown[], '0', {
      get() {
        elementGetterRuns += 1;
        return 'run-a';
      },
      enumerable: true,
      configurable: true,
    });
    expect(
      decideSpendCapAdmission(
        { capVerdict: 'within', runId: 'run-1', inFlightRunIds: elements },
        isProxy,
      ),
    ).toEqual({ outcome: 'refused', reason: 'invalid-input' });
    expect(elementGetterRuns).toBe(0);
  });

  it('refuses a Proxy wrapping a valid within input via types.isProxy without running reflection traps', () => {
    const { proxy, counts } = trapCountingProxy(validInput('within') as object);
    expect(decideSpendCapAdmission(proxy, isProxy)).toEqual({
      outcome: 'refused',
      reason: 'invalid-input',
    });
    expect(counts).toEqual({ get: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, getPrototypeOf: 0 });
    const listProxy = trapCountingProxy(['run-a']);
    expect(
      decideSpendCapAdmission(
        { capVerdict: 'within', runId: 'run-1', inFlightRunIds: listProxy.proxy },
        isProxy,
      ),
    ).toEqual({ outcome: 'refused', reason: 'invalid-input' });
    expect(Object.values(listProxy.counts).every((n) => n === 0)).toBe(true);
  });

  it('refuses revoked Proxies and throwing or non-function isProxy detectors without throwing', () => {
    expect(decideSpendCapAdmission(revokedProxy(), isProxy)).toEqual({
      outcome: 'refused',
      reason: 'invalid-input',
    });
    const throwingDetector = (): boolean => {
      throw new Error('detector must never escape');
    };
    expect(decideSpendCapAdmission(validInput('within'), throwingDetector)).toEqual({
      outcome: 'refused',
      reason: 'invalid-input',
    });
    expect(decideSpendCapAdmission(validInput('within'), 'not-a-function' as unknown as typeof isProxy)).toEqual({
      outcome: 'refused',
      reason: 'invalid-input',
    });
  });

  it('refuses inFlightRunIds longer than MAX_IN_FLIGHT_RUNS before ownKeys traversal with too-many-in-flight', () => {
    expect(
      decideSpendCapAdmission(
        { capVerdict: 'within', runId: 'run-1', inFlightRunIds: runIds(MAX_IN_FLIGHT_RUNS + 1) },
        isProxy,
      ),
    ).toEqual({ outcome: 'refused', reason: 'too-many-in-flight' });
    // A holey array whose `length` is `2**32 - 1` allocates nothing, so the
    // refusal must come from the O(1) length gate, never a traversal.
    const enormous: unknown = new Array(2 ** 32 - 1);
    expect(
      decideSpendCapAdmission(
        { capVerdict: 'within', runId: 'run-1', inFlightRunIds: enormous },
        isProxy,
      ),
    ).toEqual({ outcome: 'refused', reason: 'too-many-in-flight' });
  });

  it('accepts MAX_IN_FLIGHT_RUNS entries when maxNodes is sized above 10_000', () => {
    expect(
      decideSpendCapAdmission(
        { capVerdict: 'within', runId: 'run-1', inFlightRunIds: runIds(MAX_IN_FLIGHT_RUNS) },
        isProxy,
      ),
    ).toEqual({ outcome: 'admit', runId: 'run-1' });
  });

  it('refuses prototype-polluting keys, symbol keys, non-enumerable keys, and extra or missing keys with invalid-input', () => {
    const polluting: Record<string, unknown> = { capVerdict: 'within', runId: 'run-1' };
    Object.defineProperty(polluting, '__proto__', {
      value: 'run-x',
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(decideSpendCapAdmission(polluting, isProxy)).toEqual({
      outcome: 'refused',
      reason: 'invalid-input',
    });
    const symbolKeyed: Record<string, unknown> = { capVerdict: 'within', runId: 'run-1' };
    Object.defineProperty(symbolKeyed, Symbol('extra'), {
      value: 'x',
      enumerable: true,
      configurable: true,
    });
    expect(decideSpendCapAdmission(symbolKeyed, isProxy)).toEqual({
      outcome: 'refused',
      reason: 'invalid-input',
    });
    const hidden: Record<string, unknown> = { capVerdict: 'within', runId: 'run-1' };
    Object.defineProperty(hidden, 'inFlightRunIds', {
      value: [],
      enumerable: false,
      configurable: true,
      writable: true,
    });
    expect(decideSpendCapAdmission(hidden, isProxy)).toEqual({
      outcome: 'refused',
      reason: 'invalid-input',
    });
    expect(decideSpendCapAdmission({ capVerdict: 'within' }, isProxy)).toEqual({
      outcome: 'refused',
      reason: 'invalid-input',
    });
    expect(decideSpendCapAdmission({ runId: 'run-1' }, isProxy)).toEqual({
      outcome: 'refused',
      reason: 'invalid-input',
    });
    expect(
      decideSpendCapAdmission({ capVerdict: 'within', runId: 'run-1', extra: 'x' }, isProxy),
    ).toEqual({ outcome: 'refused', reason: 'invalid-input' });
  });

  it('refuses empty, whitespace-padded, overlong, or non-string runId and inFlightRunIds entries with invalid-input', () => {
    for (const runId of ['', '  ', `r${'x'.repeat(MAX_RUN_ID_LENGTH)}`, 7, null, {}, undefined]) {
      expect(decideSpendCapAdmission({ capVerdict: 'within', runId }, isProxy)).toEqual({
        outcome: 'refused',
        reason: 'invalid-input',
      });
      expect(
        decideSpendCapAdmission(
          { capVerdict: 'within', runId: 'run-1', inFlightRunIds: [runId] },
          isProxy,
        ),
      ).toEqual({ outcome: 'refused', reason: 'invalid-input' });
    }
    expect(
      decideSpendCapAdmission(
        { capVerdict: 'within', runId: 'run-1', inFlightRunIds: 'run-a' },
        isProxy,
      ),
    ).toEqual({ outcome: 'refused', reason: 'invalid-input' });
  });
});

describe('mapSpendDecisionToCapVerdict', () => {
  it('maps the allow decision to within', () => {
    expect(mapSpendDecisionToCapVerdict({ outcome: 'allow' }, isProxy)).toBe('within');
  });

  it('maps park spend-cap decisions with organization and project scope to exceeded', () => {
    expect(
      mapSpendDecisionToCapVerdict({ outcome: 'park', reason: 'spend-cap', scope: 'organization' }, isProxy),
    ).toBe('exceeded');
    expect(
      mapSpendDecisionToCapVerdict({ outcome: 'park', reason: 'spend-cap', scope: 'project' }, isProxy),
    ).toBe('exceeded');
  });

  it('maps the park no-cap-for-period decision to exceeded', () => {
    expect(mapSpendDecisionToCapVerdict({ outcome: 'park', reason: 'no-cap-for-period' }, isProxy)).toBe('exceeded');
  });

  it('maps the refuse invalid-input decision to invalid', () => {
    expect(mapSpendDecisionToCapVerdict({ outcome: 'refuse', reason: 'invalid-input' }, isProxy)).toBe('invalid');
  });

  it('maps null, undefined, primitives, and arrays in mapSpendDecisionToCapVerdict to invalid', () => {
    for (const decision of [null, undefined, 42, 'allow', true, () => {}, [], ['allow']]) {
      expect(mapSpendDecisionToCapVerdict(decision, isProxy)).toBe('invalid');
    }
  });

  it('maps wrong, missing, extra, prototype-polluting, symbol, and non-enumerable keys to invalid', () => {
    expect(mapSpendDecisionToCapVerdict({ outcome: 'park', reason: 'spend-cap' }, isProxy)).toBe('invalid');
    expect(
      mapSpendDecisionToCapVerdict({ outcome: 'park', reason: 'spend-cap', scope: 'galaxy' }, isProxy),
    ).toBe('invalid');
    expect(
      mapSpendDecisionToCapVerdict({ outcome: 'park', reason: 'no-cap-for-period', scope: 'project' }, isProxy),
    ).toBe('invalid');
    expect(mapSpendDecisionToCapVerdict({ outcome: 'park' }, isProxy)).toBe('invalid');
    expect(mapSpendDecisionToCapVerdict({ outcome: 'allow', extra: 1 }, isProxy)).toBe('invalid');
    const polluting: Record<string, unknown> = { outcome: 'allow' };
    Object.defineProperty(polluting, 'constructor', {
      value: 'x',
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(mapSpendDecisionToCapVerdict(polluting, isProxy)).toBe('invalid');
    const symbolKeyed: Record<string, unknown> = { outcome: 'allow' };
    Object.defineProperty(symbolKeyed, Symbol('extra'), {
      value: 'x',
      enumerable: true,
      configurable: true,
    });
    expect(mapSpendDecisionToCapVerdict(symbolKeyed, isProxy)).toBe('invalid');
    const hidden: Record<string, unknown> = { outcome: 'allow' };
    Object.defineProperty(hidden, 'hidden', {
      value: 'x',
      enumerable: false,
      configurable: true,
      writable: true,
    });
    expect(mapSpendDecisionToCapVerdict(hidden, isProxy)).toBe('invalid');
  });

  it('maps SpendDecision with getter to invalid without invoking the getter', () => {
    let getterRuns = 0;
    const withGetter = Object.defineProperty({}, 'outcome', {
      get() {
        getterRuns += 1;
        return 'allow';
      },
      enumerable: true,
      configurable: true,
    });
    expect(mapSpendDecisionToCapVerdict(withGetter, isProxy)).toBe('invalid');
    expect(getterRuns).toBe(0);
  });

  it('maps Proxy SpendDecision via types.isProxy to invalid without running reflection traps', () => {
    const { proxy, counts } = trapCountingProxy({ outcome: 'allow' });
    expect(mapSpendDecisionToCapVerdict(proxy, isProxy)).toBe('invalid');
    expect(counts).toEqual({ get: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, getPrototypeOf: 0 });
  });

  it('maps revoked Proxies and throwing or non-function isProxy detectors to invalid without throwing', () => {
    expect(mapSpendDecisionToCapVerdict(revokedProxy(), isProxy)).toBe('invalid');
    const throwingDetector = (): boolean => {
      throw new Error('detector must never escape');
    };
    expect(mapSpendDecisionToCapVerdict({ outcome: 'allow' }, throwingDetector)).toBe('invalid');
    expect(mapSpendDecisionToCapVerdict({ outcome: 'allow' }, 'nope' as unknown as typeof isProxy)).toBe('invalid');
  });
});
