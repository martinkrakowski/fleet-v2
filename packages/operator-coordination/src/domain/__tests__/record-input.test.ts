import { describe, expect, it } from 'vitest';

import { plainArrayCopy, readPlainObject, readPlainObjectWithOptional } from '../record-input.js';

describe('readPlainObject', () => {
  it('accepts an exact key set', () => {
    expect(readPlainObject({ a: 1, b: 2 }, ['a', 'b'])).toEqual({ a: 1, b: 2 });
  });

  it('refuses an extra key', () => {
    expect(readPlainObject({ a: 1, b: 2, c: 3 }, ['a', 'b'])).toBeNull();
  });

  it('refuses a missing key', () => {
    expect(readPlainObject({ a: 1 }, ['a', 'b'])).toBeNull();
  });

  it('refuses a symbol key', () => {
    expect(readPlainObject({ a: 1, [Symbol('s')]: 2 }, ['a'])).toBeNull();
  });

  it('refuses a non-enumerable key', () => {
    const value: Record<string, unknown> = { a: 1 };
    Object.defineProperty(value, 'b', { value: 2, enumerable: false });
    expect(readPlainObject(value, ['a', 'b'])).toBeNull();
  });

  it('refuses an array', () => {
    expect(readPlainObject(['a'], ['a'])).toBeNull();
  });

  it('refuses a class instance', () => {
    class Example {
      a = 1;
    }
    expect(readPlainObject(new Example(), ['a'])).toBeNull();
  });

  it('never invokes a getter', () => {
    const value: Record<string, unknown> = {};
    Object.defineProperty(value, 'a', {
      get() {
        throw new Error('ran');
      },
      enumerable: true,
    });
    expect(() => readPlainObject(value, ['a'])).not.toThrow();
    expect(readPlainObject(value, ['a'])).toEqual({ a: undefined });
  });
});

describe('plainArrayCopy', () => {
  it('returns a fresh array for an array', () => {
    const input = [1, 2];
    const copy = plainArrayCopy(input) as unknown[];
    expect(copy).toEqual([1, 2]);
    expect(copy).not.toBe(input);
    input[0] = 99;
    expect(copy[0]).toBe(1);
  });

  it('returns the same value for a non-array', () => {
    const value = { a: 1 };
    expect(plainArrayCopy(value)).toBe(value);
  });
});

describe('readPlainObjectWithOptional', () => {
  it('accepts with an optional key', () => {
    expect(readPlainObjectWithOptional({ a: 1, b: 2 }, ['a'], ['a', 'b'])).toEqual({ a: 1, b: 2 });
  });

  it('accepts without an optional key', () => {
    expect(readPlainObjectWithOptional({ a: 1 }, ['a'], ['a', 'b'])).toEqual({ a: 1 });
  });

  it('refuses an unknown key', () => {
    expect(readPlainObjectWithOptional({ a: 1, c: 2 }, ['a'], ['a', 'b'])).toBeNull();
  });
});
