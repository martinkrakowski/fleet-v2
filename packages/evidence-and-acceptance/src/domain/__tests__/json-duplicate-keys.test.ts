import { describe, expect, it, vi } from 'vitest';

import { MAX_JSON_SCAN_DEPTH, checkJsonDuplicateKeys } from '../json-duplicate-keys.js';
import { MAX_REVIEW_REPLY_LENGTH } from '../review-answer-schema.js';
import { MAX_REVIEW_STREAM_LENGTH } from '../review-stream-grammar.js';

describe('checkJsonDuplicateKeys', () => {
  it('accepts a valid reviewer reply object with unique keys', () => {
    expect(checkJsonDuplicateKeys('{"verdict":"PASS","findings":[]}')).toEqual({ ok: true });
  });

  it('accepts nested unique objects and arrays', () => {
    expect(checkJsonDuplicateKeys(
      '{"verdict":"FAIL","findings":[{"severity":"blocker","file":"a.ts","line":1,"summary":"s"}]}',
    )).toEqual({ ok: true });
  });

  it('refuses a top-level FAIL-then-PASS duplicate verdict key', () => {
    expect(
      checkJsonDuplicateKeys('{"verdict":"FAIL","findings":[],"verdict":"PASS"}'),
    ).toEqual({ ok: false, reason: 'duplicate-key' });
  });

  it('refuses a top-level PASS-then-FAIL duplicate verdict key', () => {
    expect(
      checkJsonDuplicateKeys('{"verdict":"PASS","findings":[],"verdict":"FAIL"}'),
    ).toEqual({ ok: false, reason: 'duplicate-key' });
  });

  it('refuses a nested duplicate severity key inside a finding', () => {
    expect(checkJsonDuplicateKeys(
      '{"verdict":"PASS","findings":[{"severity":"blocker","file":"a.ts","line":1,"summary":"s","severity":"nit"}]}',
    )).toEqual({ ok: false, reason: 'duplicate-key' });
  });

  it('refuses a duplicate key deeply nested inside an array of objects', () => {
    expect(checkJsonDuplicateKeys(
      '{"verdict":"PASS","findings":[[{"a":1},{"a":2,"a":3}]]}',
    )).toEqual({ ok: false, reason: 'duplicate-key' });
  });

  it('does not count keys inside string values', () => {
    expect(checkJsonDuplicateKeys(
      '{"verdict":"PASS","findings":[],"summary":"\\"verdict\\":\\"FAIL\\""}',
    )).toEqual({ ok: true });
  });

  it('handles escaped quotes and escaped backslashes and refuses unicode-escaped duplicate keys', () => {
    expect(checkJsonDuplicateKeys('{"a":"quote \\" and backslash \\\\","b":"x"}')).toEqual({ ok: true });
    expect(
      checkJsonDuplicateKeys('{"verdict":"PASS","\\u0076erdict":"FAIL","findings":[]}'),
    ).toEqual({ ok: false, reason: 'duplicate-key' });
  });

  it('accepts leading whitespace before the root value and trailing whitespace after it', () => {
    expect(checkJsonDuplicateKeys('  \n\t {"verdict":"PASS","findings":[]} \r\n ')).toEqual({ ok: true });
  });

  it('refuses malformed JSON and trailing non-whitespace tokens', () => {
    expect(checkJsonDuplicateKeys('{"verdict":')).toEqual({ ok: false, reason: 'invalid-json' });
    expect(checkJsonDuplicateKeys('{"verdict":"PASS"}x')).toEqual({ ok: false, reason: 'invalid-json' });
    expect(checkJsonDuplicateKeys('{"verdict":"PASS"} {"a":1}')).toEqual({ ok: false, reason: 'invalid-json' });
    expect(checkJsonDuplicateKeys('{"verdict":"PASS"}')).toEqual({ ok: true });
  });

  it('refuses duplicate __proto__ keys and never mutates Object.prototype', () => {
    const beforeNames = Object.getOwnPropertyNames(Object.prototype);
    const beforeSymbols = Object.getOwnPropertySymbols(Object.prototype);
    expect(
      checkJsonDuplicateKeys('{"__proto__":1,"__proto__":2}'),
    ).toEqual({ ok: false, reason: 'duplicate-key' });
    expect(
      checkJsonDuplicateKeys('{"__proto__":{},"verdict":"PASS","findings":[]}'),
    ).toEqual({ ok: true });
    expect(Object.getOwnPropertyNames(Object.prototype)).toEqual(beforeNames);
    expect(Object.getOwnPropertySymbols(Object.prototype)).toEqual(beforeSymbols);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses invalid JSON escapes in keys and values as invalid-json', () => {
    // `JSON.parse` refuses `\x61` (a non-JSON escape) and would keep the last
    // `a` key, so the scanner refuses before any parse. Cost bound: one
    // linear pass over the string body per string.
    expect(checkJsonDuplicateKeys('{"\\x61":1,"a":2}')).toEqual({ ok: false, reason: 'invalid-json' });
    expect(checkJsonDuplicateKeys('{"a":"\\x61"}')).toEqual({ ok: false, reason: 'invalid-json' });
    expect(checkJsonDuplicateKeys('{"a":"\\a"}')).toEqual({ ok: false, reason: 'invalid-json' });
    expect(checkJsonDuplicateKeys('{"a":"\\\'"}')).toEqual({ ok: false, reason: 'invalid-json' });
    expect(checkJsonDuplicateKeys('{"\\u12":1}')).toEqual({ ok: false, reason: 'invalid-json' });
    expect(checkJsonDuplicateKeys('{"a":"\\uZZZZ"}')).toEqual({ ok: false, reason: 'invalid-json' });
    expect(checkJsonDuplicateKeys('{"a":"trailing\\')).toEqual({ ok: false, reason: 'invalid-json' });
  });

  it('refuses raw control characters below U+0020 in string keys and values as invalid-json', () => {
    expect(checkJsonDuplicateKeys('{"a":"hello\u000aworld"}')).toEqual({ ok: false, reason: 'invalid-json' });
    expect(checkJsonDuplicateKeys('{"a":"null\u0000byte"}')).toEqual({ ok: false, reason: 'invalid-json' });
    expect(checkJsonDuplicateKeys('{"a":"unit\u001fsep"}')).toEqual({ ok: false, reason: 'invalid-json' });
    expect(checkJsonDuplicateKeys('{"bad\u0009key":1}')).toEqual({ ok: false, reason: 'invalid-json' });
  });

  it('honours a custom maxLength within the stream cap', () => {
    // The check is one O(1) length comparison before any scanning.
    const oversizedReply = '"' + 'a'.repeat(MAX_REVIEW_REPLY_LENGTH) + '"';
    expect(oversizedReply.length).toBeGreaterThan(MAX_REVIEW_REPLY_LENGTH);
    expect(checkJsonDuplicateKeys(oversizedReply, MAX_REVIEW_STREAM_LENGTH)).toEqual({ ok: true });
    expect(
      checkJsonDuplicateKeys('0'.repeat(MAX_REVIEW_STREAM_LENGTH + 1), MAX_REVIEW_STREAM_LENGTH),
    ).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('refuses a negative, NaN or Infinity maxLength as invalid-input', () => {
    for (const badMaxLength of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(checkJsonDuplicateKeys('{"a":1}', badMaxLength)).toEqual({
        ok: false,
        reason: 'invalid-input',
      });
    }
  });

  it('returns a typed invalid-input result on hostile non-string inputs without throwing and never runs getters or Proxy traps', () => {
    const getterSpy = vi.fn(() => {
      throw new Error('getter ran');
    });
    const throwingGetter = Object.create(null, { length: { get: getterSpy } });
    const trapSpy = vi.fn(() => {
      throw new Error('trap ran');
    });
    const lyingProxy = new Proxy({}, {
      get: trapSpy,
      has: trapSpy,
      ownKeys: trapSpy,
    });
    const holed: unknown[] = new Array(2);
    holed[1] = '{';
    const hostile: readonly unknown[] = [
      null,
      undefined,
      42,
      true,
      holed,
      { map: () => {} },
      throwingGetter,
      lyingProxy,
      { length: 2 ** 31 - 1, 0: '{' },
    ];
    for (const value of hostile) {
      expect(() => checkJsonDuplicateKeys(value)).not.toThrow();
      expect(checkJsonDuplicateKeys(value)).toEqual({ ok: false, reason: 'invalid-input' });
    }
    // The invalid-input guard runs before any property access, so the
    // throwing getter and every Proxy trap are provably never invoked.
    expect(getterSpy).not.toHaveBeenCalled();
    expect(trapSpy).not.toHaveBeenCalled();
    // Prototype-polluting keys are data: unique ones are accepted (the
    // scanner never touches Object.prototype) and a repeated one is refused.
    expect(checkJsonDuplicateKeys('{"__proto__":1,"constructor":2,"prototype":3}')).toEqual({
      ok: true,
    });
    expect(checkJsonDuplicateKeys('{"constructor":1,"constructor":2}')).toEqual({
      ok: false,
      reason: 'duplicate-key',
    });
  });

  it('refuses inputs exceeding maxLength as invalid-input before scanning', () => {
    const oversized = '"' + 'a'.repeat(MAX_REVIEW_REPLY_LENGTH) + '"';
    expect(oversized.length).toBeGreaterThan(MAX_REVIEW_REPLY_LENGTH);
    expect(checkJsonDuplicateKeys(oversized)).toEqual({ ok: false, reason: 'invalid-input' });
    expect(checkJsonDuplicateKeys('{'.repeat(MAX_REVIEW_REPLY_LENGTH + 1))).toEqual({
      ok: false,
      reason: 'invalid-input',
    });
  });

  it('enforces the nesting depth cost bound', () => {
    const tooDeep = '['.repeat(MAX_JSON_SCAN_DEPTH + 1);
    expect(checkJsonDuplicateKeys(tooDeep)).toEqual({ ok: false, reason: 'invalid-input' });
    const atLimit = '['.repeat(MAX_JSON_SCAN_DEPTH) + ']'.repeat(MAX_JSON_SCAN_DEPTH);
    expect(checkJsonDuplicateKeys(atLimit)).toEqual({ ok: true });
  });
});
