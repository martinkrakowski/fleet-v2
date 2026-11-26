/**
 * Hostile-input and decision tests for `evaluateSpendCaps` (XS04). The function
 * takes `unknown`, never throws, and every refusal is a typed result.
 */

import { describe, expect, it } from 'vitest';

import { evaluateSpendCaps } from '../value-objects/SpendCap.vo.js';

type Scope = { cap: number | null; used: number };
type Shape = { requested: number; organisation: Scope; project: Scope };

function build(requested: number, organisation: Scope, project: Scope): Shape {
  return { requested, organisation, project };
}

function open(): Scope {
  return { cap: null, used: 0 };
}

/** A revoked Proxy throws on every trap. */
function revokedProxy(): unknown {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

function expectRefused(value: unknown, reason: string): void {
  expect(evaluateSpendCaps(value)).toEqual({ decision: 'refused', reason });
}

/** The admitted remaining units (organisation, project), or [] when not admitted. */
function remainingUnits(value: unknown): unknown[] {
  const result = evaluateSpendCaps(value);
  return result.decision === 'admit' ? [result.remaining.organisation, result.remaining.project] : [];
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

describe('evaluateSpendCaps', () => {
  it('refuses null, undefined, primitives, arrays, array-likes, and non-plain prototypes', () => {
    const notPlain: unknown[] = [null, undefined, 42, 'x', true, 1n, [], new Array(3), new Map(), new Date(0)];
    for (const value of notPlain) {
      expectRefused(value, 'not-a-plain-object');
    }
    const inherited: Record<string, unknown> = Object.create({});
    Object.assign(inherited, build(1, open(), open()));
    expectRefused(inherited, 'not-a-plain-object');
    expectRefused({ length: 1, 0: 'a' }, 'wrong-keys');
    expectRefused({ length: Number.MAX_SAFE_INTEGER, 0: 'a' }, 'wrong-keys');
    expectRefused({ length: 3, 0: 'a', 1: 'b' }, 'wrong-keys');
  });

  it('refuses missing or non-object organisation or project scope', () => {
    expectRefused({ requested: 1, project: open() }, 'wrong-keys');
    expectRefused({ requested: 1, organisation: open() }, 'wrong-keys');
    for (const bad of [null, undefined, 7, 'x', true, 1n, [], new Array(2)]) {
      expectRefused({ requested: 1, organisation: bad, project: open() }, 'not-a-plain-object');
      expectRefused({ requested: 1, organisation: open(), project: bad }, 'not-a-plain-object');
    }
  });

  it('refuses extra unknown keys, missing keys, non-enumerable keys, symbol keys, and __proto__ keys', () => {
    expectRefused({ ...build(1, open(), open()), extra: 1 }, 'wrong-keys');
    expectRefused({ requested: 1, organisation: open(), extra: open() }, 'wrong-keys');
    expectRefused({ requested: 1, organisation: { used: 0 }, project: open() }, 'wrong-keys');
    expectRefused({ requested: 1, organisation: { cap: null, used: 0, extra: 1 }, project: open() }, 'wrong-keys');
    expectRefused({ requested: 1, organisation: { cap: null, other: 0 }, project: open() }, 'wrong-keys');
    const hiddenRoot = build(1, open(), open());
    Object.defineProperty(hiddenRoot, 'requested', { enumerable: false });
    expectRefused(hiddenRoot, 'wrong-keys');
    const hiddenScope = open();
    Object.defineProperty(hiddenScope, 'used', { enumerable: false });
    expectRefused(build(1, hiddenScope, open()), 'wrong-keys');
    expectRefused({ requested: 1, organisation: open(), [Symbol('extra')]: open() }, 'wrong-keys');
    expectRefused({ ...build(1, open(), open()), [Symbol('extra')]: 1 }, 'wrong-keys');
    expectRefused({ requested: 1, organisation: { cap: null, [Symbol('extra')]: 0 }, project: open() }, 'wrong-keys');
    const rootProto = '{"requested":1,"organisation":{"cap":null,"used":0},"__proto__":{"project":{"cap":null,"used":0}}}';
    expectRefused(JSON.parse(rootProto), 'wrong-keys');
    const scopeProto = '{"cap":null,"__proto__":{"used":0}}';
    expectRefused({ requested: 1, organisation: JSON.parse(scopeProto), project: open() }, 'wrong-keys');
    expect(Object.hasOwn(Object.prototype, 'project')).toBe(false);
    expect(Object.hasOwn(Object.prototype, 'used')).toBe(false);
    const crowd: Record<string, number> = {};
    for (let index = 0; index < 5000; index += 1) {
      crowd['k' + String(index)] = index;
    }
    expectRefused(crowd, 'wrong-keys');
  });

  it('refuses an accessor property without invoking its getter', () => {
    let calls = 0;
    const getter = {
      enumerable: true,
      configurable: true,
      get() {
        calls += 1;
        throw new Error('the getter must never run');
      },
    };
    const rootGetter = { organisation: open(), project: open() };
    Object.defineProperty(rootGetter, 'requested', getter);
    expectRefused(rootGetter, 'accessor-property');
    const scopeGetter = { requested: 1, project: open() };
    Object.defineProperty(scopeGetter, 'organisation', getter);
    expectRefused(scopeGetter, 'accessor-property');
    for (const key of ['cap', 'used']) {
      const scope: Record<string, unknown> = { cap: null, used: 0 };
      Object.defineProperty(scope, key, getter);
      expectRefused({ requested: 1, organisation: scope, project: open() }, 'accessor-property');
    }
    const setterOnly = { requested: 1, organisation: open() };
    Object.defineProperty(setterOnly, 'project', { enumerable: true, configurable: true, set: () => undefined });
    expectRefused(setterOnly, 'accessor-property');
    expect(calls).toBe(0);
  });

  it('refuses a revoked Proxy without throwing', () => {
    expectRefused(revokedProxy(), 'unreadable-input');
    expectRefused({ requested: 1, organisation: revokedProxy(), project: open() }, 'unreadable-input');
    expectRefused({ requested: 1, organisation: open(), project: revokedProxy() }, 'unreadable-input');
    const boom = (): never => {
      throw new Error('the trap must be refused, not propagated');
    };
    const handlers: ProxyHandler<Shape>[] = [{ ownKeys: boom }, { getPrototypeOf: boom }, { getOwnPropertyDescriptor: boom }];
    for (const handler of handlers) {
      expectRefused(new Proxy(build(1, open(), open()), handler), 'unreadable-input');
    }
  });

  it('reads a Proxy only through descriptors and never runs its get trap', () => {
    let gets = 0;
    const watched = new Proxy(build(1, open(), open()), {
      get() {
        gets += 1;
        throw new Error('the get trap must never run');
      },
    });
    expect(evaluateSpendCaps(watched)).toEqual({ decision: 'admit', remaining: { organisation: null, project: null } });
    expect(gets).toBe(0);
  });

  it('refuses fractional, negative, NaN, Infinity, string, bigint, and undefined numeric fields', () => {
    const bad: unknown[] = [1.5, -1, NaN, Infinity, -Infinity, '1', 1n, undefined, null, -0, 2 ** 53, true, {}];
    for (const value of bad) {
      expectRefused({ requested: value, organisation: open(), project: open() }, 'invalid-requested');
      expectRefused({ requested: 1, organisation: { cap: null, used: value }, project: open() }, 'invalid-used');
      expectRefused({ requested: 1, organisation: open(), project: { cap: null, used: value } }, 'invalid-used');
    }
    for (const value of bad.filter((entry) => entry !== null)) {
      expectRefused({ requested: 1, organisation: { cap: value, used: 0 }, project: open() }, 'invalid-cap');
      expectRefused({ requested: 1, organisation: open(), project: { cap: value, used: 0 } }, 'invalid-cap');
    }
  });

  it('refuses requested greater than 10_000_000', () => {
    expectRefused(build(10_000_001, open(), open()), 'requested-above-bound');
    expectRefused(build(Number.MAX_SAFE_INTEGER, open(), open()), 'requested-above-bound');
    expect(evaluateSpendCaps(build(10_000_000, open(), open()))).toEqual({
      decision: 'admit',
      remaining: { organisation: null, project: null },
    });
  });

  it('refuses used + requested exceeding Number.MAX_SAFE_INTEGER', () => {
    const max = Number.MAX_SAFE_INTEGER;
    expectRefused(build(1, { cap: null, used: max }, open()), 'sum-overflow');
    expectRefused(build(1, open(), { cap: max, used: max }), 'sum-overflow');
    expectRefused(build(10_000_000, { cap: null, used: max - 9_999_999 }, open()), 'sum-overflow');
    expect(evaluateSpendCaps(build(10_000_000, { cap: null, used: max - 10_000_000 }, open()))).toEqual({
      decision: 'admit',
      remaining: { organisation: null, project: null },
    });
    expect(evaluateSpendCaps(build(1, { cap: max, used: max - 1 }, open()))).toEqual({
      decision: 'admit',
      remaining: { organisation: 0, project: null },
    });
    expect(remainingUnits(build(0, open(), { cap: max, used: max }))).toEqual([null, 0]);
  });

  it('parks with reason spend-cap when project, organisation, or both scopes are exhausted in fixed order', () => {
    const full = (): Scope => ({ cap: 5, used: 5 });
    const roomy = (): Scope => ({ cap: 100, used: 0 });
    expect(evaluateSpendCaps(build(1, roomy(), full()))).toEqual({
      decision: 'park',
      reason: 'spend-cap',
      exhausted: ['project'],
    });
    expect(evaluateSpendCaps(build(1, full(), roomy()))).toEqual({
      decision: 'park',
      reason: 'spend-cap',
      exhausted: ['organisation'],
    });
    expect(evaluateSpendCaps(build(1, full(), full()))).toEqual({
      decision: 'park',
      reason: 'spend-cap',
      exhausted: ['project', 'organisation'],
    });
  });

  it('parks at cap 0 when requested is 1 and admits at cap 0 when requested is 0', () => {
    const zero = (): Scope => ({ cap: 0, used: 0 });
    const units = remainingUnits(build(0, zero(), zero()));
    expect(units).toHaveLength(2);
    expect(units.every((unit) => Object.is(unit, 0))).toBe(true);
    expect(evaluateSpendCaps(build(1, zero(), zero()))).toEqual({
      decision: 'park',
      reason: 'spend-cap',
      exhausted: ['project', 'organisation'],
    });
  });

  it('admits at exact cap when requested is 0 and parks when one unit over', () => {
    const atCap = (): Scope => ({ cap: 7, used: 7 });
    expect(remainingUnits(build(0, atCap(), atCap()))).toEqual([0, 0]);
    expect(evaluateSpendCaps(build(1, atCap(), atCap()))).toEqual({
      decision: 'park',
      reason: 'spend-cap',
      exhausted: ['project', 'organisation'],
    });
    expect(remainingUnits(build(1, { cap: 7, used: 6 }, { cap: 7, used: 6 }))).toEqual([0, 0]);
    expect(evaluateSpendCaps(build(2, { cap: 7, used: 6 }, open()))).toEqual({
      decision: 'park',
      reason: 'spend-cap',
      exhausted: ['organisation'],
    });
  });

  it('admits when within cap and computes remaining as cap - used - requested', () => {
    expect(evaluateSpendCaps(build(2, { cap: 10, used: 3 }, { cap: 4, used: 1 }))).toEqual({
      decision: 'admit',
      remaining: { organisation: 5, project: 1 },
    });
    expect(remainingUnits(build(0, { cap: 10, used: 3 }, { cap: 4, used: 1 }))).toEqual([7, 3]);
    expect(remainingUnits(build(7, { cap: 10, used: 3 }, { cap: 40, used: 1 }))).toEqual([0, 32]);
  });

  it('never parks on cap null and reports remaining null for uncapped scopes', () => {
    const max = Number.MAX_SAFE_INTEGER;
    expect(evaluateSpendCaps(build(10_000_000, { cap: null, used: max - 10_000_000 }, { cap: null, used: 1 }))).toEqual({
      decision: 'admit',
      remaining: { organisation: null, project: null },
    });
    expect(evaluateSpendCaps(build(5, { cap: null, used: 1_000_000 }, { cap: 50, used: 0 }))).toEqual({
      decision: 'admit',
      remaining: { organisation: null, project: 45 },
    });
    expect(evaluateSpendCaps(build(5, { cap: null, used: 0 }, { cap: 4, used: 0 }))).toEqual({
      decision: 'park',
      reason: 'spend-cap',
      exhausted: ['project'],
    });
  });

  it('does not mutate frozen input and returns fresh objects', () => {
    const admitInput = deepFreeze(build(2, { cap: 10, used: 3 }, { cap: 4, used: 1 }));
    const admitBefore = JSON.stringify(admitInput);
    const first = evaluateSpendCaps(admitInput);
    const second = evaluateSpendCaps(admitInput);
    if (first.decision !== 'admit' || second.decision !== 'admit') {
      throw new Error('expected both calls to admit');
    }
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.remaining).not.toBe(second.remaining);
    expect(Object.isFrozen(first)).toBe(false);
    expect(JSON.stringify(admitInput)).toBe(admitBefore);
    const parkInput = deepFreeze(build(5, { cap: 5, used: 5 }, { cap: 5, used: 5 }));
    const parkBefore = JSON.stringify(parkInput);
    const parked = evaluateSpendCaps(parkInput);
    const parkedAgain = evaluateSpendCaps(parkInput);
    if (parked.decision !== 'park' || parkedAgain.decision !== 'park') {
      throw new Error('expected both calls to park');
    }
    expect(parked.exhausted).not.toBe(parkedAgain.exhausted);
    expect(Object.isFrozen(parked.exhausted)).toBe(false);
    expect(JSON.stringify(parkInput)).toBe(parkBefore);
  });

  it('accepts a null-prototype record as a plain object', () => {
    const root = Object.assign(Object.create(null), build(1, { cap: 3, used: 1 }, open())) as Shape;
    expect(evaluateSpendCaps(root)).toEqual({ decision: 'admit', remaining: { organisation: 1, project: null } });
  });
});
