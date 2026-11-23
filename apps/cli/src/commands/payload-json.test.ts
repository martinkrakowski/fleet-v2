/**
 * Unit tests for the payload coercion helpers `safeJsonParse`, `jsonStrArr`,
 * `jsonObj` and `parseDurationOption` in `./payload.ts`.
 *
 * Cost bounds of the checks under test:
 * - `safeJsonParse`: O(n) in the input text length (one JSON.parse attempt).
 * - `jsonStrArr`: O(n) in string/array length (JSON.parse plus one `some` pass).
 * - `jsonObj`: O(n) in the input text length for strings; O(1) shape checks.
 * - `parseDurationOption`: O(1) anchored regex match, O(1) unit multiply.
 *
 * Every test below fails against a constant or identity-function
 * implementation: each asserts a concrete return value or a typed
 * `CliUsageError` with the expected message fragments, so an implementation
 * that always returns one fixed value or always passes cannot satisfy them.
 *
 * Hostile-input residuals accepted without editing `payload.ts`:
 * - JS `Array.prototype.some` skips array holes, so an already-parsed sparse
 *   array passes `jsonStrArr` with a hole in the result; this is pinned as
 *   current behaviour (see the dedicated test), not changed.
 * - A Proxy that lies consistently in every trap (e.g. reports arrays for
 *   `Array.isArray` and lies to `typeof`) is an accepted residual of the
 *   language; no shape check can defeat a lying Proxy.
 */

import { describe, expect, it } from 'vitest';

import { CliUsageError, jsonObj, jsonStrArr, parseDurationOption, safeJsonParse } from './payload.js';

/** A payload whose `key` property getter throws, simulating hostile input. */
function payloadWithThrowingGetter(key: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  Object.defineProperty(payload, key, {
    get() {
      throw new Error('getter exploded');
    },
    enumerable: true,
    configurable: true,
  });
  return payload;
}

describe('safeJsonParse', () => {
  it('parses valid JSON documents of each top-level kind', () => {
    // O(n) in input length.
    expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 });
    expect(safeJsonParse('["x"]')).toEqual(['x']);
    expect(safeJsonParse('42')).toBe(42);
    expect(safeJsonParse('true')).toBe(true);
  });

  it('returns undefined without throwing on invalid JSON', () => {
    // O(n) in input length; the try/catch must swallow, never rethrow.
    expect(() => safeJsonParse('{bad')).not.toThrow();
    expect(safeJsonParse('{bad')).toBeUndefined();
    expect(safeJsonParse('')).toBeUndefined();
    expect(safeJsonParse('undefined')).toBeUndefined();
  });

  it("parses 'null' to null, distinguishable from failure only by strict undefined check", () => {
    // Pins that success-with-null and parse-failure differ only under
    // strict `=== undefined` / `=== null` comparison.
    expect(safeJsonParse('null')).toBeNull();
    expect(safeJsonParse('null')).not.toBeUndefined();
    expect(safeJsonParse('{bad')).not.toBeNull();
  });
});

describe('jsonStrArr', () => {
  it('returns an empty array when the key is absent or undefined', () => {
    // O(1): the absent/undefined early return short-circuits before parsing.
    expect(jsonStrArr({}, 'items', 'Label')).toEqual([]);
    expect(jsonStrArr({ items: undefined }, 'items', 'Label')).toEqual([]);
  });

  it('returns the string array for a JSON-array string and an already-parsed string[]', () => {
    // O(n) in string/array length.
    expect(jsonStrArr({ items: '["a","b"]' }, 'items', 'Label')).toEqual(['a', 'b']);
    expect(jsonStrArr({ items: '[]' }, 'items', 'Label')).toEqual([]);
    expect(jsonStrArr({ items: ['a', 'b'] }, 'items', 'Label')).toEqual(['a', 'b']);
  });

  it('throws CliUsageError with label and flag name for null or \'null\'', () => {
    // A null value and the string 'null' both fail the array check.
    for (const value of [null, 'null']) {
      expect(() => jsonStrArr({ items: value }, 'items', 'Label')).toThrow(CliUsageError);
      try {
        jsonStrArr({ items: value }, 'items', 'Label');
        expect.unreachable('expected CliUsageError');
      } catch (error) {
        expect(error).toBeInstanceOf(CliUsageError);
        expect((error as CliUsageError).message).toContain('Label');
        expect((error as CliUsageError).message).toContain("'--items'");
      }
    }
  });

  it('throws CliUsageError when an array contains a non-string element', () => {
    // O(n) in array length for the `some` type pass.
    for (const value of [['a', 1], '["a",1]']) {
      expect(() => jsonStrArr({ items: value }, 'items', 'Label')).toThrow(CliUsageError);
      expect(() => jsonStrArr({ items: value }, 'items', 'Label')).toThrow(/Label/);
      expect(() => jsonStrArr({ items: value }, 'items', 'Label')).toThrow(/'--items'/);
    }
  });

  it('throws CliUsageError for a JSON object value or string', () => {
    // Objects are not arrays; both shapes must be refused, not guessed.
    for (const value of [{ a: 1 }, '{"a":1}']) {
      expect(() => jsonStrArr({ items: value }, 'items', 'Label')).toThrow(CliUsageError);
      expect(() => jsonStrArr({ items: value }, 'items', 'Label')).toThrow(/Label.*'--items'/s);
    }
  });

  it('throws CliUsageError on invalid JSON text', () => {
    // safeJsonParse returns undefined for these, which is not an array.
    for (const value of ['[bad', '']) {
      expect(() => jsonStrArr({ items: value }, 'items', 'Label')).toThrow(CliUsageError);
      expect(() => jsonStrArr({ items: value }, 'items', 'Label')).toThrow(/'--items'/);
    }
  });

  it('refuses wrong primitives, array-like objects and prototype-polluting keys with CliUsageError', () => {
    // O(1) shape refusals: a number, a boolean, an array-like that is not a
    // real array, and a payload whose own 'constructor' key carries a
    // non-array value must all be refused rather than trusted.
    for (const value of [42, true, { length: 1, 0: 'a' }]) {
      expect(() => jsonStrArr({ items: value }, 'items', 'Label')).toThrow(CliUsageError);
    }
    expect(() => jsonStrArr({ constructor: 42 }, 'constructor', 'Label')).toThrow(CliUsageError);
    expect(() => jsonStrArr({ constructor: 42 }, 'constructor', 'Label')).toThrow(/'--constructor'/);
  });

  it('propagates a throwing getter on payload instead of passing', () => {
    // The `payload[key]` read itself must throw through the helper; the
    // helper never catches and never returns [].
    expect(() => jsonStrArr(payloadWithThrowingGetter('items'), 'items', 'Label')).toThrow(
      'getter exploded',
    );
  });

  it('pins that Array.prototype.some hole-skipping lets a sparse already-parsed array pass unchanged', () => {
    // Residual, documented not altered: JSON text cannot express holes, but
    // an already-parsed sparse array value skips the hole in the `some`
    // check and is returned as-is, hole included. payload.ts is not edited
    // in this task; this test pins the actual behaviour so any future
    // change is a conscious one.
    const sparse: unknown[] = ['a', 'placeholder', 'b'];
    delete sparse[1]; // create a real hole (kept literal-free for no-sparse-arrays)
    expect(1 in sparse).toBe(false);
    const result = jsonStrArr({ items: sparse }, 'items', 'Label');
    expect(result).toEqual(['a', undefined, 'b']);
    expect(1 in result).toBe(false);
  });
});

describe('jsonObj', () => {
  it('returns undefined when the key is absent or undefined', () => {
    // O(1): absent/undefined short-circuit; the use case decides the default.
    expect(jsonObj({}, 'spec', 'Label')).toBeUndefined();
    expect(jsonObj({ spec: undefined }, 'spec', 'Label')).toBeUndefined();
  });

  it('returns the object for an object string and an already-parsed object value', () => {
    // O(n) in string length for parsing; O(1) shape checks.
    expect(jsonObj({ spec: '{"a":1,"b":"x"}' }, 'spec', 'Label')).toEqual({ a: 1, b: 'x' });
    expect(jsonObj({ spec: { a: 1 } }, 'spec', 'Label')).toEqual({ a: 1 });
  });

  it('throws CliUsageError for null or \'null\'', () => {
    // Both a null value and the string 'null' fail the object shape check.
    for (const value of [null, 'null']) {
      expect(() => jsonObj({ spec: value }, 'spec', 'Label')).toThrow(CliUsageError);
      try {
        jsonObj({ spec: value }, 'spec', 'Label');
        expect.unreachable('expected CliUsageError');
      } catch (error) {
        expect(error).toBeInstanceOf(CliUsageError);
        expect((error as CliUsageError).message).toContain('Label');
        expect((error as CliUsageError).message).toContain("'--spec'");
      }
    }
  });

  it('throws CliUsageError for an array value or \'[]\' string', () => {
    // Arrays are objects in JS but are explicitly refused.
    for (const value of [['a'], '[]']) {
      expect(() => jsonObj({ spec: value }, 'spec', 'Label')).toThrow(CliUsageError);
      expect(() => jsonObj({ spec: value }, 'spec', 'Label')).toThrow(/Label.*'--spec'/s);
    }
  });

  it('throws CliUsageError for numbers and other primitives', () => {
    // Wrong primitives must be refused, never coerced into an object.
    for (const value of [42, '42', true]) {
      expect(() => jsonObj({ spec: value }, 'spec', 'Label')).toThrow(CliUsageError);
      expect(() => jsonObj({ spec: value }, 'spec', 'Label')).toThrow(/'--spec'/);
    }
  });

  it('throws CliUsageError on invalid JSON text', () => {
    // safeJsonParse returns undefined for these, which is not an object.
    for (const value of ['{bad', '']) {
      expect(() => jsonObj({ spec: value }, 'spec', 'Label')).toThrow(CliUsageError);
      expect(() => jsonObj({ spec: value }, 'spec', 'Label')).toThrow(/'--spec'/);
    }
  });

  it('propagates a throwing getter on payload instead of passing', () => {
    // The `payload[key]` read itself must throw through the helper; the
    // helper never catches and never returns undefined.
    expect(() => jsonObj(payloadWithThrowingGetter('spec'), 'spec', 'Label')).toThrow(
      'getter exploded',
    );
  });
});

describe('parseDurationOption', () => {
  it('returns fallbackMs when the key is absent or empty string', () => {
    // O(1): optStr treats absent, '' and whitespace-only as absent, so all
    // three fall back without a regex pass.
    expect(parseDurationOption({}, 'max', 7000)).toBe(7000);
    expect(parseDurationOption({ max: '' }, 'max', 7000)).toBe(7000);
    expect(parseDurationOption({ max: '   ' }, 'max', 7000)).toBe(7000);
    expect(parseDurationOption({ max: '   ' }, 'max', 7000)).not.toBe(0);
  });

  it('parses each supported unit into milliseconds', () => {
    // O(1) anchored regex plus one multiply per call.
    expect(parseDurationOption({ max: '500ms' }, 'max', 7000)).toBe(500);
    expect(parseDurationOption({ max: '15s' }, 'max', 7000)).toBe(15000);
    expect(parseDurationOption({ max: '30m' }, 'max', 7000)).toBe(1800000);
    expect(parseDurationOption({ max: '2h' }, 'max', 7000)).toBe(7200000);
    expect(parseDurationOption({ max: '0m' }, 'max', 7000)).toBe(0);
  });

  it('refuses malformed durations with CliUsageError quoting the raw value', () => {
    // O(1): a bare number (string or numeric), space before the unit, a
    // sign, a fraction, an unsupported unit and a missing number are all
    // refused; the message must quote the offending raw value so the
    // operator sees what was rejected.
    const raws = ['30', 30, '30 m', '-5s', '1.5h', '5d', 'ms'];
    for (const raw of raws) {
      expect(() => parseDurationOption({ max: raw }, 'max', 7000)).toThrow(CliUsageError);
      const message = (() => {
        try {
          parseDurationOption({ max: raw }, 'max', 7000);
          return '';
        } catch (error) {
          return (error as CliUsageError).message;
        }
      })();
      expect(message).toContain("'--max'");
      expect(message).toContain(`'${String(raw)}'`);
    }
  });

  it('returns a finite number without throwing for 99999999999999999999h', () => {
    // Enormous-length input: the digits exceed Number.MAX_SAFE_INTEGER.
    // Current behaviour (pinned, not changed): the numeric conversion is
    // lossy but the result is finite and does not throw or return NaN.
    const result = parseDurationOption({ max: '99999999999999999999h' }, 'max', 7000);
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBe(3.6e26);
  });

  it('propagates a throwing getter on payload instead of passing', () => {
    // The `payload[key]` read through optStr must throw through the helper;
    // it never catches and never returns fallbackMs.
    expect(() => parseDurationOption(payloadWithThrowingGetter('max'), 'max', 7000)).toThrow(
      'getter exploded',
    );
  });
});
