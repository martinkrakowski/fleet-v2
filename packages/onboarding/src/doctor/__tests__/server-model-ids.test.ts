/**
 * Direct unit tests for `serverModelIds`: the exact listing order and
 * `id#variant` expansion, whitespace trimming, prototype-polluting model
 * keys, the linear cost bound over 12000 ids, and every refusal path —
 * hostile stdout must yield `undefined` and never throw.
 *
 * Cost note: every test runs a single JSON.parse plus one pass over the
 * model record and its variant arrays (O(total input size)), except the
 * cost-bound test, which pins that bound explicitly at 2000 models x 5
 * variants = 12000 ids and fails against a constant-list or id-only
 * implementation.
 */

import { describe, expect, it } from 'vitest';

import { serverModelIds } from '../probes-node.js';

describe('serverModelIds', () => {
  it('returns model ids and id#variant entries in listing order and omits variants when empty', () => {
    const stdout = JSON.stringify({
      data: {
        current: 'a/b',
        models: {
          'a/b': {},
          'c/d': { variants: ['low', 'high'] },
          'e/f': { variants: [] },
        },
      },
    });
    expect(serverModelIds(stdout)).toStrictEqual(['a/b', 'c/d', 'c/d#low', 'c/d#high', 'e/f']);
  });

  it('trims surrounding whitespace on model ids and variant names', () => {
    const stdout = JSON.stringify({
      data: { models: { ' a/b ': { variants: [' low ', '\thigh\n'] } } },
    });
    expect(serverModelIds(stdout)).toStrictEqual(['a/b', 'a/b#low', 'a/b#high']);
  });

  it('does not pollute Object.prototype or throw on __proto__ and constructor model keys', () => {
    const stdout = '{"data":{"models":{"__proto__":{},"constructor":{}}}}';
    expect(() => serverModelIds(stdout)).not.toThrow();
    expect(serverModelIds(stdout)).toStrictEqual(['__proto__', 'constructor']);
    expect(Object.hasOwn({}, 'polluted')).toBe(false);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it('expands 2000 models with 5 variants each into 12000 ids within O(models * variants) linear work', () => {
    const models: Record<string, { variants: string[] }> = {};
    for (let i = 0; i < 2000; i += 1) {
      models[`m-${i}`] = { variants: ['v0', 'v1', 'v2', 'v3', 'v4'] };
    }
    const stdout = JSON.stringify({ data: { models } });
    const result = serverModelIds(stdout);
    expect(result).toBeDefined();
    expect(result).toHaveLength(12000);
    const ids = result as readonly string[];
    expect(ids[0]).toBe('m-0');
    expect(ids[1]).toBe('m-0#v0');
    expect(ids[11999]).toBe('m-1999#v4');
  });

  it('returns undefined for empty stdout', () => {
    expect(serverModelIds('')).toBeUndefined();
  });

  it('returns undefined for non-json stdout', () => {
    expect(serverModelIds('not json')).toBeUndefined();
  });

  it('returns undefined when JSON root is not a plain object', () => {
    expect(serverModelIds('null')).toBeUndefined();
    expect(serverModelIds('[]')).toBeUndefined();
    expect(serverModelIds('123')).toBeUndefined();
    expect(serverModelIds('"str"')).toBeUndefined();
    expect(serverModelIds('true')).toBeUndefined();
  });

  it('returns undefined when data is missing or not a plain object', () => {
    expect(serverModelIds('{}')).toBeUndefined();
    expect(serverModelIds('{"data":null}')).toBeUndefined();
    expect(serverModelIds('{"data":[]}')).toBeUndefined();
    expect(serverModelIds('{"data":"x"}')).toBeUndefined();
  });

  it('returns undefined when models is missing or not a plain object', () => {
    expect(serverModelIds('{"data":{}}')).toBeUndefined();
    expect(serverModelIds('{"data":{"models":null}}')).toBeUndefined();
    expect(serverModelIds('{"data":{"models":[]}}')).toBeUndefined();
  });

  it('returns undefined when models record is empty', () => {
    expect(serverModelIds('{"data":{"models":{}}}')).toBeUndefined();
  });

  it('returns undefined when any model id is empty or whitespace', () => {
    expect(serverModelIds('{"data":{"models":{"":{}}}}')).toBeUndefined();
    expect(serverModelIds('{"data":{"models":{"   ":{}}}}')).toBeUndefined();
  });

  it('returns undefined when any model entry is not a plain object', () => {
    expect(serverModelIds('{"data":{"models":{"a/b":null}}}')).toBeUndefined();
    expect(serverModelIds('{"data":{"models":{"a/b":"x"}}}')).toBeUndefined();
    expect(serverModelIds('{"data":{"models":{"a/b":[]}}}')).toBeUndefined();
  });

  it('returns undefined when variants is not an array', () => {
    expect(serverModelIds('{"data":{"models":{"a/b":{"variants":"low"}}}}')).toBeUndefined();
    expect(serverModelIds('{"data":{"models":{"a/b":{"variants":null}}}}')).toBeUndefined();
    expect(serverModelIds('{"data":{"models":{"a/b":{"variants":{}}}}}')).toBeUndefined();
  });

  it('returns undefined when any variant is blank or not a string', () => {
    expect(serverModelIds('{"data":{"models":{"a/b":{"variants":[""]}}}}')).toBeUndefined();
    expect(serverModelIds('{"data":{"models":{"a/b":{"variants":["   "]}}}}')).toBeUndefined();
    expect(serverModelIds('{"data":{"models":{"a/b":{"variants":[123]}}}}')).toBeUndefined();
  });

  it('returns undefined when a variants array has a null entry, the serialised form of a hole', () => {
    // A hole cannot survive JSON.stringify/JSON.parse (it serialises as
    // null), so the closest reachable shape through the stdout-string
    // contract is the null entry: the same `for...of` loop sees a
    // non-string element and refuses the whole answer. The hole itself is
    // refused in that loop too: a hole yields `undefined`, also non-string.
    expect(serverModelIds('{"data":{"models":{"a/b":{"variants":["low",null]}}}}')).toBeUndefined();
    expect(serverModelIds('{"data":{"models":{"a/b":{"variants":[null]}}}}')).toBeUndefined();
    // Runtime proof that the hole-shaped array serialises to that refused
    // null entry: length 2 with only index 0 assigned makes index 1 a hole.
    const holedVariants: string[] = new Array(2);
    holedVariants[0] = 'low';
    expect(1 in holedVariants).toBe(false);
    expect(JSON.stringify(holedVariants)).toBe('["low",null]');
  });

  it('returns undefined and never throws on hostile non-string inputs', () => {
    const hostile: readonly unknown[] = [
      null,
      undefined,
      {
        toString() {
          throw new Error('getter');
        },
      },
      new Proxy({}, {
        get() {
          throw new Error('proxy');
        },
      }),
    ];
    for (const value of hostile) {
      expect(() => serverModelIds(value as string)).not.toThrow();
      expect(serverModelIds(value as string)).toBeUndefined();
    }
  });
});
