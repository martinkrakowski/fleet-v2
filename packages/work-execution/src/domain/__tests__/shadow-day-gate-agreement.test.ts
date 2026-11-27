// Lane SH11: tests for the S4' gate-agreement evaluator. Every case asserts
// the specific status and reason, not merely that nothing threw.
import { describe, expect, it } from 'vitest';

import { SHADOW_DIVERGENCE_MAX } from '../shadow-comparators.js';
import {
  evaluateShadowGateAgreement,
  SHADOW_GATE_MAX_HEADS,
  SHADOW_GATE_MIN_AGREEING_HEADS,
} from '../shadow-day-gate-agreement.js';
import type {
  ShadowGateAgreementEvaluation,
  ShadowGateCiState,
  ShadowGateHeadFact,
} from '../shadow-day-gate-agreement.js';

const DAY = '2026-11-17';
const D_MINUS_1 = '2026-11-16';
const D_MINUS_2 = '2026-11-15';
const D_MINUS_3 = '2026-11-14';
const D_PLUS_1 = '2026-11-18';

const WINDOW_DAYS = [D_MINUS_2, D_MINUS_1, DAY] as const;

function oid(n: number): string {
  return n.toString(16).padStart(40, '0');
}

function at(day: string, time = '12:00:00'): string {
  return `${day}T${time}Z`;
}

function head(n: number, overrides: Partial<ShadowGateHeadFact> = {}): ShadowGateHeadFact {
  return {
    headOid: oid(n),
    conductorVerdict: 'pass',
    pushedAtIso: at(DAY),
    ciGate: 'success',
    ...overrides,
  };
}

/** `count` agreeing pass/success heads spread across D-2, D-1 and D. */
function agreeing(count: number, start = 1): ShadowGateHeadFact[] {
  const heads: ShadowGateHeadFact[] = [];
  for (let index = 0; index < count; index += 1) {
    const day = WINDOW_DAYS[index % WINDOW_DAYS.length] ?? DAY;
    heads.push(head(start + index, { pushedAtIso: at(day) }));
  }
  return heads;
}

function gateInput(heads: unknown, day: unknown = DAY): { day: unknown; heads: unknown } {
  return { day, heads };
}

function verdict(
  status: ShadowGateAgreementEvaluation['status'],
  reason: string,
  counts: Partial<Omit<ShadowGateAgreementEvaluation, 'status' | 'reason'>> = {},
): ShadowGateAgreementEvaluation {
  return {
    status,
    reason,
    compared: 0,
    agreeing: 0,
    falsePasses: 0,
    stricterFails: 0,
    unsettled: 0,
    truncated: false,
    ...counts,
  };
}

const INVALID = verdict('unknown', 'invalid-input');
const PASS_30 = verdict('pass', 'gate-verdicts-agree', {
  compared: SHADOW_GATE_MIN_AGREEING_HEADS,
  agreeing: SHADOW_GATE_MIN_AGREEING_HEADS,
});

/** One S4 divergence diagnostic: `ValidHead` carries no pull request, so `pr` is always 0. */
function gateItem(n: number, side: 'fleet' | 'shell', code: string): { pr: number; head12: string; side: 'fleet' | 'shell'; code: string } {
  return { pr: 0, head12: oid(n).slice(0, 12), side, code };
}

/** The non-digested payload an S4 evaluation carries when its divergence total is positive. */
function details(totalCount: number, items: ReturnType<typeof gateItem>[]): { totalCount: number; items: ReturnType<typeof gateItem>[] } {
  return { totalCount, items };
}

describe('evaluateShadowGateAgreement (S4 prime)', () => {
  it('30 agreeing pass/success heads spread over D-2..D pass with agreeing 30', () => {
    const result = evaluateShadowGateAgreement(gateInput(agreeing(SHADOW_GATE_MIN_AGREEING_HEADS)));
    expect(result).toEqual(PASS_30);
  });

  it('29 agreeing heads are fail/too-few-agreeing-heads', () => {
    const count = SHADOW_GATE_MIN_AGREEING_HEADS - 1;
    expect(evaluateShadowGateAgreement(gateInput(agreeing(count)))).toEqual(
      verdict('fail', 'too-few-agreeing-heads', { compared: count, agreeing: count }),
    );
  });

  it('30 agreeing plus one false pass pushed on D is fail/gate-false-pass', () => {
    // Midnight is the inclusive start of D. A later `>` bound would pass the day.
    const heads = [
      ...agreeing(SHADOW_GATE_MIN_AGREEING_HEADS),
      head(100, { ciGate: 'failure', pushedAtIso: at(DAY, '00:00:00') }),
    ];
    expect(evaluateShadowGateAgreement(gateInput(heads))).toEqual(
      verdict('fail', 'gate-false-pass', {
        compared: SHADOW_GATE_MIN_AGREEING_HEADS + 1,
        agreeing: SHADOW_GATE_MIN_AGREEING_HEADS,
        falsePasses: 1,
        divergenceDetails: details(1, [gateItem(100, 'fleet', 'false-pass')]),
      }),
    );
  });

  it('31 agreeing plus one false pass pushed on D-1 passes with falsePasses 1', () => {
    const agreeingCount = SHADOW_GATE_MIN_AGREEING_HEADS + 1;
    const heads = [
      ...agreeing(agreeingCount),
      head(100, { ciGate: 'failure', pushedAtIso: at(D_MINUS_1) }),
    ];
    expect(evaluateShadowGateAgreement(gateInput(heads))).toEqual(
      verdict('pass', 'gate-verdicts-agree', {
        compared: agreeingCount + 1,
        agreeing: agreeingCount,
        falsePasses: 1,
        divergenceDetails: details(1, [gateItem(100, 'fleet', 'false-pass')]),
      }),
    );
  });

  it('30 agreeing plus one stricter fail on D passes with stricterFails 1', () => {
    const heads = [
      ...agreeing(SHADOW_GATE_MIN_AGREEING_HEADS),
      head(100, { conductorVerdict: 'fail', ciGate: 'success' }),
    ];
    expect(evaluateShadowGateAgreement(gateInput(heads))).toEqual(
      verdict('pass', 'gate-verdicts-agree', {
        compared: SHADOW_GATE_MIN_AGREEING_HEADS + 1,
        agreeing: SHADOW_GATE_MIN_AGREEING_HEADS,
        stricterFails: 1,
        divergenceDetails: details(1, [gateItem(100, 'shell', 'stricter-fail')]),
      }),
    );
  });

  it('a pending, a missing, an other and an ambiguous head are each counted in unsettled and none are compared', () => {
    const states: readonly ShadowGateCiState[] = ['pending', 'missing', 'other', 'ambiguous'];
    const heads = states.map((ciGate, index) => head(index + 1, { ciGate }));
    expect(evaluateShadowGateAgreement(gateInput(heads))).toEqual(
      verdict('unknown', 'no-settled-heads', { unsettled: states.length }),
    );
  });

  it('a head pushed on D-3 and one on D+1 are ignored', () => {
    const heads = [
      ...agreeing(SHADOW_GATE_MIN_AGREEING_HEADS),
      head(101, { pushedAtIso: at(D_MINUS_3) }),
      head(102, { pushedAtIso: at(D_PLUS_1, '00:00:00') }),
    ];
    expect(evaluateShadowGateAgreement(gateInput(heads))).toEqual(PASS_30);
  });

  it('the same head twice with identical facts is counted once', () => {
    const heads = [
      head(1, { pushedAtIso: at(D_MINUS_2, '01:00:00') }),
      ...agreeing(SHADOW_GATE_MIN_AGREEING_HEADS - 1, 2),
      head(1),
    ];
    expect(evaluateShadowGateAgreement(gateInput(heads))).toEqual(PASS_30);
  });

  it('the same head twice with different ciGate is unknown/gate-facts-conflicting', () => {
    const heads = [head(1, { ciGate: 'success' }), head(1, { ciGate: 'failure' })];
    expect(evaluateShadowGateAgreement(gateInput(heads))).toEqual(
      verdict('unknown', 'gate-facts-conflicting'),
    );
  });

  it('a head at 23:59:59Z on D-3 is outside W and one at 00:00:00Z on D-2 is inside', () => {
    const outside = head(1, {
      ciGate: 'failure',
      pushedAtIso: at(D_MINUS_3, '23:59:59'),
    });
    const inside = head(2, { pushedAtIso: at(D_MINUS_2, '00:00:00') });
    expect(evaluateShadowGateAgreement(gateInput([outside, inside]))).toEqual(
      verdict('fail', 'too-few-agreeing-heads', { compared: 1, agreeing: 1 }),
    );
  });

  it('day 2026-02-30 and day 0099-01-01 are unknown/invalid-input', () => {
    for (const day of ['2026-02-30', '0099-01-01']) {
      expect(evaluateShadowGateAgreement(gateInput(agreeing(1), day))).toEqual(INVALID);
    }
  });

  it('more than SHADOW_GATE_MAX_HEADS heads is unknown/invalid-input before any element is read', () => {
    let calls = 0;
    const heads: unknown[] = [];
    Object.defineProperty(heads, '0', {
      enumerable: true,
      configurable: true,
      get() {
        calls += 1;
        return head(1);
      },
    });
    heads.length = SHADOW_GATE_MAX_HEADS + 1;
    expect(evaluateShadowGateAgreement(gateInput(heads))).toEqual(INVALID);
    expect(calls).toBe(0);
  });

  it('exactly SHADOW_GATE_MAX_HEADS agreeing heads pass', () => {
    const heads = agreeing(SHADOW_GATE_MAX_HEADS);
    expect(evaluateShadowGateAgreement(gateInput(heads))).toEqual(
      verdict('pass', 'gate-verdicts-agree', {
        compared: SHADOW_GATE_MAX_HEADS,
        agreeing: SHADOW_GATE_MAX_HEADS,
      }),
    );
  });

  it('JSON.stringify(result) contains no head oid from the input', () => {
    const falsePass = head(99, { ciGate: 'failure', pushedAtIso: at(DAY, '00:00:00') });
    const heads = [...agreeing(SHADOW_GATE_MIN_AGREEING_HEADS), falsePass];
    const encoded = JSON.stringify(evaluateShadowGateAgreement(gateInput(heads)));
    for (const item of heads) {
      expect(encoded).not.toContain(item.headOid);
      expect(encoded).not.toContain(item.pushedAtIso);
    }
    expect(encoded).not.toContain('#gate');
  });

  it('30 agreeing fail/failure heads pass with agreeing 30', () => {
    const heads = agreeing(SHADOW_GATE_MIN_AGREEING_HEADS).map((item) => ({
      ...item,
      conductorVerdict: 'fail' as const,
      ciGate: 'failure' as const,
    }));
    expect(evaluateShadowGateAgreement(gateInput(heads))).toEqual(PASS_30);
  });

  it('a false pass on D outranks the agreeing-head floor', () => {
    const heads = [
      ...agreeing(SHADOW_GATE_MIN_AGREEING_HEADS - 1),
      head(100, { ciGate: 'failure', pushedAtIso: at(DAY, '00:00:00') }),
    ];
    expect(evaluateShadowGateAgreement(gateInput(heads))).toEqual(
      verdict('fail', 'gate-false-pass', {
        compared: SHADOW_GATE_MIN_AGREEING_HEADS,
        agreeing: SHADOW_GATE_MIN_AGREEING_HEADS - 1,
        falsePasses: 1,
        divergenceDetails: details(1, [gateItem(100, 'fleet', 'false-pass')]),
      }),
    );
  });

  it('identical facts keep the earliest pushedAtIso for the day check', () => {
    const early = head(1, { ciGate: 'failure', pushedAtIso: at(D_MINUS_1) });
    const later = head(1, { ciGate: 'failure', pushedAtIso: at(DAY, '00:00:00') });
    const rest = agreeing(SHADOW_GATE_MIN_AGREEING_HEADS + 1, 2);
    const expected = verdict('pass', 'gate-verdicts-agree', {
      compared: SHADOW_GATE_MIN_AGREEING_HEADS + 2,
      agreeing: SHADOW_GATE_MIN_AGREEING_HEADS + 1,
      falsePasses: 1,
      divergenceDetails: details(1, [gateItem(1, 'fleet', 'false-pass')]),
    });
    // Opposite orders: keeping the first copy, or the last, would fail one of these.
    expect(evaluateShadowGateAgreement(gateInput([later, early, ...rest]))).toEqual(expected);
    expect(evaluateShadowGateAgreement(gateInput([early, later, ...rest]))).toEqual(expected);
  });

  it('more divergences than SHADOW_DIVERGENCE_MAX is unknown/gate-comparison-incomplete', () => {
    // The comparator lists only SHADOW_DIVERGENCE_MAX divergences. `compared`
    // stays the full total, but a truncated head is never counted as agreeing:
    // the result is `truncated: true` with `agreeing: 0`.
    const headCount = SHADOW_DIVERGENCE_MAX + 1;
    const heads = Array.from({ length: headCount }, (_, index) =>
      head(index + 1, { ciGate: 'failure', pushedAtIso: at(DAY, '00:00:00') }),
    );
    expect(evaluateShadowGateAgreement(gateInput(heads))).toEqual(
      verdict('unknown', 'gate-comparison-incomplete', {
        compared: headCount,
        agreeing: 0,
        falsePasses: SHADOW_DIVERGENCE_MAX,
        truncated: true,
        divergenceDetails: details(SHADOW_DIVERGENCE_MAX, Array.from({ length: 20 }, (_, index) => gateItem(index + 1, 'fleet', 'false-pass'))),
      }),
    );
  });

  it('two truncated inputs with different underlying counts produce results whose counts differ', () => {
    const falsePasses = (count: number): ShadowGateHeadFact[] =>
      Array.from({ length: count }, (_, index) =>
        head(index + 1, { ciGate: 'failure', pushedAtIso: at(DAY, '00:00:00') }),
      );
    const fewer = evaluateShadowGateAgreement(gateInput(falsePasses(SHADOW_DIVERGENCE_MAX + 1)));
    const more = evaluateShadowGateAgreement(gateInput(falsePasses(SHADOW_DIVERGENCE_MAX + 2)));
    const truncatedExpectation = (compared: number) =>
      verdict('unknown', 'gate-comparison-incomplete', {
        compared,
        agreeing: 0,
        falsePasses: SHADOW_DIVERGENCE_MAX,
        truncated: true,
        divergenceDetails: details(SHADOW_DIVERGENCE_MAX, Array.from({ length: 20 }, (_, index) => gateItem(index + 1, 'fleet', 'false-pass'))),
      });
    expect(fewer).toEqual(truncatedExpectation(SHADOW_DIVERGENCE_MAX + 1));
    expect(more).toEqual(truncatedExpectation(SHADOW_DIVERGENCE_MAX + 2));
    expect(fewer).not.toEqual(more);
  });

  it('mixed truncated divergences plus agreeing heads are unknown/gate-comparison-incomplete with agreeing 0', () => {
    // 51 diverging heads (all false passes) plus 30 agreeing heads spread
    // over the window. The comparator truncates at SHADOW_DIVERGENCE_MAX, so
    // the 30 agreeing heads are never counted: `agreeing` is 0.
    const diverging = Array.from({ length: SHADOW_DIVERGENCE_MAX + 1 }, (_, index) =>
      head(index + 1, { ciGate: 'failure', pushedAtIso: at(DAY, '00:00:00') }),
    );
    const heads = [...diverging, ...agreeing(SHADOW_GATE_MIN_AGREEING_HEADS, SHADOW_DIVERGENCE_MAX + 2)];
    expect(evaluateShadowGateAgreement(gateInput(heads))).toEqual(
      verdict('unknown', 'gate-comparison-incomplete', {
        compared: SHADOW_DIVERGENCE_MAX + 1 + SHADOW_GATE_MIN_AGREEING_HEADS,
        agreeing: 0,
        falsePasses: SHADOW_DIVERGENCE_MAX,
        truncated: true,
        divergenceDetails: details(SHADOW_DIVERGENCE_MAX, Array.from({ length: 20 }, (_, index) => gateItem(index + 1, 'fleet', 'false-pass'))),
      }),
    );
  });

  it('an empty heads list is unknown/no-settled-heads', () => {
    expect(evaluateShadowGateAgreement(gateInput([]))).toEqual(
      verdict('unknown', 'no-settled-heads'),
    );
  });

  it('heads only outside D-2..D give unknown/no-settled-heads', () => {
    const heads = [
      head(101, { pushedAtIso: at(D_MINUS_3) }),
      head(102, { pushedAtIso: at(D_PLUS_1, '00:00:00') }),
    ];
    expect(evaluateShadowGateAgreement(gateInput(heads))).toEqual(
      verdict('unknown', 'no-settled-heads'),
    );
  });

  it('records S4 divergenceDetails with pr 0, head12 prefix, side from divergence kind, and code', () => {
    // One false pass (fleet passed where the shell CI did not) and one
    // stricter fail (the shell CI passed where the fleet failed) on D, among
    // enough agreeing heads to stay evaluat­ed.
    const heads = [
      ...agreeing(SHADOW_GATE_MIN_AGREEING_HEADS),
      head(100, { ciGate: 'failure', pushedAtIso: at(DAY, '00:00:00') }),
      head(101, { conductorVerdict: 'fail', ciGate: 'success' }),
    ];
    expect(evaluateShadowGateAgreement(gateInput(heads))).toEqual(
      verdict('fail', 'gate-false-pass', {
        compared: SHADOW_GATE_MIN_AGREEING_HEADS + 2,
        agreeing: SHADOW_GATE_MIN_AGREEING_HEADS,
        falsePasses: 1,
        stricterFails: 1,
        divergenceDetails: details(2, [
          gateItem(100, 'fleet', 'false-pass'),
          gateItem(101, 'shell', 'stricter-fail'),
        ]),
      }),
    );
  });

  it('caps S4 divergenceDetails at 20 sorted items while preserving totalCount', () => {
    const heads = Array.from({ length: 30 }, (_, index) =>
      head(index + 1, { ciGate: 'failure', pushedAtIso: at(DAY, '00:00:00') }),
    );
    const result = evaluateShadowGateAgreement(gateInput(heads));
    expect(result.status).toBe('fail');
    expect(result.falsePasses).toBe(30);
    expect(result.divergenceDetails?.totalCount).toBe(30);
    expect(result.divergenceDetails?.items).toHaveLength(20);
    expect(result.divergenceDetails?.items).toEqual(
      Array.from({ length: 20 }, (_, index) => gateItem(index + 1, 'fleet', 'false-pass')),
    );
    expect(result.divergenceDetails?.items.every((item) => item.pr === 0)).toBe(true);
  });

  it('a malformed head is unknown/invalid-input', () => {
    const good = head(1);
    const cases: unknown[] = [
      { ...good, headOid: 'A'.repeat(40) },
      { ...good, headOid: 'abc' },
      { ...good, conductorVerdict: 'unknown' },
      { ...good, conductorVerdict: 'skipped' },
      { ...good, ciGate: 'error' },
      { ...good, pushedAtIso: DAY },
      { ...good, extra: true },
      { headOid: good.headOid, conductorVerdict: 'pass', pushedAtIso: good.pushedAtIso },
      null,
    ];
    for (const item of cases) {
      expect(evaluateShadowGateAgreement(gateInput([item]))).toEqual(INVALID);
    }
    expect(evaluateShadowGateAgreement({ day: DAY, heads: [], extra: 1 })).toEqual(INVALID);
    expect(evaluateShadowGateAgreement({ day: DAY })).toEqual(INVALID);
  });

  it('null is unknown/invalid-input', () => {
    expect(evaluateShadowGateAgreement(null)).toEqual(INVALID);
  });

  it('returns invalid-input without divergenceDetails on a malformed S4 record', () => {
    const result = evaluateShadowGateAgreement(gateInput([{ ...head(1), conductorVerdict: 'unknown' }]));
    expect(result).toEqual(INVALID);
    expect(result).not.toHaveProperty('divergenceDetails');
  });

  it('refuses a non-array heads value with invalid-input and no divergenceDetails', () => {
    const result = evaluateShadowGateAgreement(gateInput('heads'));
    expect(result).toEqual(INVALID);
    expect(result).not.toHaveProperty('divergenceDetails');
  });

  it('never invokes a throwing getter on S4 heads and returns invalid-input without divergenceDetails', () => {
    let indexCalls = 0;
    const heads: unknown[] = [];
    Object.defineProperty(heads, '0', {
      enumerable: true,
      configurable: true,
      get() {
        indexCalls += 1;
        return head(1);
      },
    });
    const result = evaluateShadowGateAgreement(gateInput(heads));
    expect(result).toEqual(INVALID);
    expect(indexCalls).toBe(0);
    expect(result).not.toHaveProperty('divergenceDetails');
  });

  it('undefined is unknown/invalid-input', () => {
    expect(evaluateShadowGateAgreement(undefined)).toEqual(INVALID);
  });

  it('a number where a string is due is unknown/invalid-input', () => {
    expect(evaluateShadowGateAgreement(gateInput([], 20261117))).toEqual(INVALID);
  });

  it('a string where a list is due is unknown/invalid-input', () => {
    expect(evaluateShadowGateAgreement(gateInput('heads'))).toEqual(INVALID);
  });

  it('a non-iterable object where a list is due is unknown/invalid-input', () => {
    expect(evaluateShadowGateAgreement(gateInput({ not: 'a list' }))).toEqual(INVALID);
  });

  it('an array hole is unknown/invalid-input', () => {
    const heads: unknown[] = [head(1), head(2), head(3)];
    delete heads[1];
    expect(evaluateShadowGateAgreement(gateInput(heads))).toEqual(INVALID);
  });

  it('an array-like object is unknown/invalid-input', () => {
    expect(evaluateShadowGateAgreement(gateInput({ length: 1, 0: head(1) }))).toEqual(INVALID);
  });

  it('an enormous sparse length is refused before any traversal', () => {
    const enormous: unknown[] = [];
    Object.defineProperty(enormous, 'length', { value: 2 ** 32 - 1 });
    expect(evaluateShadowGateAgreement(gateInput(enormous))).toEqual(INVALID);
  });

  it('a symbol own key on the heads list is unknown/invalid-input', () => {
    const heads: unknown[] = agreeing(1);
    Object.defineProperty(heads, Symbol('tag'), { value: 1, enumerable: false, configurable: true });
    expect(evaluateShadowGateAgreement(gateInput(heads))).toEqual(INVALID);
  });

  it('a non-enumerable extra own key on the heads list is unknown/invalid-input', () => {
    const heads: unknown[] = agreeing(1);
    Object.defineProperty(heads, 'extra', { value: 1, enumerable: false, configurable: true, writable: true });
    expect(evaluateShadowGateAgreement(gateInput(heads))).toEqual(INVALID);
  });

  it('a list-level accessor element refuses the heads list (unknown/invalid-input)', () => {
    const heads: unknown[] = agreeing(1);
    let accessorCalls = 0;
    Object.defineProperty(heads, 0, {
      enumerable: true,
      configurable: true,
      get: () => {
        accessorCalls += 1;
        return head(1);
      },
    });
    expect(evaluateShadowGateAgreement(gateInput(heads))).toEqual(INVALID);
    expect(accessorCalls).toBe(0);
  });

  it('a getter on the root never runs', () => {
    let calls = 0;
    const root: Record<string, unknown> = {};
    Object.defineProperty(root, 'day', {
      enumerable: true,
      configurable: true,
      get() {
        calls += 1;
        return DAY;
      },
    });
    Object.defineProperty(root, 'heads', {
      enumerable: true,
      configurable: true,
      writable: true,
      value: agreeing(SHADOW_GATE_MIN_AGREEING_HEADS),
    });
    expect(evaluateShadowGateAgreement(root)).toEqual(INVALID);
    expect(calls).toBe(0);
  });

  it('a getter on an item never runs', () => {
    let fieldCalls = 0;
    const item: Record<string, unknown> = {
      headOid: oid(1),
      conductorVerdict: 'pass',
      pushedAtIso: at(DAY),
    };
    Object.defineProperty(item, 'ciGate', {
      enumerable: true,
      configurable: true,
      get() {
        fieldCalls += 1;
        return 'success';
      },
    });
    let indexCalls = 0;
    const heads: unknown[] = [];
    Object.defineProperty(heads, '0', {
      enumerable: true,
      configurable: true,
      get() {
        indexCalls += 1;
        return head(1);
      },
    });
    expect(evaluateShadowGateAgreement(gateInput([item]))).toEqual(INVALID);
    expect(evaluateShadowGateAgreement(gateInput(heads))).toEqual(INVALID);
    expect(fieldCalls).toBe(0);
    expect(indexCalls).toBe(0);
  });

  it('a Proxy over a valid input yields the plain result and runs no get trap', () => {
    const plain = gateInput(agreeing(SHADOW_GATE_MIN_AGREEING_HEADS));
    const plainResult = evaluateShadowGateAgreement(plain);
    let gets = 0;
    const counting = new Proxy(plain, {
      get(target, property, receiver) {
        gets += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(evaluateShadowGateAgreement(counting)).toEqual(plainResult);
    expect(gets).toBe(0);
    expect(evaluateShadowGateAgreement(new Proxy(plain, {}))).toEqual(plainResult);
  });

  it('a Proxy over the heads list yields the plain result and runs no get trap', () => {
    const plainHeads = agreeing(SHADOW_GATE_MIN_AGREEING_HEADS);
    let gets = 0;
    const heads = new Proxy(plainHeads, {
      get(target, property, receiver) {
        gets += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(evaluateShadowGateAgreement(gateInput(heads))).toEqual(
      evaluateShadowGateAgreement(gateInput(plainHeads)),
    );
    expect(gets).toBe(0);
  });

  it('a throwing proxy trap is unknown/invalid-input and does not throw', () => {
    const proxy = new Proxy(
      { day: DAY, heads: [] },
      {
        ownKeys() {
          throw new Error('boom');
        },
      },
    );
    expect(evaluateShadowGateAgreement(proxy)).toEqual(INVALID);
  });

  it('a prototype-polluting key from JSON.parse is unknown/invalid-input', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const input = JSON.parse(
        `{"day":"${DAY}","heads":[],"${key}":{"polluted":true}}`,
      ) as Record<string, unknown>;
      expect(Object.hasOwn(input, key)).toBe(true);
      expect(evaluateShadowGateAgreement(input)).toEqual(INVALID);
    }
    const badHead = JSON.parse(
      `{"headOid":"${oid(1)}","conductorVerdict":"pass","pushedAtIso":"${at(DAY)}","ciGate":"success","__proto__":{"polluted":true}}`,
    ) as Record<string, unknown>;
    expect(Object.hasOwn(badHead, '__proto__')).toBe(true);
    expect(evaluateShadowGateAgreement(gateInput([badHead]))).toEqual(INVALID);
    const probe: Record<string, unknown> = {};
    expect(probe.polluted).toBeUndefined();
  });

  it('a function returning a constant verdict would fail', () => {
    const passing = evaluateShadowGateAgreement(gateInput(agreeing(SHADOW_GATE_MIN_AGREEING_HEADS)));
    const failing = evaluateShadowGateAgreement(gateInput(agreeing(SHADOW_GATE_MIN_AGREEING_HEADS - 1)));
    expect(passing).toEqual(PASS_30);
    expect(failing.status).toBe('fail');
    expect(passing).not.toEqual(failing);
  });

  it('an identity echo of the input would fail', () => {
    const input = gateInput(agreeing(SHADOW_GATE_MIN_AGREEING_HEADS));
    const result = evaluateShadowGateAgreement(input);
    expect(result).not.toBe(input);
    expect(result).not.toHaveProperty('heads');
    expect(result).not.toHaveProperty('day');
    const encoded = JSON.stringify(result);
    expect(encoded).not.toContain(oid(1));
    expect(encoded).not.toContain(at(DAY));
    expect(result).toEqual(PASS_30);
  });
});
