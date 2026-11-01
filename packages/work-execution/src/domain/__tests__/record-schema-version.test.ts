import { describe, expect, it } from 'vitest';

import { readPlainRecordWithOptionalKeys, snapshotPlainDataRecord } from '../plain-record-reads.js';
import {
  INITIAL_RECORD_SCHEMA_VERSION,
  isAcceptedRecordSchemaVersion,
  isPlainRecordObject,
  previousRecordSchemaVersion,
  readRecordSchemaVersion,
} from '../record-schema-version.js';

describe('readRecordSchemaVersion', () => {
  it('decodes an absent schemaVersion as version 1 forever (D6)', () => {
    expect(readRecordSchemaVersion({})).toEqual({ ok: true, schemaVersion: 1, explicit: false });
    expect(readRecordSchemaVersion({ other: 'field' })).toEqual({ ok: true, schemaVersion: 1, explicit: false });
    expect(INITIAL_RECORD_SCHEMA_VERSION).toBe(1);
  });

  it('accepts an explicit schemaVersion 1', () => {
    expect(readRecordSchemaVersion({ schemaVersion: 1 })).toEqual({ ok: true, schemaVersion: 1, explicit: true });
  });

  it.each([0, -1, 2, 99, 1.5, '1', null, undefined, true, {}])(
    'refuses schemaVersion %j as unknown-schema-version',
    (value) => {
      // `undefined` arrives as an own enumerable data property, not a missing key.
      expect(readRecordSchemaVersion({ schemaVersion: value })).toEqual({
        ok: false,
        reason: 'unknown-schema-version',
      });
    },
  );

  it('refuses a non-enumerable property and an accessor as malformed', () => {
    const nonEnumerable: Record<string, unknown> = {};
    Object.defineProperty(nonEnumerable, 'schemaVersion', { value: 1, enumerable: false });
    expect(readRecordSchemaVersion(nonEnumerable)).toEqual({ ok: false, reason: 'malformed' });

    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, 'schemaVersion', {
      get() {
        throw new Error('the reader must never run an accessor');
      },
      enumerable: true,
    });
    expect(readRecordSchemaVersion(accessor)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('accepts absent, 1 and 2 under currentVersion 2 and refuses 0 and 3', () => {
    expect(readRecordSchemaVersion({}, 2)).toEqual({ ok: true, schemaVersion: 1, explicit: false });
    expect(readRecordSchemaVersion({ schemaVersion: 1 }, 2)).toEqual({ ok: true, schemaVersion: 1, explicit: true });
    expect(readRecordSchemaVersion({ schemaVersion: 2 }, 2)).toEqual({ ok: true, schemaVersion: 2, explicit: true });
    expect(readRecordSchemaVersion({ schemaVersion: 0 }, 2)).toEqual({ ok: false, reason: 'unknown-schema-version' });
    expect(readRecordSchemaVersion({ schemaVersion: 3 }, 2)).toEqual({ ok: false, reason: 'unknown-schema-version' });
  });

  it('accepts 2 and 3 under currentVersion 3 and refuses absent, 1, 0 and 4', () => {
    expect(readRecordSchemaVersion({ schemaVersion: 2 }, 3)).toEqual({ ok: true, schemaVersion: 2, explicit: true });
    expect(readRecordSchemaVersion({ schemaVersion: 3 }, 3)).toEqual({ ok: true, schemaVersion: 3, explicit: true });
    // An absent schemaVersion decodes to 1, outside the accepted window [2, 3].
    expect(readRecordSchemaVersion({}, 3)).toEqual({ ok: false, reason: 'unknown-schema-version' });
    expect(readRecordSchemaVersion({ schemaVersion: 1 }, 3)).toEqual({ ok: false, reason: 'unknown-schema-version' });
    expect(readRecordSchemaVersion({ schemaVersion: 0 }, 3)).toEqual({ ok: false, reason: 'unknown-schema-version' });
    expect(readRecordSchemaVersion({ schemaVersion: 4 }, 3)).toEqual({ ok: false, reason: 'unknown-schema-version' });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a currentVersion of %j as malformed',
    (currentVersion) => {
      expect(readRecordSchemaVersion({}, currentVersion)).toEqual({ ok: false, reason: 'malformed' });
      expect(readRecordSchemaVersion({ schemaVersion: 1 }, currentVersion)).toEqual({
        ok: false,
        reason: 'malformed',
      });
    },
  );

  it.each(['1', null, true, {}])('refuses a non-number currentVersion %j as malformed', (value) => {
    expect(readRecordSchemaVersion({}, value as never)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('never throws on hostile input and never echoes a refused value', () => {
    const throwingProxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('boom');
        },
        getOwnPropertyDescriptor() {
          throw new Error('boom');
        },
        getPrototypeOf() {
          throw new Error('boom');
        },
      },
    );
    expect(readRecordSchemaVersion(throwingProxy)).toEqual({ ok: false, reason: 'malformed' });
    expect(readRecordSchemaVersion({ schemaVersion: 'XYZZY' })).toEqual({
      ok: false,
      reason: 'unknown-schema-version',
    });
    expect(readRecordSchemaVersion(null)).toEqual({ ok: false, reason: 'malformed' });
    expect(readRecordSchemaVersion(42)).toEqual({ ok: false, reason: 'malformed' });
    expect(readRecordSchemaVersion('x')).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('previousRecordSchemaVersion and isAcceptedRecordSchemaVersion', () => {
  it('pins the migration rule of §4.5', () => {
    expect(previousRecordSchemaVersion(1)).toBe(1);
    expect(previousRecordSchemaVersion(2)).toBe(1);
    expect(previousRecordSchemaVersion(3)).toBe(2);
    expect(isAcceptedRecordSchemaVersion(1, 1)).toBe(true);
    expect(isAcceptedRecordSchemaVersion(0, 1)).toBe(false);
    expect(isAcceptedRecordSchemaVersion(2, 2)).toBe(true);
    expect(isAcceptedRecordSchemaVersion(2, 1)).toBe(false);
    expect(isAcceptedRecordSchemaVersion('1', 1)).toBe(false);
    expect(isAcceptedRecordSchemaVersion(1.5, 2)).toBe(false);
    expect(isAcceptedRecordSchemaVersion(Number.NaN, 1)).toBe(false);
  });
});

describe('isPlainRecordObject', () => {
  it('accepts plain objects and null-prototype objects only', () => {
    expect(isPlainRecordObject({})).toBe(true);
    expect(isPlainRecordObject(Object.create(null))).toBe(true);
    expect(isPlainRecordObject({ schemaVersion: 1 })).toBe(true);
    expect(isPlainRecordObject([])).toBe(false);
    expect(isPlainRecordObject(new Date())).toBe(false);
    expect(isPlainRecordObject(null)).toBe(false);
    expect(isPlainRecordObject(42)).toBe(false);
    expect(isPlainRecordObject('x')).toBe(false);
    expect(isPlainRecordObject(undefined)).toBe(false);
  });
});

describe('readPlainRecordWithOptionalKeys', () => {
  it('copies required keys and skips absent optional keys', () => {
    const read = readPlainRecordWithOptionalKeys({ a: 1, b: 'x' }, ['a'], ['b', 'c']);
    expect(read).toEqual({ a: 1, b: 'x' });
    expect(Object.hasOwn(read as Record<string, unknown>, 'c')).toBe(false);
  });

  it('keeps an optional key present with its descriptor value', () => {
    const read = readPlainRecordWithOptionalKeys({ a: 1, b: null }, ['a'], ['b']);
    expect(read).toEqual({ a: 1, b: null });
  });

  it('refuses an extra key with null', () => {
    expect(readPlainRecordWithOptionalKeys({ a: 1, b: 2, extra: 3 }, ['a'], ['b'])).toBeNull();
  });

  it('refuses a missing required key', () => {
    expect(readPlainRecordWithOptionalKeys({ b: 2 }, ['a'], ['b'])).toBeNull();
  });

  it('refuses a symbol key', () => {
    const symbol = Symbol('xyzzy');
    expect(readPlainRecordWithOptionalKeys({ [symbol]: 1, a: 1 }, ['a'], [])).toBeNull();
  });

  it('copies an enumerable getter on an optional key as undefined without running it', () => {
    const input: Record<string, unknown> = { a: 1 };
    Object.defineProperty(input, 'opt', {
      get() {
        throw new Error('the getter must never run');
      },
      enumerable: true,
    });
    const read = readPlainRecordWithOptionalKeys(input, ['a'], ['opt']);
    expect(read).toEqual({ a: 1 });
    expect(Object.hasOwn(read as Record<string, unknown>, 'opt')).toBe(true);
    expect((read as Record<string, unknown>).opt).toBeUndefined();
  });
});

describe('snapshotPlainDataRecord', () => {
  it('refuses an own __proto__ key instead of setting the prototype of the copy', () => {
    const input = {};
    Object.defineProperty(input, '__proto__', { value: { version: 1 }, enumerable: true });
    expect(snapshotPlainDataRecord(input)).toBeNull();
    expect(readPlainRecordWithOptionalKeys(input, ['__proto__'], [])).toBeNull();
  });

  it('returns a fresh copy of a plain data object', () => {
    const value = { a: 1, b: { c: 2 } };
    const snapshot = snapshotPlainDataRecord(value);
    expect(snapshot).toEqual({ a: 1, b: { c: 2 } });
    // The top-level object is fresh; values are copied by reference (shallow copy).
    expect(snapshot).not.toBe(value);
    expect(snapshot?.b).toBe(value.b);
  });

  it('refuses an enumerable getter with null (stricter than the optional-key reader)', () => {
    const input: Record<string, unknown> = { a: 1 };
    Object.defineProperty(input, 'b', {
      get() {
        throw new Error('the getter must never run');
      },
      enumerable: true,
    });
    expect(snapshotPlainDataRecord(input)).toBeNull();
  });

  it('refuses a non-plain value with null', () => {
    expect(snapshotPlainDataRecord(null)).toBeNull();
    expect(snapshotPlainDataRecord(42)).toBeNull();
    expect(snapshotPlainDataRecord('x')).toBeNull();
    expect(snapshotPlainDataRecord([])).toBeNull();
    expect(snapshotPlainDataRecord(new Date())).toBeNull();
    expect(snapshotPlainDataRecord(Object.create(null))).toEqual({});
  });
});
