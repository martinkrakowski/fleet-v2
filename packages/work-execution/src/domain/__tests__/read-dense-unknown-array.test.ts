/**
 * Hostile-input tests for `readDenseUnknownArray`: it takes `unknown` at its
 * boundary and never throws. Each refusal is the typed `null` result. No
 * getter runs, and the `ownKeys`, `has`, and `get` traps are never consulted.
 */

import { describe, expect, it } from 'vitest';

import { readDenseUnknownArray } from '../held-work-order.js';

/** A revoked Proxy throws on every trap, including `Array.isArray`. */
function revokedProxy(): unknown {
  const { proxy, revoke } = Proxy.revocable(['a', 'b'], {});
  revoke();
  return proxy;
}

/** A Proxy reporting `length` as the given data value and forwarding every other descriptor. */
function proxyWithLength(target: unknown[], length: number): unknown {
  return new Proxy(target, {
    getOwnPropertyDescriptor(inner, prop) {
      const descriptor = Reflect.getOwnPropertyDescriptor(inner, prop);
      if (prop === 'length' && descriptor !== undefined) {
        return { ...descriptor, value: length };
      }
      return descriptor;
    },
  });
}

describe('readDenseUnknownArray', () => {
  it('returns a fresh copy of a dense array within max', () => {
    const input = ['a', 'b'];
    const read = readDenseUnknownArray(input, 8);
    expect(read).toEqual(['a', 'b']);
    expect(read).not.toBe(input);
    expect(readDenseUnknownArray(['a', 'b'], 2)).toEqual(['a', 'b']);
    expect(readDenseUnknownArray([], 0)).toEqual([]);
    expect(readDenseUnknownArray(['a', 1, null], 3)).toEqual(['a', 1, null]);
  });

  it('refuses null and non-array inputs', () => {
    expect(readDenseUnknownArray(null, 8)).toBeNull();
    expect(readDenseUnknownArray(undefined, 8)).toBeNull();
    expect(readDenseUnknownArray(7, 8)).toBeNull();
    expect(readDenseUnknownArray('ab', 8)).toBeNull();
    expect(readDenseUnknownArray({ 0: 'a', length: 1 }, 8)).toBeNull();
    expect(readDenseUnknownArray({ 0: 'a', 1: 'b' }, 8)).toBeNull();
  });

  it('refuses invalid max and length above max', () => {
    expect(readDenseUnknownArray(['a', 'b'], 1)).toBeNull();
    expect(readDenseUnknownArray(['a'], -1)).toBeNull();
    expect(readDenseUnknownArray([], -1)).toBeNull();
    expect(readDenseUnknownArray(['a'], Number.NaN)).toBeNull();
    expect(readDenseUnknownArray(['a'], 1.5)).toBeNull();
    expect(readDenseUnknownArray(['a'], Number.POSITIVE_INFINITY)).toBeNull();
    expect(readDenseUnknownArray(['a'], Number.NEGATIVE_INFINITY)).toBeNull();
    expect(readDenseUnknownArray(proxyWithLength(['a', 'b'], -1), 8)).toBeNull();
    expect(readDenseUnknownArray(proxyWithLength(['a', 'b'], Number.NaN), 8)).toBeNull();
    expect(readDenseUnknownArray(proxyWithLength(['a', 'b'], 1.5), 8)).toBeNull();
  });

  it('refuses an enormous length value', () => {
    expect(readDenseUnknownArray(proxyWithLength(['a'], 2 ** 32 - 1), 8)).toBeNull();
    expect(readDenseUnknownArray(proxyWithLength(['a'], Number.MAX_SAFE_INTEGER), 8)).toBeNull();
    expect(readDenseUnknownArray(proxyWithLength(['a'], 2 ** 53), 8)).toBeNull();
  });

  it('refuses sparse array holes', () => {
    const value: unknown[] = ['a'];
    value[2] = 'c';
    expect(readDenseUnknownArray(value, 8)).toBeNull();

    let getterCalls = 0;
    const proto: object = {};
    Object.defineProperty(proto, '0', {
      get() {
        getterCalls += 1;
        throw new Error('prototype index getter must not run');
      },
      enumerable: true,
      configurable: true,
    });
    const sparse: unknown[] = [];
    Object.setPrototypeOf(sparse, proto);
    sparse.length = 1;
    expect(readDenseUnknownArray(sparse, 8)).toBeNull();
    expect(getterCalls).toBe(0);
  });

  it('copies dense elements without polluting Object.prototype from an own __proto__ key', () => {
    const value = ['a', 'b'];
    Object.defineProperty(value, '__proto__', {
      value: { polluted: true },
      writable: true,
      enumerable: true,
      configurable: true,
    });
    expect(readDenseUnknownArray(value, 8)).toEqual(['a', 'b']);
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });

  it('refuses accessor element without invoking getter', () => {
    let indexGetterCalls = 0;
    const value: unknown[] = ['a'];
    Object.defineProperty(value, 0, {
      get() {
        indexGetterCalls += 1;
        throw new Error('index getter must not run');
      },
      enumerable: true,
      configurable: true,
    });
    expect(readDenseUnknownArray(value, 8)).toBeNull();
    expect(indexGetterCalls).toBe(0);

    let lyingGetterCalls = 0;
    const lyingIndex = new Proxy(['a'], {
      getOwnPropertyDescriptor(target, prop) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, prop);
        if (prop === '0' && descriptor !== undefined) {
          return {
            ...descriptor,
            get() {
              lyingGetterCalls += 1;
              throw new Error('lying index getter must not run');
            },
          };
        }
        return descriptor;
      },
    });
    expect(readDenseUnknownArray(lyingIndex, 8)).toBeNull();
    expect(lyingGetterCalls).toBe(0);

    let lengthGetterCalls = 0;
    const lyingLength = new Proxy(['a'], {
      getOwnPropertyDescriptor(target, prop) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, prop);
        if (prop === 'length' && descriptor !== undefined) {
          return {
            ...descriptor,
            get() {
              lengthGetterCalls += 1;
              throw new Error('length getter must not run');
            },
          };
        }
        return descriptor;
      },
    });
    expect(readDenseUnknownArray(lyingLength, 8)).toBeNull();
    expect(lengthGetterCalls).toBe(0);
  });

  it('returns null for a revoked Proxy without throwing', () => {
    let result: readonly unknown[] | null = ['sentinel'];
    expect(() => {
      result = readDenseUnknownArray(revokedProxy(), 8);
    }).not.toThrow();
    expect(result).toBeNull();
  });

  it('returns null when Proxy getOwnPropertyDescriptor throws on length', () => {
    const proxied = new Proxy(['a', 'b'], {
      getOwnPropertyDescriptor(target, prop) {
        if (prop === 'length') {
          throw new Error('hostile descriptor trap');
        }
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
    });
    let result: readonly unknown[] | null = ['sentinel'];
    expect(() => {
      result = readDenseUnknownArray(proxied, 8);
    }).not.toThrow();
    expect(result).toBeNull();
  });

  it('returns null when Proxy getOwnPropertyDescriptor throws on index', () => {
    const proxied = new Proxy(['a', 'b'], {
      getOwnPropertyDescriptor(target, prop) {
        if (prop === '0') {
          throw new Error('hostile descriptor trap');
        }
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
    });
    let result: readonly unknown[] | null = ['sentinel'];
    expect(() => {
      result = readDenseUnknownArray(proxied, 8);
    }).not.toThrow();
    expect(result).toBeNull();
  });

  it("returns ['a', 'b'] and does not call a throwing Proxy ownKeys trap", () => {
    let ownKeysCalls = 0;
    const proxied = new Proxy(['a', 'b'], {
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error('hostile ownKeys trap');
      },
    });
    expect(readDenseUnknownArray(proxied, 8)).toEqual(['a', 'b']);
    expect(ownKeysCalls).toBe(0);
  });

  it("returns ['a', 'b'] and does not call a throwing Proxy has trap", () => {
    let hasCalls = 0;
    const proxied = new Proxy(['a', 'b'], {
      has() {
        hasCalls += 1;
        throw new Error('hostile has trap');
      },
    });
    expect(readDenseUnknownArray(proxied, 8)).toEqual(['a', 'b']);
    expect(hasCalls).toBe(0);
  });

  it("returns ['a', 'b'] and does not call a throwing Proxy get trap", () => {
    let getCalls = 0;
    const proxied = new Proxy(['a', 'b'], {
      get() {
        getCalls += 1;
        throw new Error('hostile get trap');
      },
    });
    expect(readDenseUnknownArray(proxied, 8)).toEqual(['a', 'b']);
    expect(getCalls).toBe(0);
  });
});
