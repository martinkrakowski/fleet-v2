/**
 * BL06a hostile-input tests for `readBoundedDenseArray`: it takes `unknown`
 * at its boundary and never throws — each refusal is the typed `null`
 * result, and no getter or Proxy `get` trap ever runs.
 */

import { describe, expect, it } from 'vitest';

import { readBoundedDenseArray } from '../plain-record-reads.js';

/** A revoked Proxy throws on every trap, including [[GetPrototypeOf]]. */
function revokedProxy(): unknown {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

/** A Proxy reporting a fake own `length` data descriptor for its target. */
function proxyWithLength(target: unknown[], length: number): unknown {
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

describe('readBoundedDenseArray', () => {
  it('reads a dense array of own enumerable data elements', () => {
    expect(readBoundedDenseArray(['a', 'b', 3], 8)).toEqual({ array: ['a', 'b', 3], length: 3 });
    expect(readBoundedDenseArray([], 8)).toEqual({ array: [], length: 0 });
  });

  it('refuses null', () => {
    expect(readBoundedDenseArray(null, 8)).toBeNull();
  });

  it('refuses undefined', () => {
    expect(readBoundedDenseArray(undefined, 8)).toBeNull();
  });

  it('refuses a wrong primitive (a number where a list is due)', () => {
    expect(readBoundedDenseArray(7, 8)).toBeNull();
  });

  it('refuses a non-iterable object where a list is due', () => {
    expect(readBoundedDenseArray({ 0: 'a', 1: 'b' }, 8)).toBeNull();
  });

  it('refuses an array-like object { length: 1, 0: ... }', () => {
    expect(readBoundedDenseArray({ length: 1, 0: 'a' }, 8)).toBeNull();
  });

  it('refuses a subclassed array whose prototype is not Array.prototype', () => {
    class Sub extends Array {}
    expect(readBoundedDenseArray(Object.setPrototypeOf([1, 2], Sub.prototype), 8)).toBeNull();
  });

  it('refuses a revoked Proxy without throwing', () => {
    expect(readBoundedDenseArray(revokedProxy(), 8)).toBeNull();
  });

  it('refuses an accessor length in O(1) before any key enumeration', () => {
    let getterCalls = 0;
    let ownKeysCalls = 0;
    const target: unknown[] = [];
    const proxied = new Proxy(target, {
      getOwnPropertyDescriptor(t, prop) {
        if (prop === 'length') {
          return {
            get() {
              getterCalls += 1;
              throw new Error('the length getter must never run');
            },
            enumerable: true,
            configurable: true,
          };
        }
        return Reflect.getOwnPropertyDescriptor(t, prop);
      },
      ownKeys(t) {
        ownKeysCalls += 1;
        return Reflect.ownKeys(t);
      },
    });
    expect(readBoundedDenseArray(proxied, 8)).toBeNull();
    expect(getterCalls).toBe(0);
    expect(ownKeysCalls).toBe(0);
  });

  it('refuses a non-safe-integer length reported by an own length descriptor', () => {
    expect(readBoundedDenseArray(proxyWithLength(['a', 'b'], 2.5), 8)).toBeNull();
  });

  it('refuses a negative length', () => {
    expect(readBoundedDenseArray(proxyWithLength(['a'], -1), 8)).toBeNull();
  });

  it('refuses an enormous sparse length (2**32 - 1) before any traversal or key enumeration', () => {
    let ownKeysCalls = 0;
    const proxied = new Proxy([], {
      getOwnPropertyDescriptor(t, prop) {
        const descriptor = Reflect.getOwnPropertyDescriptor(t, prop);
        if (prop === 'length' && descriptor !== undefined) {
          return { ...descriptor, value: 2 ** 32 - 1 };
        }
        return descriptor;
      },
      ownKeys(t) {
        ownKeysCalls += 1;
        return Reflect.ownKeys(t);
      },
    });
    expect(readBoundedDenseArray(proxied, 8)).toBeNull();
    expect(ownKeysCalls).toBe(0);
  });

  it('refuses a length above the cap', () => {
    expect(readBoundedDenseArray(['a', 'b', 'c'], 2)).toBeNull();
  });

  it('refuses an invalid cap', () => {
    expect(readBoundedDenseArray(['a'], -1)).toBeNull();
    expect(readBoundedDenseArray(['a'], 1.5)).toBeNull();
    expect(readBoundedDenseArray(['a'], Number.NaN)).toBeNull();
  });

  it('refuses an array hole (a sparse array)', () => {
    const value: unknown[] = ['a'];
    value[2] = 'c';
    expect(readBoundedDenseArray(value, 8)).toBeNull();
  });

  it('refuses a non-enumerable index', () => {
    const value: unknown[] = ['a', 'b'];
    Object.defineProperty(value, 1, { value: 'b', enumerable: false, configurable: true, writable: true });
    expect(readBoundedDenseArray(value, 8)).toBeNull();
  });

  it('refuses a symbol own key', () => {
    const value: unknown[] = ['a'];
    (value as unknown as Record<symbol, unknown>)[Symbol('tag')] = 'x';
    expect(readBoundedDenseArray(value, 8)).toBeNull();
  });

  it.each(['__proto__', 'constructor', 'prototype', '01'])(
    'refuses the extra own key %s on a real array so the canonical-key loop must run',
    (key) => {
      const value: unknown[] = ['x'];
      Object.defineProperty(value, key, { value: 1, enumerable: true, configurable: true, writable: true });
      expect(readBoundedDenseArray(value, 8)).toBeNull();
    },
  );

  it('refuses an index descriptor without a value ({ get: undefined, set: undefined })', () => {
    const value: unknown[] = ['a'];
    Object.defineProperty(value, 0, { get: undefined, set: undefined, enumerable: true, configurable: true });
    expect(readBoundedDenseArray(value, 8)).toBeNull();
  });

  it('refuses a length key that is an accessor (on the root, counter stays 0)', () => {
    let getterCalls = 0;
    const value: Record<string, unknown> = { 0: 'a' };
    Object.defineProperty(value, 'length', {
      get() {
        getterCalls += 1;
        return 1;
      },
      enumerable: true,
      configurable: true,
    });
    expect(readBoundedDenseArray(value, 8)).toBeNull();
    expect(getterCalls).toBe(0);
  });

  it('returns null when a Proxy descriptor trap throws for an index (never propagates)', () => {
    const valid = ['a', 'b'];
    const proxied = new Proxy(valid, {
      getOwnPropertyDescriptor(target, prop) {
        if (prop === '0') {
          throw new Error('hostile descriptor trap');
        }
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
    });
    expect(readBoundedDenseArray(proxied, 8)).toBeNull();
  });

  it('returns null when a Proxy descriptor trap throws during the per-index read', () => {
    const valid = ['a', 'b'];
    const proxied = new Proxy(valid, {
      getOwnPropertyDescriptor(target, prop) {
        if (prop === '1') {
          throw new Error('hostile descriptor trap');
        }
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
    });
    expect(readBoundedDenseArray(proxied, 8)).toBeNull();
  });

  // Cost bound: O(1) per-index descriptor check within the O(cap) loop.
  it('refuses an index accessor (getter never runs) and an index descriptor whose Proxy reports an accessor despite value being present', () => {
    let getterCalls = 0;
    const value: unknown[] = ['a'];
    Object.defineProperty(value, 0, {
      get() {
        getterCalls += 1;
        return 'a';
      },
      enumerable: true,
      configurable: true,
    });
    expect(readBoundedDenseArray(value, 8)).toBeNull();
    expect(getterCalls).toBe(0);

    // A Proxy reports a descriptor that has both `value` and a `get`, so
    // `'value' in descriptor` alone would pass: `descriptor.get !== undefined`
    // must refuse it, and the getter must never run.
    const proxied = new Proxy(['a'] as unknown[], {
      getOwnPropertyDescriptor(t, prop) {
        const descriptor = Reflect.getOwnPropertyDescriptor(t, prop);
        if (prop === '0' && descriptor !== undefined) {
          return {
            ...descriptor,
            get() {
              getterCalls += 1;
              return 'a';
            },
          };
        }
        return descriptor;
      },
    });
    expect(readBoundedDenseArray(proxied, 8)).toBeNull();
    expect(getterCalls).toBe(0);
  });

  // Cost bound: O(cap) — exactly one descriptor read per index, no re-read.
  it('reads each index from a single descriptor so a Proxy spoofing the second read cannot leak a flipped accessor or value', () => {
    let descriptorCallsForZero = 0;
    let getterCalls = 0;
    const target = ['safe'];
    const proxied = new Proxy(target, {
      getOwnPropertyDescriptor(t, prop) {
        if (prop === '0') {
          descriptorCallsForZero += 1;
          if (descriptorCallsForZero === 1) {
            return { value: 'safe', writable: true, enumerable: true, configurable: true };
          }
          return {
            get() {
              getterCalls += 1;
              return 'evil';
            },
            enumerable: true,
            configurable: true,
          };
        }
        return Reflect.getOwnPropertyDescriptor(t, prop);
      },
    });
    expect(readBoundedDenseArray(proxied, 8)).toEqual({ array: ['safe'], length: 1 });
    expect(descriptorCallsForZero).toBe(1);
    expect(getterCalls).toBe(0);
  });

  // Cost bound: O(1) pre-gate before Reflect.ownKeys.
  it('refuses an invariant-legal sparse length of 2**32 - 1 in O(1) even when the cap equals it (ownKeys never runs)', () => {
    let ownKeysCalls = 0;
    const sparse = new Array(2 ** 32 - 1);
    const proxied = new Proxy(sparse, {
      ownKeys(t) {
        ownKeysCalls += 1;
        return Reflect.ownKeys(t);
      },
    });
    expect(readBoundedDenseArray(proxied, 2 ** 32 - 1)).toBeNull();
    expect(ownKeysCalls).toBe(0);
  });

  // Cost bound: O(1) pre-gate before Reflect.ownKeys.
  it('refuses an invariant-legal length of 1_000_000 above the cap in O(1) (ownKeys never runs)', () => {
    let ownKeysCalls = 0;
    const overCap = new Array(1_000_000);
    const proxied = new Proxy(overCap, {
      ownKeys(t) {
        ownKeysCalls += 1;
        return Reflect.ownKeys(t);
      },
    });
    expect(readBoundedDenseArray(proxied, 8)).toBeNull();
    expect(ownKeysCalls).toBe(0);
  });

  it('is not a constant verdict: different inputs give different results', () => {
    const one = readBoundedDenseArray(['a'], 8);
    const two = readBoundedDenseArray(['a', 'b'], 8);
    expect(one).toEqual({ array: ['a'], length: 1 });
    expect(two).toEqual({ array: ['a', 'b'], length: 2 });
    expect(one).not.toEqual(two);
  });

  it('is not an identity echo: the result is a fresh copy, not the input', () => {
    const input = ['a', 'b'];
    const read = readBoundedDenseArray(input, 8);
    expect(read).not.toBeNull();
    expect(read?.array).not.toBe(input);
    input.push('c');
    expect(read?.array).toEqual(['a', 'b']);
  });
});
