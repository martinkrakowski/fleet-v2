// VB04 — unit tests for the payload scalar, enum and nested helpers.
/**
 * Pure synchronous in-memory coverage of `str`, `optStr`, `strOrNull`,
 * `strArr`, `nested`, `requiredNested`, `nestedArr` and `enumOf`, including
 * hostile inputs (prototype-polluting keys, throwing getters, Proxies,
 * array-likes with enormous length). No filesystem, subprocess or network.
 */

import { describe, expect, it } from 'vitest';

import { CliUsageError, enumOf, nested, nestedArr, optStr, requiredNested, str, strArr, strOrNull } from './payload.js';

const POISON = JSON.parse('{"__proto__":{"x":1}}') as Record<string, unknown>;

describe('str', () => {
  it('returns string unchanged without trimming, including empty string', () => {
    expect(str({ v: '  hello  ' }, 'v')).toBe('  hello  ');
    expect(str({ v: '' }, 'v')).toBe('');
  });

  it('converts numbers and booleans to their String() form', () => {
    expect(str({ v: 0 }, 'v')).toBe('0');
    expect(str({ v: 42 }, 'v')).toBe('42');
    expect(str({ v: false }, 'v')).toBe('false');
    expect(str({ v: true }, 'v')).toBe('true');
  });

  it('returns empty string for undefined, null, object, and array', () => {
    expect(str({}, 'v')).toBe('');
    expect(str({ v: undefined }, 'v')).toBe('');
    expect(str({ v: null }, 'v')).toBe('');
    expect(str({ v: { a: 1 } }, 'v')).toBe('');
    expect(str({ v: ['a'] }, 'v')).toBe('');
  });
});

describe('optStr', () => {
  it('returns untrimmed string and String() form for non-empty scalars', () => {
    expect(optStr({ v: '  hi  ' }, 'v')).toBe('  hi  ');
    expect(optStr({ v: 0 }, 'v')).toBe('0');
    expect(optStr({ v: false }, 'v')).toBe('false');
  });

  it('returns undefined for empty, whitespace-only, and non-scalar values', () => {
    expect(optStr({ v: '' }, 'v')).toBeUndefined();
    expect(optStr({ v: '   \t\n' }, 'v')).toBeUndefined();
    expect(optStr({}, 'v')).toBeUndefined();
    expect(optStr({ v: undefined }, 'v')).toBeUndefined();
    expect(optStr({ v: null }, 'v')).toBeUndefined();
    expect(optStr({ v: { a: 1 } }, 'v')).toBeUndefined();
    expect(optStr({ v: ['a'] }, 'v')).toBeUndefined();
  });
});

describe('strOrNull', () => {
  it('returns only real strings, untrimmed, including the empty string', () => {
    expect(strOrNull({ v: '' }, 'v')).toBe('');
    expect(strOrNull({ v: '  a  ' }, 'v')).toBe('  a  ');
  });

  it('returns null for non-string values including numbers and booleans', () => {
    expect(strOrNull({ v: 0 }, 'v')).toBeNull();
    expect(strOrNull({ v: 1 }, 'v')).toBeNull();
    expect(strOrNull({ v: true }, 'v')).toBeNull();
    expect(strOrNull({ v: false }, 'v')).toBeNull();
    expect(strOrNull({ v: undefined }, 'v')).toBeNull();
    expect(strOrNull({ v: null }, 'v')).toBeNull();
    expect(strOrNull({ v: { a: 1 } }, 'v')).toBeNull();
    expect(strOrNull({ v: ['a'] }, 'v')).toBeNull();
  });
});

describe('strArr', () => {
  it('maps each array element through String()', () => {
    expect(strArr({ v: [null, undefined, 42, true, 'x'] }, 'v')).toEqual([
      'null',
      'undefined',
      '42',
      'true',
      'x',
    ]);
  });

  it('splits a comma-separated string, trims parts, and drops empty parts', () => {
    expect(strArr({ v: ' a , , b, c ' }, 'v')).toEqual(['a', 'b', 'c']);
  });

  it('returns empty array for blank string, undefined, null, object, and array-like', () => {
    expect(strArr({ v: '' }, 'v')).toEqual([]);
    expect(strArr({ v: ' ,  , ' }, 'v')).toEqual([]);
    expect(strArr({}, 'v')).toEqual([]);
    expect(strArr({ v: undefined }, 'v')).toEqual([]);
    expect(strArr({ v: null }, 'v')).toEqual([]);
    expect(strArr({ v: { length: 2, 0: 'a', 1: 'b' } }, 'v')).toEqual([]);
    expect(strArr({ v: { length: 1e9 } }, 'v')).toEqual([]);
  });
});

describe('nested', () => {
  it('returns the exact same object reference for a non-null, non-array object', () => {
    const value = { a: 1 };
    expect(nested({ v: value }, 'v')).toBe(value);
  });

  it('returns undefined for null, undefined, array, and primitives', () => {
    expect(nested({}, 'v')).toBeUndefined();
    expect(nested({ v: undefined }, 'v')).toBeUndefined();
    expect(nested({ v: null }, 'v')).toBeUndefined();
    expect(nested({ v: ['a'] }, 'v')).toBeUndefined();
    expect(nested({ v: 's' }, 'v')).toBeUndefined();
    expect(nested({ v: 1 }, 'v')).toBeUndefined();
    expect(nested({ v: true }, 'v')).toBeUndefined();
  });
});

describe('requiredNested', () => {
  it('returns the exact same object reference when present', () => {
    const value = { a: 1 };
    expect(requiredNested({ v: value }, 'v', 'ctx')).toBe(value);
  });

  it('throws CliUsageError naming label and --key when value is absent, null, array, or primitive', () => {
    for (const payload of [{}, { v: undefined }, { v: null }, { v: ['a'] }, { v: 's' }, { v: 7 }]) {
      expect(() => requiredNested(payload as never, 'v', 'ctx')).toThrowError(CliUsageError);
      expect(() => requiredNested(payload as never, 'v', 'ctx')).toThrowError(
        "ctx requires a JSON object in '--v'",
      );
    }
  });
});

describe('nestedArr', () => {
  it('returns the exact same array reference when the value is a real array', () => {
    const value = [{ a: 1 }];
    expect(nestedArr({ v: value }, 'v')).toBe(value);
  });

  it('returns undefined for non-array values including object, array-like, and null', () => {
    expect(nestedArr({}, 'v')).toBeUndefined();
    expect(nestedArr({ v: undefined }, 'v')).toBeUndefined();
    expect(nestedArr({ v: null }, 'v')).toBeUndefined();
    expect(nestedArr({ v: { a: 1 } }, 'v')).toBeUndefined();
    expect(nestedArr({ v: { length: 1e9 } }, 'v')).toBeUndefined();
    expect(nestedArr({ v: 's' }, 'v')).toBeUndefined();
    expect(nestedArr({ v: 1 }, 'v')).toBeUndefined();
  });
});

describe('enumOf', () => {
  it('returns the exact value when it is a member of allowed, case-sensitive and untrimmed', () => {
    expect(enumOf({ v: 'aB' }, 'v', ['ab', 'aB', 'c'], 'ctx')).toBe('aB');
  });

  it('throws CliUsageError listing all allowed values on mismatch, wrong case, whitespace, or missing key', () => {
    for (const payload of [{}, { v: undefined }, { v: '' }, { v: 'AB' }, { v: ' aB ' }, { v: 1 }, { v: 'zz' }]) {
      expect(() => enumOf(payload as never, 'v', ['ab', 'aB', 'c'], 'ctx')).toThrowError(CliUsageError);
      expect(() => enumOf(payload as never, 'v', ['ab', 'aB', 'c'], 'ctx')).toThrowError(
        'ctx must be one of: ab, aB, c',
      );
    }
  });
});

describe('hostile inputs', () => {
  it('helpers ignore prototype-polluting __proto__ key from JSON.parse for ordinary keys', () => {
    expect(str(POISON, 'x')).toBe('');
    expect(optStr(POISON, 'x')).toBeUndefined();
    expect(strOrNull(POISON, 'x')).toBeNull();
    expect(strArr(POISON, 'x')).toEqual([]);
    expect(nested(POISON, 'x')).toBeUndefined();
    expect(nestedArr(POISON, 'x')).toBeUndefined();
    expect(() => requiredNested(POISON, 'x', 'ctx')).toThrowError(CliUsageError);
    expect(() => enumOf(POISON, 'x', ['a'], 'ctx')).toThrowError(CliUsageError);
  });

  it('helpers propagate throwing getter on accessed key and never invoke getter on unused key', () => {
    const boom = new Error('getter failed');
    const payload: Record<string, unknown> = { untouched: 1 };
    let unusedReads = 0;
    Object.defineProperty(payload, 'unused', {
      enumerable: true,
      get() {
        unusedReads += 1;
        return 'unused';
      },
    });
    Object.defineProperty(payload, 'accessed', {
      enumerable: true,
      get() {
        throw boom;
      },
    });
    for (const read of [
      () => str(payload, 'accessed'),
      () => optStr(payload, 'accessed'),
      () => strOrNull(payload, 'accessed'),
      () => strArr(payload, 'accessed'),
      () => nested(payload, 'accessed'),
      () => nestedArr(payload, 'accessed'),
    ]) {
      expect(read).toThrowError(boom);
    }
    expect(() => requiredNested(payload, 'accessed', 'ctx')).toThrowError(boom);
    expect(() => enumOf(payload, 'accessed', ['a'], 'ctx')).toThrowError(boom);
    // The unused getter is never read by any helper; only this probe read it.
    str(payload, 'unused');
    expect(unusedReads).toBe(1);
  });

  it('rejects an enormous array-like length in O(1) without looping', () => {
    const started = process.hrtime.bigint();
    expect(strArr({ v: { length: 1e9 } }, 'v')).toEqual([]);
    expect(nestedArr({ v: { length: 1e9 } }, 'v')).toBeUndefined();
    expect(Number(process.hrtime.bigint() - started)).toBeLessThan(1e9); // well under 1s
  });

  it('propagates a throwing Proxy get trap synchronously rather than passing', () => {
    const boom = new Error('proxy trap failed');
    const lying = new Proxy(
      {},
      {
        get() {
          throw boom;
        },
      },
    );
    expect(() => str(lying, 'v')).toThrowError(boom);
    expect(() => strArr(lying, 'v')).toThrowError(boom);
    expect(() => nested(lying, 'v')).toThrowError(boom);
    expect(() => requiredNested(lying, 'v', 'ctx')).toThrowError(boom);
  });
});
