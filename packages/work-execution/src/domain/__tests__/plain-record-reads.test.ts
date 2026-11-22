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

  it('refuses an accessor at index i; the walk reads no getter, the pre-probe may read it once (documented bound)', () => {
    let getterCalls = 0;
    const value: unknown[] = ['a', 'b'];
    Object.defineProperty(value, 1, {
      get() {
        getterCalls += 1;
        return 'x';
      },
      enumerable: true,
      configurable: true,
    });
    expect(readBoundedDenseArray(value, 8)).toBeNull();
    // Bound (BL06a fallback): the structuredClone pre-probe — the only
    // trap-free Proxy refusal available in the domain layer — walks
    // cloneable data, so the accessor is read exactly once during the
    // probe and then refused by the descriptor walk, which itself never
    // performs a [[Get]].
    expect(getterCalls).toBe(1);
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

  it('rejects a consistent-liar Proxy outright: it reports an empty array while proxy[0] is still x', () => {
    // The traps satisfy every Proxy invariant (length is reported as a
    // non-configurable, non-enumerable data property like the real target's
    // own length), so reflection alone cannot detect the lie.
    const proxied = new Proxy(['x'], {
      getOwnPropertyDescriptor(t, prop) {
        if (prop === 'length') {
          return { value: 0, writable: true, enumerable: false, configurable: false };
        }
        return undefined;
      },
      ownKeys: () => ['length'],
    });
    expect(proxied[0]).toBe('x');
    expect(readBoundedDenseArray(proxied, 8)).toBeNull();
  });

  it('rejects every Proxy outright: traps count calls and prove no get, descriptor, ownKeys, or prototype trap ever ran', () => {
    let getTraps = 0;
    let descriptorTraps = 0;
    let ownKeysTraps = 0;
    let getPrototypeOfTraps = 0;
    const proxied = new Proxy(['x'], {
      get(target, prop, receiver) {
        getTraps += 1;
        return Reflect.get(target, prop, receiver);
      },
      getOwnPropertyDescriptor(target, prop) {
        descriptorTraps += 1;
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
      ownKeys(target) {
        ownKeysTraps += 1;
        return Reflect.ownKeys(target);
      },
      getPrototypeOf(target) {
        getPrototypeOfTraps += 1;
        return Reflect.getPrototypeOf(target);
      },
    });
    expect(readBoundedDenseArray(proxied, 8)).toBeNull();
    expect(getTraps).toBe(0);
    expect(descriptorTraps).toBe(0);
    expect(ownKeysTraps).toBe(0);
    expect(getPrototypeOfTraps).toBe(0);
  });

  it('copies slot objects from descriptors; the pre-probe may read a nested slot getter once (documented bound)', () => {
    let calls = 0;
    const slot = Object.defineProperty({}, 'x', {
      enumerable: true,
      get() {
        calls += 1;
        return 1;
      },
    });
    const input: unknown[] = [slot];
    const result = readBoundedDenseArray(input, 8);
    expect(result).toEqual({ array: [slot], length: 1 });
    expect(result?.array[0]).toBe(slot);
    // Bound (BL06a fallback): lint:arch refuses the `node:util` builtin in
    // the domain layer (`types.isProxy`), so the structuredClone pre-probe
    // is the only trap-free Proxy refusal and it walks cloneable data —
    // the nested getter runs exactly once, during the probe. The returned
    // copy still comes solely from the descriptor walk, never from the
    // probe's read.
    expect(calls).toBe(1);
  });

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

  it('rejects a transparent Proxy over a valid array outright (no get trap runs)', () => {
    let getTraps = 0;
    const valid = ['a', 'b'];
    const proxied = new Proxy(valid, {
      get(target, prop, receiver) {
        getTraps += 1;
        return Reflect.get(target, prop, receiver);
      },
    });
    expect(readBoundedDenseArray(proxied, 8)).toBeNull();
    expect(getTraps).toBe(0);
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

  it('rejects a Proxy that spoofs a descriptor between reads outright: no get trap runs', () => {
    let spoofAttempts = 0;
    let getTraps = 0;
    const valid = ['a', 'b'];
    const proxied = new Proxy(valid, {
      get(target, prop, receiver) {
        getTraps += 1;
        return Reflect.get(target, prop, receiver);
      },
      getOwnPropertyDescriptor(target, prop) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, prop);
        if (prop === '1' && descriptor !== undefined) {
          spoofAttempts += 1;
          if (spoofAttempts > 1) {
            // Second request for the same index: change the answer.
            return { get() { return 'spoofed'; }, enumerable: true, configurable: true };
          }
        }
        return descriptor;
      },
    });
    expect(readBoundedDenseArray(proxied, 8)).toBeNull();
    expect(getTraps).toBe(0);
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
