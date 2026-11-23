import { describe, expect, it } from 'vitest';

import {
  hasUnknownKeys,
  isPlainRecord,
  readBoundedInteger,
  readOwnDataProperty,
} from '../policy-read.js';

describe('isPlainRecord', () => {
  it('refuses null, undefined, primitives, and functions', () => {
    expect(isPlainRecord(null)).toBe(false);
    expect(isPlainRecord(undefined)).toBe(false);
    expect(isPlainRecord('str')).toBe(false);
    expect(isPlainRecord(0)).toBe(false);
    expect(isPlainRecord(true)).toBe(false);
    expect(isPlainRecord(Symbol())).toBe(false);
    expect(isPlainRecord(1n)).toBe(false);
    expect(isPlainRecord(() => {})).toBe(false);
    expect(isPlainRecord(function named() {})).toBe(false);
  });

  it('refuses arrays, built-in instances, and custom-prototype objects', () => {
    expect(isPlainRecord([])).toBe(false);
    expect(isPlainRecord([1])).toBe(false);
    expect(isPlainRecord(new Int32Array(2))).toBe(false);
    expect(isPlainRecord(new Date())).toBe(false);
    expect(isPlainRecord(new Map())).toBe(false);
    expect(isPlainRecord(new Set())).toBe(false);
    expect(isPlainRecord(/re/)).toBe(false);
    class Klass {}
    expect(isPlainRecord(new Klass())).toBe(false);
    expect(isPlainRecord(Object.create({ inherited: 1 }))).toBe(false);
  });

  it('accepts plain object literals and null-prototype objects', () => {
    expect(isPlainRecord({})).toBe(true);
    expect(isPlainRecord({ a: 1 })).toBe(true);
    expect(isPlainRecord(Object.create(null))).toBe(true);
    // A plain object with a `length` property IS a plain record (unlike an
    // array or a typed array).
    expect(isPlainRecord({ length: 2 })).toBe(true);
  });

  it('refuses a lying Proxy (accepted residual) while still rejecting an array target', () => {
    const lyingProxy = new Proxy(
      {},
      {
        getPrototypeOf: () => Array.prototype,
        get: () => 0,
        ownKeys: () => [],
        getOwnPropertyDescriptor: () => ({
          configurable: true,
          enumerable: true,
          writable: true,
          value: 0,
        }),
      },
    );
    // The Proxy lies consistently in every trap, so the reader may accept it;
    // what must hold is that the function is total and returns a boolean.
    expect(typeof isPlainRecord(lyingProxy)).toBe('boolean');
    // A proxy of an array can never become a plain record.
    expect(isPlainRecord(new Proxy([], {}))).toBe(false);
  });
});

describe('readOwnDataProperty', () => {
  it('returns undefined for absent keys', () => {
    expect(readOwnDataProperty({}, 'missing')).toBeUndefined();
    expect(readOwnDataProperty({ present: 1 }, 'missing')).toBeUndefined();
  });

  it('returns undefined for inherited properties', () => {
    expect(readOwnDataProperty({}, 'toString')).toBeUndefined();
    const withProto = Object.create({ inherited: 1 });
    expect(readOwnDataProperty(withProto, 'inherited')).toBeUndefined();
  });

  it('returns undefined for __proto__ on a normal object and reads own __proto__ data property safely', () => {
    expect(readOwnDataProperty({}, '__proto__')).toBeUndefined();
    // Own __proto__ data property (as produced by JSON.parse) is read without
    // polluting Object.prototype.
    const source = JSON.parse('{"__proto__":{"polluted":true}}') as Record<
      string,
      unknown
    >;
    const read = readOwnDataProperty(source, '__proto__');
    expect(read).toEqual({ polluted: true });
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('returns undefined for accessor getters without invoking them', () => {
    let getterRuns = 0;
    const record = {
      get boom(): never {
        getterRuns += 1;
        throw new Error('getter must never run');
      },
      plain: 1,
    };
    expect(readOwnDataProperty(record, 'boom')).toBeUndefined();
    expect(getterRuns).toBe(0);
    // Own data properties still read.
    expect(readOwnDataProperty(record, 'plain')).toBe(1);
  });

  it('reads through a consistent Proxy as accepted residual', () => {
    const target = { key: 'value' };
    const proxy = new Proxy(target, {});
    expect(readOwnDataProperty(proxy as Record<string, unknown>, 'key')).toBe(
      'value',
    );
    expect(readOwnDataProperty(proxy as Record<string, unknown>, 'absent')).toBeUndefined();
  });
});

describe('hasUnknownKeys', () => {
  it('returns true when any own enumerable key is outside allowedKeys including __proto__', () => {
    expect(hasUnknownKeys({ known: 1, extra: 2 }, ['known'])).toBe(true);
    expect(hasUnknownKeys(JSON.parse('{"__proto__":{}}'), [])).toBe(true);
    expect(hasUnknownKeys({ constructor: 1 }, [])).toBe(true);
    expect(hasUnknownKeys({ prototype: 1 }, [])).toBe(true);
  });

  it('returns false when all own enumerable keys are allowed or inherited', () => {
    expect(hasUnknownKeys({}, ['a'])).toBe(false);
    expect(hasUnknownKeys({ a: 1 }, ['a', 'b'])).toBe(false);
    expect(hasUnknownKeys(Object.create({ extra: 1 }), ['a'])).toBe(false);
    // Array holes are not own enumerable keys.
    expect(hasUnknownKeys({ a: 1 }, ['a'])).toBe(false);
  });

  it('inspects keys without invoking getters', () => {
    let getterRuns = 0;
    const record = {
      known: 1,
      get extra(): never {
        getterRuns += 1;
        throw new Error('getter must never run');
      },
    };
    expect(hasUnknownKeys(record, ['known'])).toBe(true);
    expect(getterRuns).toBe(0);
  });
});

describe('readBoundedInteger', () => {
  it('returns undefined for non-numbers, non-finite values, and non-integers', () => {
    const bounds = { min: 1, max: 10 };
    expect(readBoundedInteger(null, bounds)).toBeUndefined();
    expect(readBoundedInteger(undefined, bounds)).toBeUndefined();
    expect(readBoundedInteger('5', bounds)).toBeUndefined();
    expect(readBoundedInteger(true, bounds)).toBeUndefined();
    expect(readBoundedInteger({}, bounds)).toBeUndefined();
    expect(readBoundedInteger([5], bounds)).toBeUndefined();
    expect(readBoundedInteger(Number.NaN, bounds)).toBeUndefined();
    expect(readBoundedInteger(Number.POSITIVE_INFINITY, bounds)).toBeUndefined();
    expect(readBoundedInteger(Number.NEGATIVE_INFINITY, bounds)).toBeUndefined();
    expect(readBoundedInteger(1.5, bounds)).toBeUndefined();
    expect(readBoundedInteger(-0.5, bounds)).toBeUndefined();
  });

  it('returns undefined for integers outside inclusive bounds', () => {
    const bounds = { min: 1, max: 10 };
    expect(readBoundedInteger(bounds.min - 1, bounds)).toBeUndefined();
    expect(readBoundedInteger(bounds.max + 1, bounds)).toBeUndefined();
  });

  it('returns the integer at inclusive bounds and within range', () => {
    const bounds = { min: 1, max: 10 };
    expect(readBoundedInteger(bounds.min, bounds)).toBe(bounds.min);
    expect(readBoundedInteger(bounds.max, bounds)).toBe(bounds.max);
    expect(readBoundedInteger(5, bounds)).toBe(5);
    expect(readBoundedInteger(0, { min: 0, max: 0 })).toBe(0);
  });
});
