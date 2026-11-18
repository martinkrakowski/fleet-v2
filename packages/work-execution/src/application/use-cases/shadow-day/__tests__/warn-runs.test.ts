// RC1: the pure early-warning count read behind `cutover shadow record-day`.
// Every hostile input is refused with the typed `runs-unreadable` unknown —
// the assertion names the code, never merely "nothing threw" — and the warn
// boundary sits between 1500 (false) and 1501 (true).
import { describe, expect, it } from 'vitest';

import {
  checkLaneRunWarnCount,
  SHADOW_FACTS_MAX_RUNS,
  SHADOW_FACTS_WARN_MAX_SCAN,
  SHADOW_FACTS_WARN_RUNS,
} from '../conducted-facts.js';

const UNKNOWN = { status: 'unknown', reason: 'runs-unreadable' };

/** A dense array of `count` inert data elements. */
function denseArray(count: number): unknown[] {
  return Array.from({ length: count }, (_, index) => ({ runId: `run-${index}` }));
}

describe('checkLaneRunWarnCount (RC1)', () => {
  it('refuses null', () => {
    expect(checkLaneRunWarnCount(null)).toEqual(UNKNOWN);
  });

  it('refuses undefined', () => {
    expect(checkLaneRunWarnCount(undefined)).toEqual(UNKNOWN);
  });

  it('refuses a number where a list is due', () => {
    expect(checkLaneRunWarnCount(1501)).toEqual(UNKNOWN);
  });

  it('refuses a string where a list is due', () => {
    expect(checkLaneRunWarnCount('1501')).toEqual(UNKNOWN);
  });

  it('refuses a non-iterable object where a list is due', () => {
    expect(checkLaneRunWarnCount({})).toEqual(UNKNOWN);
  });

  it('refuses an array-like object { length: 1, 0: ... }', () => {
    expect(checkLaneRunWarnCount({ length: 1, 0: { runId: 'run-1' } })).toEqual(UNKNOWN);
  });

  it('refuses a sparse array (a hole)', () => {
    const sparse: unknown[] = denseArray(2);
    delete sparse[0];
    expect(sparse.length).toBe(2);
    expect(checkLaneRunWarnCount(sparse)).toEqual(UNKNOWN);
  });

  it('refuses a foreign own key produced by JSON.parse (__proto__)', () => {
    const polluted: unknown = JSON.parse('{"__proto__": {}}');
    expect(checkLaneRunWarnCount(polluted)).toEqual(UNKNOWN);
    // A real dense array carrying a prototype-polluting own key is refused too.
    const array = [{}] as unknown[];
    Object.defineProperty(array, '__proto__', { value: {}, enumerable: true, configurable: true });
    expect(checkLaneRunWarnCount(array)).toEqual(UNKNOWN);
  });

  it('refuses a constructor own key produced by JSON.parse', () => {
    const polluted: unknown = JSON.parse('{"constructor": 1}');
    expect(checkLaneRunWarnCount(polluted)).toEqual(UNKNOWN);
  });

  it('refuses a prototype own key produced by JSON.parse', () => {
    const polluted: unknown = JSON.parse('{"prototype": 1}');
    expect(checkLaneRunWarnCount(polluted)).toEqual(UNKNOWN);
  });

  it('refuses an enormous length (2**32 - 1) before any traversal', () => {
    const sparse = [] as unknown[];
    Object.defineProperty(sparse, 'length', { value: 2 ** 32 - 1 });
    expect(sparse.length).toBe(2 ** 32 - 1);
    expect(checkLaneRunWarnCount(sparse)).toEqual(UNKNOWN);
  });

  it('refuses a length past SHADOW_FACTS_WARN_MAX_SCAN before any traversal', () => {
    const sparse = [] as unknown[];
    Object.defineProperty(sparse, 'length', { value: SHADOW_FACTS_WARN_MAX_SCAN + 1 });
    expect(checkLaneRunWarnCount(sparse)).toEqual(UNKNOWN);
  });

  it('refuses a getter on the root without invoking it', () => {
    let getterCalls = 0;
    // A real array's `length` cannot be redefined as an accessor, so the
    // accessor reaches the read through a `getOwnPropertyDescriptor` trap.
    const root = new Proxy(denseArray(2), {
      getOwnPropertyDescriptor(target, key) {
        if (key === 'length') {
          return {
            get() {
              getterCalls += 1;
              return 2;
            },
            enumerable: true,
            configurable: true,
          };
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    expect(checkLaneRunWarnCount(root)).toEqual(UNKNOWN);
    expect(getterCalls).toBe(0);
  });

  it('refuses a getter on an item without invoking it', () => {
    let getterCalls = 0;
    const items: unknown[] = denseArray(2);
    Object.defineProperty(items, 1, {
      get() {
        getterCalls += 1;
        return { runId: 'run-x' };
      },
      enumerable: true,
      configurable: true,
    });
    expect(checkLaneRunWarnCount(items)).toEqual(UNKNOWN);
    expect(getterCalls).toBe(0);
  });

  it('yields exactly the plain-data verdict for a Proxy over a valid input, with no get trap run', () => {
    let getTraps = 0;
    const valid = denseArray(1501);
    const proxy = new Proxy(valid, {
      get(target, key, receiver) {
        getTraps += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(checkLaneRunWarnCount(proxy)).toEqual({ status: 'ok', count: 1501, warn: true });
    // Only `ownKeys` and `getOwnPropertyDescriptor` traps are exercised; a
    // `get` trap would mean an element or the length was read by value.
    expect(getTraps).toBe(0);
  });

  it('refuses a throwing Proxy instead of propagating the throw', () => {
    const throwing = new Proxy([{}] as unknown[], {
      ownKeys() {
        throw new Error('hostile ownKeys trap');
      },
    });
    expect(checkLaneRunWarnCount(throwing)).toEqual(UNKNOWN);
  });

  it('reports the boundary: 1500 runs is not a warning, 1501 runs is', () => {
    expect(checkLaneRunWarnCount(denseArray(1500))).toEqual({
      status: 'ok',
      count: 1500,
      warn: false,
    });
    expect(checkLaneRunWarnCount(denseArray(1501))).toEqual({
      status: 'ok',
      count: 1501,
      warn: true,
    });
  });

  it('is not satisfiable by a constant verdict: the count and warn verdict follow the real length', () => {
    expect(checkLaneRunWarnCount(denseArray(0))).toEqual({ status: 'ok', count: 0, warn: false });
    expect(checkLaneRunWarnCount(denseArray(3))).toEqual({ status: 'ok', count: 3, warn: false });
    // A constant-verdict implementation (always `{ count: 0, warn: false }`)
    // fails the 1501 case above; a constant `warn: true` fails this one.
    expect(checkLaneRunWarnCount(denseArray(SHADOW_FACTS_WARN_RUNS))).toMatchObject({ warn: false });
  });

  it('is not satisfiable by an identity echo of the input', () => {
    const input = { length: 1501, 0: { runId: 'run-1' } };
    // An identity echo would hand back the object; the real read refuses it.
    const verdict = checkLaneRunWarnCount(input);
    expect(verdict).not.toBe(input);
    expect(verdict).toEqual(UNKNOWN);
  });

  it('keeps the constants beside the deferred cap they relate to', () => {
    expect(SHADOW_FACTS_WARN_RUNS).toBe(1500);
    expect(SHADOW_FACTS_WARN_MAX_SCAN).toBe(100_000);
    // The 2000-run cap is deferred, not removed.
    expect(SHADOW_FACTS_MAX_RUNS).toBe(2000);
  });
});
