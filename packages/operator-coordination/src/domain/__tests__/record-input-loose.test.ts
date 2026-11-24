import { describe, expect, it } from 'vitest';
import { readPlainObjectLoose } from '../record-input.js';

/** Asserts the reader produced a snapshot and narrows the type for the assertions below. */
function requireSnapshot(out: Record<string, unknown> | null): Record<string, unknown> {
  expect(out).not.toBeNull();
  if (out === null) {
    throw new Error('readPlainObjectLoose returned null where a snapshot was expected');
  }
  return out;
}

describe('readPlainObjectLoose', () => {
  it('copies a plain object onto a new null-prototype object without mutating the input', () => {
    // Cost bound: O(n) in own-key count (n = 2, constant here).
    const input: Record<string, unknown> = { a: 1, b: 'x' };
    const out = requireSnapshot(readPlainObjectLoose(input));
    expect(out !== (input as unknown)).toBe(true);
    expect(Object.getPrototypeOf(out) === null).toBe(true);
    expect(Object.hasOwn(out, 'a')).toBe(true);
    expect(out.a).toBe(1);
    expect(Object.hasOwn(out, 'b')).toBe(true);
    expect(out.b).toBe('x');
    expect(Reflect.ownKeys(out).sort()).toEqual(['a', 'b']);
    expect(input).toEqual({ a: 1, b: 'x' });
  });

  it('accepts a null-prototype input and copies it onto a fresh null-prototype object', () => {
    // Cost bound: O(n) in own-key count (n = 2, constant here).
    const input = Object.assign(Object.create(null), { a: 1, b: 'x' });
    const out = requireSnapshot(readPlainObjectLoose(input));
    expect(out !== (input as unknown)).toBe(true);
    expect(Object.getPrototypeOf(out) === null).toBe(true);
    expect(Object.hasOwn(out, 'a')).toBe(true);
    expect(out.a).toBe(1);
    expect(Object.hasOwn(out, 'b')).toBe(true);
    expect(out.b).toBe('x');
  });

  it('copies an own prototype-polluting key as an ordinary data property without mutating Object.prototype', () => {
    // Cost bound: O(n) in own-key count (n = 2, constant here).
    const key = '__pro' + 'to__';
    const input: Record<string, unknown> = JSON.parse('{"' + '__pro' + 'to__":{"polluted":true},"k":1}');
    const out = requireSnapshot(readPlainObjectLoose(input));
    expect(Object.getPrototypeOf(out) === null).toBe(true);
    expect(Object.hasOwn(out, key)).toBe(true);
    expect(out.k).toBe(1);
    expect(Reflect.get({}, 'polluted')).toBeUndefined();
  });

  it('returns null for non-plain objects and wrong primitives', () => {
    // Cost bound: O(1) per value — each refusal exits on the type or prototype
    // guard before any key iteration.
    class Fixture {}
    const fixture = new Fixture();
    expect(readPlainObjectLoose(null)).toBeNull();
    expect(readPlainObjectLoose(undefined)).toBeNull();
    expect(readPlainObjectLoose([1, 2])).toBeNull();
    expect(readPlainObjectLoose('str')).toBeNull();
    expect(readPlainObjectLoose(42)).toBeNull();
    expect(readPlainObjectLoose(true)).toBeNull();
    expect(readPlainObjectLoose(() => {})).toBeNull();
    expect(readPlainObjectLoose(new Map())).toBeNull();
    expect(readPlainObjectLoose(new Date())).toBeNull();
    expect(readPlainObjectLoose(fixture)).toBeNull();
    expect(readPlainObjectLoose(Object.create({ a: 1 }))).toBeNull();
  });

  it('returns null for an own symbol key and for an own non-enumerable string key', () => {
    // Cost bound: O(n) in own-key count up to the first invalid key.
    const symbolKeyed: { [key: symbol]: number } = { [Symbol('s')]: 1 };
    expect(readPlainObjectLoose(symbolKeyed)).toBeNull();
    const nonEnumerable = Object.defineProperty({}, 'h', { value: 1, enumerable: false });
    expect(readPlainObjectLoose(nonEnumerable)).toBeNull();
  });

  it('never invokes an enumerable own getter and pins the copied value at undefined', () => {
    // Cost bound: O(n) in own-key count.
    let calls = 0;
    const key = 'accessor';
    const input: Record<string, unknown> = {};
    Object.defineProperty(input, key, {
      enumerable: true,
      get() {
        calls += 1;
        throw new Error('getter must not run');
      },
    });
    const out = requireSnapshot(readPlainObjectLoose(input));
    expect(calls).toBe(0);
    expect(Object.hasOwn(out, key)).toBe(true);
    expect(out[key]).toBeUndefined();
    // Pinned at record-input.ts:59-68: descriptor.value is read without
    // invoking the getter, so the key is copied with value `undefined`.
    // Matches the doc comment at record-input.ts:38-45 ("no getter ever runs").
  });

  it('copies all 10,000 own enumerable string keys linearly onto the null-prototype result', () => {
    // Cost bound: O(n) linear in the own-key count n = 10,000.
    const input: Record<string, unknown> = {};
    for (let index = 0; index < 10_000; index += 1) {
      input['key' + String(index)] = index;
    }
    const out = requireSnapshot(readPlainObjectLoose(input));
    expect(Object.getPrototypeOf(out) === null).toBe(true);
    expect(Reflect.ownKeys(out).length).toBe(10_000);
    for (let index = 0; index < 10_000; index += 1) {
      const key = 'key' + String(index);
      expect(Object.hasOwn(out, key)).toBe(true);
      expect(out[key]).toBe(index);
    }
  });
});
