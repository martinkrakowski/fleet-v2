// Unit tests for the state-check record parsers and the shared record-list
// inspection they feed. Accessor refusal is part of the contract: an own
// getter on `id` or `attemptId` must never be invoked by these parsers.
import { describe, expect, it } from 'vitest';
import {
  parseContextSelectionStateRecord,
  parseKnowledgeEntryStateRecord,
} from '../KnowledgeEntryRepositoryAdapter.adapter.js';
import { inspectRecordListBytes } from '../file-store.js';

// Simpler helper: build an object with an own getter on `field` that counts
// calls and returns `value` (or throws when `throwing` is set).
function withGetter(
  field: 'id' | 'attemptId',
  options: { value?: string; throwing?: boolean },
): { calls: () => number; record: object } {
  let calls = 0;
  const record: object = {};
  Object.defineProperty(record, field, {
    get() {
      calls += 1;
      if (options.throwing) {
        throw new Error('getter blew up');
      }
      return options.value ?? 'a';
    },
    enumerable: true,
    configurable: true,
  });
  return { calls: () => calls, record };
}

describe('parseKnowledgeEntryStateRecord', () => {
  it('returns the exact same object reference for a plain object with a string id, including the empty string (an empty id is kept today)', () => {
    const record = { id: 'a' };
    expect(parseKnowledgeEntryStateRecord(record)).toBe(record);
    const emptyId = { id: '' };
    // An empty `id` is kept today; the parser only checks the type.
    expect(parseKnowledgeEntryStateRecord(emptyId)).toBe(emptyId);
  });

  it('returns undefined for null, undefined, and non-object primitives', () => {
    expect(parseKnowledgeEntryStateRecord(null)).toBeUndefined();
    expect(parseKnowledgeEntryStateRecord(undefined)).toBeUndefined();
    expect(parseKnowledgeEntryStateRecord('a')).toBeUndefined();
    expect(parseKnowledgeEntryStateRecord(1)).toBeUndefined();
    expect(parseKnowledgeEntryStateRecord(true)).toBeUndefined();
  });

  it('returns undefined for objects without a string id (missing, numeric, array, boxed string)', () => {
    expect(parseKnowledgeEntryStateRecord({})).toBeUndefined();
    expect(parseKnowledgeEntryStateRecord({ id: 1 })).toBeUndefined();
    expect(parseKnowledgeEntryStateRecord({ id: ['a'] })).toBeUndefined();
    expect(parseKnowledgeEntryStateRecord(new String('a'))).toBeUndefined();
    expect(parseKnowledgeEntryStateRecord({ id: new String('a') })).toBeUndefined();
  });

  it('refuses a record shaped for the other parser ({ attemptId }) without accepting it', () => {
    expect(parseKnowledgeEntryStateRecord({ attemptId: 'a' })).toBeUndefined();
  });

  it('refuses arrays, even with an own string id', () => {
    expect(parseKnowledgeEntryStateRecord([])).toBeUndefined();
    expect(parseKnowledgeEntryStateRecord(['x'])).toBeUndefined();
    expect(parseKnowledgeEntryStateRecord(Object.assign(['x'], { id: 'a' }))).toBeUndefined();
  });

  it('refuses an array-like record (own numeric length) that also carries a string id', () => {
    const arrayLike: Record<string, unknown> = { id: 'a', length: 1, 0: 'x' };
    expect(parseKnowledgeEntryStateRecord(arrayLike)).toBeUndefined();
  });

  it('refuses a record with an enormous own numeric length, before reading anything else', () => {
    const enormous: Record<string, unknown> = { id: 'a', length: Number.MAX_SAFE_INTEGER };
    expect(parseKnowledgeEntryStateRecord(enormous)).toBeUndefined();
  });

  it('refuses a Proxy around a valid record without running any trap', () => {
    let trapCalls = 0;
    const proxy = new Proxy({ id: 'a' }, {
      get(target, key, receiver) {
        trapCalls += 1;
        return Reflect.get(target, key, receiver);
      },
      getOwnPropertyDescriptor(target, key) {
        trapCalls += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    expect(parseKnowledgeEntryStateRecord(proxy)).toBeUndefined();
    expect(trapCalls).toBe(0);
  });

  it('refuses an own __proto__ key on an otherwise valid record, without polluting Object.prototype', () => {
    const record: Record<string, unknown> = { id: 'a' };
    Object.defineProperty(record, '__proto__', {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(Object.hasOwn(record, '__proto__')).toBe(true);
    expect(parseKnowledgeEntryStateRecord(record)).toBeUndefined();
    expect('polluted' in Object.prototype).toBe(false);
  });

  it('refuses an own getter id with a typed refusal (undefined) and never invokes it (call count 0)', () => {
    const { calls, record } = withGetter('id', { value: 'a' });
    expect(parseKnowledgeEntryStateRecord(record)).toBeUndefined();
    expect(calls()).toBe(0);
  });

  it('refuses an own throwing getter id (undefined) and never invokes it (call count 0)', () => {
    const { calls, record } = withGetter('id', { throwing: true });
    expect(parseKnowledgeEntryStateRecord(record)).toBeUndefined();
    expect(calls()).toBe(0);
  });
});

describe('parseContextSelectionStateRecord', () => {
  it('returns the exact same object reference for a plain object with a string attemptId, including the empty string (an empty attemptId is kept today)', () => {
    const record = { attemptId: 'a' };
    expect(parseContextSelectionStateRecord(record)).toBe(record);
    const emptyAttemptId = { attemptId: '' };
    // An empty `attemptId` is kept today; the parser only checks the type.
    expect(parseContextSelectionStateRecord(emptyAttemptId)).toBe(emptyAttemptId);
  });

  it('returns undefined for null, undefined, and non-object primitives', () => {
    expect(parseContextSelectionStateRecord(null)).toBeUndefined();
    expect(parseContextSelectionStateRecord(undefined)).toBeUndefined();
    expect(parseContextSelectionStateRecord('a')).toBeUndefined();
    expect(parseContextSelectionStateRecord(1)).toBeUndefined();
    expect(parseContextSelectionStateRecord(true)).toBeUndefined();
  });

  it('returns undefined for objects without a string attemptId (missing, numeric, array, boxed string)', () => {
    expect(parseContextSelectionStateRecord({})).toBeUndefined();
    expect(parseContextSelectionStateRecord({ attemptId: 1 })).toBeUndefined();
    expect(parseContextSelectionStateRecord({ attemptId: ['a'] })).toBeUndefined();
    expect(parseContextSelectionStateRecord(new String('a'))).toBeUndefined();
    expect(parseContextSelectionStateRecord({ attemptId: new String('a') })).toBeUndefined();
  });

  it('refuses a record shaped for the other parser ({ id }) without accepting it', () => {
    expect(parseContextSelectionStateRecord({ id: 'a' })).toBeUndefined();
  });

  it('refuses arrays, even with an own string attemptId', () => {
    expect(parseContextSelectionStateRecord([])).toBeUndefined();
    expect(parseContextSelectionStateRecord(['x'])).toBeUndefined();
    expect(parseContextSelectionStateRecord(Object.assign(['x'], { attemptId: 'a' }))).toBeUndefined();
  });

  it('refuses an array-like record (own numeric length) that also carries a string attemptId', () => {
    const arrayLike: Record<string, unknown> = { attemptId: 'a', length: 1, 0: 'x' };
    expect(parseContextSelectionStateRecord(arrayLike)).toBeUndefined();
  });

  it('refuses a record with an enormous own numeric length, before reading anything else', () => {
    const enormous: Record<string, unknown> = { attemptId: 'a', length: Number.MAX_SAFE_INTEGER };
    expect(parseContextSelectionStateRecord(enormous)).toBeUndefined();
  });

  it('refuses a Proxy around a valid record without running any trap', () => {
    let trapCalls = 0;
    const proxy = new Proxy({ attemptId: 'a' }, {
      get(target, key, receiver) {
        trapCalls += 1;
        return Reflect.get(target, key, receiver);
      },
      getOwnPropertyDescriptor(target, key) {
        trapCalls += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    expect(parseContextSelectionStateRecord(proxy)).toBeUndefined();
    expect(trapCalls).toBe(0);
  });

  it('refuses an own __proto__ key on an otherwise valid record, without polluting Object.prototype', () => {
    const record: Record<string, unknown> = { attemptId: 'a' };
    Object.defineProperty(record, '__proto__', {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(Object.hasOwn(record, '__proto__')).toBe(true);
    expect(parseContextSelectionStateRecord(record)).toBeUndefined();
    expect('polluted' in Object.prototype).toBe(false);
  });

  it('refuses an own getter attemptId with a typed refusal (undefined) and never invokes it (call count 0)', () => {
    const { calls, record } = withGetter('attemptId', { value: 'a' });
    expect(parseContextSelectionStateRecord(record)).toBeUndefined();
    expect(calls()).toBe(0);
  });

  it('refuses an own throwing getter attemptId (undefined) and never invokes it (call count 0)', () => {
    const { calls, record } = withGetter('attemptId', { throwing: true });
    expect(parseContextSelectionStateRecord(record)).toBeUndefined();
    expect(calls()).toBe(0);
  });
});

describe('inspectRecordListBytes', () => {
  it('parses every record of a JSON array with parseKnowledgeEntryStateRecord when all have string ids', () => {
    expect(
      inspectRecordListBytes(
        Buffer.from('[{"id":"a"},{"id":"b"}]'),
        parseKnowledgeEntryStateRecord,
      ),
    ).toEqual({ status: 'ok', records: [{ id: 'a' }, { id: 'b' }] });
  });

  it('parses every record of a JSON array with parseContextSelectionStateRecord when all have string attemptIds', () => {
    expect(
      inspectRecordListBytes(
        Buffer.from('[{"attemptId":"a"},{"attemptId":"b"}]'),
        parseContextSelectionStateRecord,
      ),
    ).toEqual({ status: 'ok', records: [{ attemptId: 'a' }, { attemptId: 'b' }] });
  });

  it('marks the first invalid record invalid with the reader detail for the entries parser', () => {
    expect(
      inspectRecordListBytes(
        Buffer.from('[{"id":"a"},{"x":1}]'),
        parseKnowledgeEntryStateRecord,
      ),
    ).toEqual({ status: 'unreadable', detail: 'record 1 failed validation', recordIndex: 1 });
  });

  it('marks the first invalid record invalid with the reader detail for the selections parser', () => {
    expect(
      inspectRecordListBytes(
        Buffer.from('[{"attemptId":"a"},{"x":1}]'),
        parseContextSelectionStateRecord,
      ),
    ).toEqual({ status: 'unreadable', detail: 'record 1 failed validation', recordIndex: 1 });
  });

  it('catches a throwing parseRecord and marks that element invalid without crashing the read', () => {
    const throwingParser = (): { id: string } | undefined => {
      throw new Error('validation blew up');
    };
    expect(
      inspectRecordListBytes(
        Buffer.from('[{"id":"a"},{"id":"b"}]'),
        throwingParser,
      ),
    ).toEqual({ status: 'unreadable', detail: 'record 0 failed validation', recordIndex: 0 });
  });

  it('refuses a getter-only record at index 0 through the entries parser without ever invoking the getter (JSON.stringify skips a non-enumerable getter, so the bytes carry no id)', () => {
    let calls = 0;
    const record: object = {};
    Object.defineProperty(record, 'id', {
      get() {
        calls += 1;
        return 'a';
      },
      enumerable: false,
      configurable: true,
    });
    const bytes = Buffer.from(JSON.stringify([record]));
    expect(bytes.toString('utf8')).toBe('[{}]');
    expect(
      inspectRecordListBytes(bytes, parseKnowledgeEntryStateRecord),
    ).toEqual({ status: 'unreadable', detail: 'record 0 failed validation', recordIndex: 0 });
    expect(calls).toBe(0);
  });

  it('reports not valid JSON for malformed bytes', () => {
    expect(
      inspectRecordListBytes(
        Buffer.from('not json'),
        parseKnowledgeEntryStateRecord,
      ),
    ).toEqual({ status: 'unreadable', detail: 'not valid JSON', recordIndex: null });
  });

  it('reports expects a record list when the JSON is not an array', () => {
    expect(
      inspectRecordListBytes(
        Buffer.from('{"id":"a"}'),
        parseKnowledgeEntryStateRecord,
      ),
    ).toEqual({ status: 'unreadable', detail: 'expects a record list', recordIndex: null });
  });

  it('refuses a record with a __proto__ key and does not pollute Object.prototype', () => {
    expect(
      inspectRecordListBytes(
        Buffer.from('[{"id":"a","__proto__":{"polluted":true}}]'),
        parseKnowledgeEntryStateRecord,
      ),
    ).toEqual({ status: 'unreadable', detail: 'record 0 failed validation', recordIndex: 0 });
    expect('polluted' in Object.prototype).toBe(false);
  });
});
