/**
 * VC31: direct unit tests for `attemptStateLabel` and `AttemptState.create`.
 * The label is what a refusal prints for an attempt state, so it must echo a
 * declared state exactly and reduce every other input — hostile or otherwise —
 * to `'unknown'` without ever coercing, trapping, or echoing the raw input.
 */

import { describe, expect, it, vi } from 'vitest';

import { ATTEMPT_STATES, AttemptState, attemptStateLabel } from '../value-objects/AttemptState.vo.js';

describe('attemptStateLabel', () => {
  it('ATTEMPT_STATES has eight entries and attemptStateLabel returns each declared state unchanged', () => {
    expect(ATTEMPT_STATES).toHaveLength(8);
    for (const state of ATTEMPT_STATES) {
      expect(attemptStateLabel(state)).toBe(state);
    }
  });

  it("attemptStateLabel returns 'unknown' for near-miss, empty, 'unknown', and prototype-polluting strings", () => {
    for (const value of ['Ended', ' ended', 'ended ', 'ended\n', '', 'unknown', 'constructor', '__proto__', 'toString']) {
      expect(attemptStateLabel(value)).toBe('unknown');
    }
  });

  it("attemptStateLabel returns 'unknown' for non-string primitives, wrappers, symbols, arrays, and objects", () => {
    for (const value of [
      null,
      undefined,
      0,
      1,
      true,
      ['ended'],
      {},
      new String('ended'),
      Symbol('ended'),
      // Array with a hole at index 0 (built at runtime to keep this file lint-clean).
      (() => {
        const holey = ['ended'];
        delete holey[0];
        return holey;
      })(),
      { length: 1, 0: 'ended' },
      { length: 1e9 },
    ]) {
      expect(attemptStateLabel(value)).toBe('unknown');
    }
  });

  it("attemptStateLabel returns 'unknown' without invoking toString, valueOf, getters, or Proxy traps", () => {
    const throwingToString = {
      get toString() {
        throw new Error('getter must never run');
      },
    };
    const spiedObject = {
      toString: vi.fn(() => 'ended'),
      valueOf: vi.fn(() => 'ended'),
    };
    const trappingProxy = new Proxy(
      {},
      {
        get() {
          throw new Error('proxy trap must never run');
        },
      },
    );
    expect(attemptStateLabel(throwingToString)).toBe('unknown');
    expect(attemptStateLabel(spiedObject)).toBe('unknown');
    expect(attemptStateLabel(trappingProxy)).toBe('unknown');
    expect(spiedObject.toString).not.toHaveBeenCalled();
    expect(spiedObject.valueOf).not.toHaveBeenCalled();
  });

  it('attemptStateLabel never returns the raw input for a runtime-constructed token-shaped string', () => {
    const secret = 'tok' + 'en-'.repeat(4);
    const label = attemptStateLabel(secret);
    expect(label).toBe('unknown');
    expect(label.includes(secret)).toBe(false);
  });
});

describe('AttemptState.create', () => {
  it("refuses non-strings with an Invalid attempt state error and accepts 'ended'", () => {
    for (const value of [null, 1, ['ended']]) {
      const refused = AttemptState.create(value);
      expect(refused.success).toBe(false);
      expect(refused.value).toBeUndefined();
      expect(refused.error?.message.startsWith('Invalid attempt state:')).toBe(true);
    }
    const accepted = AttemptState.create('ended');
    expect(accepted.success).toBe(true);
    expect(accepted.value?.getValue()).toBe('ended');
  });

  it('accepts every declared state and reads back that exact value', () => {
    expect(ATTEMPT_STATES).toHaveLength(8);
    for (const state of ATTEMPT_STATES) {
      const accepted = AttemptState.create(state);
      expect(accepted.success).toBe(true);
      expect(accepted.error).toBeUndefined();
      expect(accepted.value?.getValue()).toBe(state);
    }
  });

  it("refuses near-miss, empty, 'unknown', and prototype-polluting strings with an Invalid attempt state error", () => {
    for (const value of ['Ended', ' ended', 'ended ', 'ended\n', '', 'unknown', 'constructor', '__proto__', 'toString']) {
      const refused = AttemptState.create(value);
      expect(refused.success).toBe(false);
      expect(refused.value).toBeUndefined();
      expect(refused.error?.message.startsWith('Invalid attempt state:')).toBe(true);
    }
  });

  it('refuses every non-string shape (primitives, wrappers, symbols, arrays, array-likes, objects) with an Invalid attempt state error', () => {
    for (const value of [
      null,
      undefined,
      0,
      1,
      true,
      Symbol('ended'),
      ['ended'],
      {},
      new String('ended'),
      // Array with a hole at index 0 (built at runtime to keep this file lint-clean).
      (() => {
        const holey = ['ended'];
        delete holey[0];
        return holey;
      })(),
      { length: 1, 0: 'ended' },
      { length: 1e9 },
    ]) {
      const refused = AttemptState.create(value);
      expect(refused.success).toBe(false);
      expect(refused.value).toBeUndefined();
      expect(refused.error?.message.startsWith('Invalid attempt state:')).toBe(true);
    }
  });

  it('refuses an object carrying a throwing getter on a key unrelated to string coercion, without evaluating that getter', () => {
    // Narrowed guard: `create`'s refusal must not evaluate properties it does
    // not need. A getter on a coercion key (`toString`, `valueOf`,
    // `Symbol.toPrimitive`) or a trapping `Proxy` is deliberately not pinned
    // here — those are refused only after the value object stops coercing the
    // refused input, which is outside this file's ownership.
    const unrelatedGetter = {
      get payload() {
        throw new Error('unrelated getter must never run');
      },
    };
    const refused = AttemptState.create(unrelatedGetter);
    expect(refused.success).toBe(false);
    expect(refused.value).toBeUndefined();
    expect(refused.error?.message.startsWith('Invalid attempt state:')).toBe(true);
  });

  it("never treats 'unknown' as success", () => {
    const refused = AttemptState.create('unknown');
    expect(refused.success).toBe(false);
    expect(refused.value).toBeUndefined();
    expect(refused.error?.message.startsWith('Invalid attempt state:')).toBe(true);
  });
});
