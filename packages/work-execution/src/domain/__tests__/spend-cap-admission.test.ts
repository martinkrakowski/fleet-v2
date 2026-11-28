/**
 * FC9F hostile-input and behaviour tests for the pure spend-cap admission
 * decider: every function takes `unknown` plus a REQUIRED `types.isProxy`
 * detector, never throws, and every refusal is the typed reason. An unknown
 * verdict never admits; in-flight runs are never killed.
 */

import { types } from 'node:util';
import { describe, expect, it } from 'vitest';

import {
  MAX_IN_FLIGHT_RUNS,
  MAX_RUN_ID_LENGTH,
  decideSpendCapAdmission,
  mapSpendDecisionToCapVerdict,
} from '../spend-cap-admission.js';

const isProxy = types.isProxy;

/** A revoked Proxy throws on every trap, including [[GetPrototypeOf]]. */
function revokedProxy(): unknown {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

/** A Proxy whose every reflection trap throws and records that it was reached. */
function countingThrowingProxy(target: object): { proxy: unknown; hits(): number } {
  let reached = 0;
  const trap = (): never => {
    reached += 1;
    throw new Error('reflection trap must never be reached');
  };
  const proxy = new Proxy(target, {
    get: trap,
    ownKeys: trap,
    getOwnPropertyDescriptor: trap,
    getPrototypeOf: trap,
  });
  return { proxy, hits: () => reached };
}

/** An enumerable getter that counts how often it runs. */
function withCountingGetter(target: object, key: string): { value: unknown; runs(): number } {
  let runs = 0;
  const value = Object.defineProperty(target, key, {
    get() {
      runs += 1;
      return 'gotcha';
    },
    enumerable: true,
    configurable: true,
  });
  return { value, runs: () => runs };
}

/** A dense array of n distinct valid run ids. */
function runIds(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `run-${i}`);
}

describe('decideSpendCapAdmission', () => {
  it('admits on capVerdict within and parks with reason spend-cap on exceeded', () => {
    expect(decideSpendCapAdmission({ capVerdict: 'within', runId: 'run-1' }, isProxy)).toEqual({
      outcome: 'admit',
      runId: 'run-1',
    });
    expect(
      decideSpendCapAdmission({ capVerdict: 'exceeded', runId: 'run-1' }, isProxy),
    ).toEqual({ outcome: 'park', runId: 'run-1', reason: 'spend-cap' });
  });

  it('parks with reason spend-cap on invalid or unknown capVerdict (fail closed)', () => {
    for (const verdict of ['invalid', 'unknown-verdict', '', null, 123, { v: 1 }, true, ['within']]) {
      expect(
        decideSpendCapAdmission({ capVerdict: verdict, runId: 'run-1' }, isProxy),
      ).toEqual({ outcome: 'park', runId: 'run-1', reason: 'spend-cap' });
    }
  });

  it('refuses null, undefined, primitives, functions, and arrays as input with invalid-input', () => {
    for (const bad of [null, undefined, 42, 'within', true, () => {}, [], Symbol('x')]) {
      expect(decideSpendCapAdmission(bad, isProxy)).toEqual({
        outcome: 'refused',
        reason: 'invalid-input',
      });
    }
  });

  it('refuses missing, extra, or prototype-polluting keys (including own __proto__), symbol keys, and non-enumerable keys with invalid-input', () => {
    // Missing keys.
    expect(decideSpendCapAdmission({ capVerdict: 'within' }, isProxy)).toEqual({
      outcome: 'refused',
      reason: 'invalid-input',
    });
    expect(decideSpendCapAdmission({ runId: 'run-1' }, isProxy)).toEqual({
      outcome: 'refused',
      reason: 'invalid-input',
    });
    // Extra key.
    expect(
      decideSpendCapAdmission({ capVerdict: 'within', runId: 'run-1', extra: 'x' }, isProxy),
    ).toEqual({ outcome: 'refused', reason: 'invalid-input' });
    // Prototype-polluting own keys.
    const polluting: Record<string, unknown> = { capVerdict: 'within', runId: 'run-1' };
    Object.defineProperty(polluting, '__proto__', {
      value: {},
      enumerable: true,
      configurable: true,
    });
    expect(decideSpendCapAdmission(polluting, isProxy)).toEqual({
      outcome: 'refused',
      reason: 'invalid-input',
    });
    const constructorKey: Record<string, unknown> = { capVerdict: 'within', runId: 'run-1' };
    Object.defineProperty(constructorKey, 'constructor', {
      value: 'x',
      enumerable: true,
      configurable: true,
    });
    expect(decideSpendCapAdmission(constructorKey, isProxy)).toEqual({
      outcome: 'refused',
      reason: 'invalid-input',
    });
    // Symbol key.
    const symbolKeyed: Record<string, unknown> = { capVerdict: 'within', runId: 'run-1' };
    (symbolKeyed as Record<symbol, unknown>)[Symbol('k')] = 'v';
    expect(decideSpendCapAdmission(symbolKeyed, isProxy)).toEqual({
      outcome: 'refused',
      reason: 'invalid-input',
    });
    // Non-enumerable key.
    const hidden: Record<string, unknown> = { capVerdict: 'within', runId: 'run-1' };
    Object.defineProperty(hidden, 'inFlightRunIds', {
      value: [],
      enumerable: false,
      configurable: true,
    });
    expect(decideSpendCapAdmission(hidden, isProxy)).toEqual({
      outcome: 'refused',
      reason: 'invalid-input',
    });
  });

  it('refuses empty, whitespace-padded, overlong, or non-string runId and inFlightRunIds entries with invalid-input', () => {
    for (const runId of ['', '  ', `x${'y'.repeat(MAX_RUN_ID_LENGTH)}`, 42, null, undefined, {}]) {
      expect(decideSpendCapAdmission({ capVerdict: 'within', runId }, isProxy)).toEqual({
        outcome: 'refused',
        reason: 'invalid-input',
      });
    }
    expect(
      decideSpendCapAdmission(
        { capVerdict: 'within', runId: 'run-1', inFlightRunIds: ['ok', '  '] },
        isProxy,
      ),
    ).toEqual({ outcome: 'refused', reason: 'invalid-input' });
    expect(
      decideSpendCapAdmission(
        { capVerdict: 'within', runId: 'run-1', inFlightRunIds: ['ok', 7] },
        isProxy,
      ),
    ).toEqual({ outcome: 'refused', reason: 'invalid-input' });
    expect(
      decideSpendCapAdmission(
        { capVerdict: 'within', runId: 'run-1', inFlightRunIds: 'run-2' },
        isProxy,
      ),
    ).toEqual({ outcome: 'refused', reason: 'invalid-input' });
    expect(
      decideSpendCapAdmission(
        { capVerdict: 'within', runId: 'a'.repeat(MAX_RUN_ID_LENGTH), inFlightRunIds: [] },
        isProxy,
      ),
    ).toEqual({ outcome: 'admit', runId: 'a'.repeat(MAX_RUN_ID_LENGTH) });
  });

  it('refuses array-likes, sparse arrays with holes, non-plain prototypes, and zero-length arrays with extra properties in inFlightRunIds with invalid-input', () => {
    for (const inFlight of [
      { length: 1, 0: 'run-1' },
      Object.assign([], { extra: 'x' }),
      'run-1',
    ]) {
      expect(
        decideSpendCapAdmission(
          { capVerdict: 'within', runId: 'run-1', inFlightRunIds: inFlight },
          isProxy,
        ),
      ).toEqual({ outcome: 'refused', reason: 'invalid-input' });
    }
    const sparse: unknown[] = ['run-1', 'run-2'];
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
        {
          capVerdict: 'within',
          runId: 'run-1',
          inFlightRunIds: Object.setPrototypeOf(['run-1'], Sub.prototype),
        },
        isProxy,
      ),
    ).toEqual({ outcome: 'refused', reason: 'invalid-input' });
  });

  it('refuses getters on input and inFlightRunIds without invoking them', () => {
    const root = withCountingGetter({ capVerdict: 'within', runId: 'run-1' }, 'capVerdict');
    expect(decideSpendCapAdmission(root.value, isProxy)).toEqual({
      outcome: 'refused',
      reason: 'invalid-input',
    });
    expect(root.runs()).toBe(0);
    const element = withCountingGetter(['run-1'], '0');
    expect(
      decideSpendCapAdmission(
        { capVerdict: 'within', runId: 'run-1', inFlightRunIds: element.value },
        isProxy,
      ),
    ).toEqual({ outcome: 'refused', reason: 'invalid-input' });
    expect(element.runs()).toBe(0);
  });

  it('refuses Proxy wrapping a valid within input via types.isProxy without running reflection traps', () => {
    const counted = countingThrowingProxy({ capVerdict: 'within', runId: 'run-1' });
    expect(decideSpendCapAdmission(counted.proxy, isProxy)).toEqual({
      outcome: 'refused',
      reason: 'invalid-input',
    });
    expect(counted.hits()).toBe(0);
  });

  it('refuses revoked Proxies and throwing or non-function isProxy detectors without throwing', () => {
    expect(decideSpendCapAdmission(revokedProxy(), isProxy)).toEqual({
      outcome: 'refused',
      reason: 'invalid-input',
    });
    const throwingDetector = (): boolean => {
      throw new Error('detector must throw only into the typed refusal');
    };
    expect(
      decideSpendCapAdmission({ capVerdict: 'within', runId: 'run-1' }, throwingDetector),
    ).toEqual({ outcome: 'refused', reason: 'invalid-input' });
    const notAFunction = 42 as unknown as typeof isProxy;
    expect(
      decideSpendCapAdmission({ capVerdict: 'within', runId: 'run-1' }, notAFunction),
    ).toEqual({ outcome: 'refused', reason: 'invalid-input' });
  });

  it('refuses inFlightRunIds longer than MAX_IN_FLIGHT_RUNS with too-many-in-flight, checked in O(1) by snapArray before ownKeys', () => {
    // A plain dense array just over the bound: snapArray's length check runs
    // before its own `Reflect.ownKeys`, so nothing is traversed.
    expect(
      decideSpendCapAdmission(
        { capVerdict: 'within', runId: 'run-1', inFlightRunIds: runIds(MAX_IN_FLIGHT_RUNS + 1) },
        isProxy,
      ),
    ).toEqual({ outcome: 'refused', reason: 'too-many-in-flight' });
    // An enormous length (near 2**32 - 1) is refused the same way without
    // allocation or traversal.
    const huge: string[] = new Array(2 ** 32 - 2);
    expect(
      decideSpendCapAdmission(
        { capVerdict: 'within', runId: 'run-1', inFlightRunIds: huge },
        isProxy,
      ),
    ).toEqual({ outcome: 'refused', reason: 'too-many-in-flight' });
  });

  it('accepts MAX_IN_FLIGHT_RUNS entries when maxNodes is sized above 10_000, and refuses 10_001', () => {
    expect(
      decideSpendCapAdmission(
        { capVerdict: 'within', runId: 'run-1', inFlightRunIds: runIds(MAX_IN_FLIGHT_RUNS) },
        isProxy,
      ),
    ).toEqual({ outcome: 'admit', runId: 'run-1' });
    expect(
      decideSpendCapAdmission(
        { capVerdict: 'within', runId: 'run-1', inFlightRunIds: runIds(MAX_IN_FLIGHT_RUNS + 1) },
        isProxy,
      ),
    ).toEqual({ outcome: 'refused', reason: 'too-many-in-flight' });
  });

  it('never kills or mutates in-flight runs: the decision has no kill/stop action and the input array is left untouched', () => {
    const inFlight = ['run-2', 'run-3'];
    const decision = decideSpendCapAdmission(
      { capVerdict: 'exceeded', runId: 'run-1', inFlightRunIds: inFlight },
      isProxy,
    );
    expect(decision).toEqual({ outcome: 'park', runId: 'run-1', reason: 'spend-cap' });
    const keys = Object.keys(decision);
    expect(keys.every((key) => ['outcome', 'runId', 'reason'].includes(key))).toBe(true);
    expect(JSON.stringify(decision)).not.toMatch(/kill|stop|cancel/i);
    expect(inFlight).toEqual(['run-2', 'run-3']);
  });
});

describe('mapSpendDecisionToCapVerdict', () => {
  it('maps every SpendDecision variant: allow to within, both park shapes to exceeded, refuse to invalid', () => {
    expect(mapSpendDecisionToCapVerdict({ outcome: 'allow' }, isProxy)).toBe('within');
    expect(
      mapSpendDecisionToCapVerdict(
        { outcome: 'park', reason: 'spend-cap', scope: 'organization' },
        isProxy,
      ),
    ).toBe('exceeded');
    expect(
      mapSpendDecisionToCapVerdict(
        { outcome: 'park', reason: 'spend-cap', scope: 'project' },
        isProxy,
      ),
    ).toBe('exceeded');
    expect(
      mapSpendDecisionToCapVerdict({ outcome: 'park', reason: 'no-cap-for-period' }, isProxy),
    ).toBe('exceeded');
    expect(
      mapSpendDecisionToCapVerdict({ outcome: 'refuse', reason: 'invalid-input' }, isProxy),
    ).toBe('invalid');
  });

  it('maps null, undefined, primitives, and arrays in mapSpendDecisionToCapVerdict to invalid', () => {
    for (const bad of [null, undefined, 42, 'allow', true, () => {}, [], { length: 1, 0: 'x' }]) {
      expect(mapSpendDecisionToCapVerdict(bad, isProxy)).toBe('invalid');
    }
  });

  it('maps unknown outcomes, wrong reasons or scopes, and extra, missing, or prototype-polluting keys to invalid', () => {
    expect(mapSpendDecisionToCapVerdict({ outcome: 'unknown' }, isProxy)).toBe('invalid');
    expect(
      mapSpendDecisionToCapVerdict({ outcome: 'park', reason: 'spend-cap', scope: 'team' }, isProxy),
    ).toBe('invalid');
    expect(mapSpendDecisionToCapVerdict({ outcome: 'park', reason: 'other' }, isProxy)).toBe(
      'invalid',
    );
    expect(
      mapSpendDecisionToCapVerdict({ outcome: 'allow', extra: 'x' }, isProxy),
    ).toBe('invalid');
    const polluting: Record<string, unknown> = { outcome: 'allow' };
    Object.defineProperty(polluting, '__proto__', {
      value: {},
      enumerable: true,
      configurable: true,
    });
    expect(mapSpendDecisionToCapVerdict(polluting, isProxy)).toBe('invalid');
    expect(mapSpendDecisionToCapVerdict({ outcome: 'allow', reason: 'spend-cap' }, isProxy)).toBe(
      'invalid',
    );
  });

  it('maps SpendDecision with getter to invalid without invoking the getter', () => {
    const counted = withCountingGetter({ outcome: 'allow' }, 'outcome');
    expect(mapSpendDecisionToCapVerdict(counted.value, isProxy)).toBe('invalid');
    expect(counted.runs()).toBe(0);
  });

  it('maps Proxy SpendDecision via types.isProxy to invalid without running reflection traps', () => {
    const counted = countingThrowingProxy({ outcome: 'allow' });
    expect(mapSpendDecisionToCapVerdict(counted.proxy, isProxy)).toBe('invalid');
    expect(counted.hits()).toBe(0);
    expect(mapSpendDecisionToCapVerdict(revokedProxy(), isProxy)).toBe('invalid');
  });

  it('maps throwing or non-function isProxy detectors to invalid without throwing', () => {
    const throwingDetector = (): boolean => {
      throw new Error('detector must throw only into the typed refusal');
    };
    expect(mapSpendDecisionToCapVerdict({ outcome: 'allow' }, throwingDetector)).toBe('invalid');
    const notAFunction = 'x' as unknown as typeof isProxy;
    expect(mapSpendDecisionToCapVerdict({ outcome: 'allow' }, notAFunction)).toBe('invalid');
  });
});
