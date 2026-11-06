import { describe, expect, it } from 'vitest';
import { MAX_DEPTH, MAX_SCHEMA_FIELDS, readPlainRecord } from '../plain-record.js';
import type { PlainFieldSchema, PlainRecordSchema } from '../plain-record.js';

const STRING_ONLY: PlainRecordSchema = {
  name: { kind: 'string', maxLength: 10 },
};

describe('readPlainRecord', () => {
  it('snapshots a plain record with all declared fields into a frozen value', () => {
    const schema: PlainRecordSchema = {
      name: { kind: 'string', maxLength: 10 },
      age: { kind: 'integer', min: 0, max: 150 },
      active: { kind: 'boolean' },
      role: { kind: 'literal', values: ['admin', 'member'] },
    };
    const input = { name: 'ada', age: 36, active: true, role: 'admin' };
    const read = readPlainRecord(input, schema);
    expect(read).toEqual({ ok: true, value: { name: 'ada', age: 36, active: true, role: 'admin' } });
    if (read.ok) {
      expect(Object.isFrozen(read.value)).toBe(true);
    }
  });

  it('copies a nested record and array as fresh frozen snapshots', () => {
    const schema: PlainRecordSchema = {
      laneId: { kind: 'string', maxLength: 100 },
      meta: { kind: 'record', schema: { note: { kind: 'string', maxLength: 10 } } },
      facts: {
        kind: 'array',
        maxLength: 10,
        items: {
          kind: 'record',
          schema: { label: { kind: 'string', maxLength: 10 } },
        },
      },
    };
    const input = {
      laneId: 'L1',
      meta: { note: 'hi' },
      facts: [{ label: 'a' }, { label: 'b' }],
    };
    const read = readPlainRecord(input, schema);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value).not.toBe(input);
      expect(read.value.meta).not.toBe(input.meta);
      expect(read.value.facts).not.toBe(input.facts);
      expect(Object.isFrozen(read.value)).toBe(true);
      expect(Object.isFrozen(read.value.meta)).toBe(true);
      expect(Object.isFrozen(read.value.facts)).toBe(true);
      expect(Object.isFrozen((read.value.facts as readonly unknown[])[0])).toBe(true);
    }
  });

  it('ignores undeclared extra own fields', () => {
    const read = readPlainRecord({ name: 'ada', extra: { deep: true } }, STRING_ONLY);
    expect(read).toEqual({ ok: true, value: { name: 'ada' } });
  });

  it('omits an absent optional field', () => {
    const schema: PlainRecordSchema = {
      name: { kind: 'string', maxLength: 10 },
      nickname: { kind: 'string', maxLength: 10, optional: true },
    };
    const read = readPlainRecord({ name: 'ada' }, schema);
    expect(read).toEqual({ ok: true, value: { name: 'ada' } });
  });

  describe('typed field checks', () => {
    it('refuses a non-string or over-long string', () => {
      expect(readPlainRecord({ name: 42 }, STRING_ONLY)).toEqual({
        ok: false,
        reason: 'wrong-type',
        field: 'name',
      });
      expect(readPlainRecord({ name: 'x'.repeat(11) }, STRING_ONLY)).toEqual({
        ok: false,
        reason: 'too-long',
        field: 'name',
      });
    });

    it('refuses a non-integer or out-of-range integer', () => {
      const schema: PlainRecordSchema = { n: { kind: 'integer', min: 1, max: 10 } };
      expect(readPlainRecord({ n: 1.5 }, schema)).toEqual({
        ok: false,
        reason: 'wrong-type',
        field: 'n',
      });
      expect(readPlainRecord({ n: '1' }, schema)).toEqual({
        ok: false,
        reason: 'wrong-type',
        field: 'n',
      });
      expect(readPlainRecord({ n: 0 }, schema)).toEqual({
        ok: false,
        reason: 'out-of-range',
        field: 'n',
      });
      expect(readPlainRecord({ n: 11 }, schema)).toEqual({
        ok: false,
        reason: 'out-of-range',
        field: 'n',
      });
    });

    it('refuses a non-boolean', () => {
      const schema: PlainRecordSchema = { b: { kind: 'boolean' } };
      expect(readPlainRecord({ b: 'yes' }, schema)).toEqual({
        ok: false,
        reason: 'wrong-type',
        field: 'b',
      });
    });

    it('refuses an unknown literal and accepts an allowed one', () => {
      const schema: PlainRecordSchema = { kind: { kind: 'literal', values: ['a', 'b'] } };
      expect(readPlainRecord({ kind: 'c' }, schema)).toEqual({
        ok: false,
        reason: 'not-a-literal',
        field: 'kind',
      });
      expect(readPlainRecord({ kind: 'a' }, schema)).toEqual({ ok: true, value: { kind: 'a' } });
    });

    it('reports nested missing fields with a dotted path', () => {
      const schema: PlainRecordSchema = {
        fact: { kind: 'record', schema: { label: { kind: 'string', maxLength: 10 } } },
      };
      expect(readPlainRecord({ fact: {} }, schema)).toEqual({
        ok: false,
        reason: 'missing-field',
        field: 'fact.label',
      });
    });

    it('refuses a nested non-plain value with its path', () => {
      const schema: PlainRecordSchema = {
        fact: { kind: 'record', schema: { label: { kind: 'string', maxLength: 10 } } },
      };
      expect(readPlainRecord({ fact: new Date() }, schema)).toEqual({
        ok: false,
        reason: 'not-plain',
        field: 'fact',
      });
    });

    it('refuses a non-array with the field path', () => {
      const schema: PlainRecordSchema = {
        items: { kind: 'array', maxLength: 5, items: { kind: 'string', maxLength: 10 } },
      };
      expect(readPlainRecord({ items: 'x' }, schema)).toEqual({
        ok: false,
        reason: 'wrong-type',
        field: 'items',
      });
    });

    it('refuses a sparse array at the hole index', () => {
      const schema: PlainRecordSchema = {
        items: { kind: 'array', maxLength: 5, items: { kind: 'string', maxLength: 10 } },
      };
      const sparse = new Array(2);
      sparse[0] = 'x';
      expect(readPlainRecord({ items: sparse }, schema)).toEqual({
        ok: false,
        reason: 'sparse-array',
        field: 'items[1]',
      });
    });

    it('refuses an oversized array', () => {
      const schema: PlainRecordSchema = {
        items: { kind: 'array', maxLength: 2, items: { kind: 'string', maxLength: 10 } },
      };
      expect(readPlainRecord({ items: ['a', 'b', 'c'] }, schema)).toEqual({
        ok: false,
        reason: 'too-many-items',
        field: 'items',
      });
    });

    it('refuses a wrong-typed item with its index path', () => {
      const schema: PlainRecordSchema = {
        items: { kind: 'array', maxLength: 5, items: { kind: 'string', maxLength: 10 } },
      };
      expect(readPlainRecord({ items: [123] }, schema)).toEqual({
        ok: false,
        reason: 'wrong-type',
        field: 'items[0]',
      });
    });
  });

  describe('hostile input', () => {
    it('refuses a throwing getter as not-data-property without running it', () => {
      let ran = false;
      const input: Record<string, unknown> = {};
      Object.defineProperty(input, 'name', {
        enumerable: true,
        configurable: true,
        get() {
          ran = true;
          throw new Error('boom');
        },
      });
      const read = readPlainRecord(input, STRING_ONLY);
      expect(read).toEqual({ ok: false, reason: 'not-data-property', field: 'name' });
      expect(ran).toBe(false);
    });

    it('refuses a hostile proxy descriptor trap as hostile with the field name', () => {
      const input = new Proxy({}, {
        getOwnPropertyDescriptor() {
          throw new Error('trap');
        },
      });
      const read = readPlainRecord(input, STRING_ONLY);
      expect(read).toEqual({ ok: false, reason: 'hostile', field: 'name' });
    });

    it('refuses a field planted on the prototype as not-plain without reading it', () => {
      let plantedRan = false;
      const prototype = {
        get name() {
          plantedRan = true;
          return 'planted';
        },
      };
      const input = Object.create(prototype);
      const read = readPlainRecord(input, STRING_ONLY);
      expect(read).toEqual({ ok: false, reason: 'not-plain', field: null });
      expect(plantedRan).toBe(false);
    });

    it('refuses non-plain object values', () => {
      class Example {}
      for (const input of [new Example(), new Map(), new Date()]) {
        const read = readPlainRecord(input, STRING_ONLY);
        expect(read).toEqual({ ok: false, reason: 'not-plain', field: null });
      }
    });

    it('refuses non-object inputs', () => {
      for (const input of [null, undefined, 42, 'text', true]) {
        const read = readPlainRecord(input, STRING_ONLY);
        expect(read).toEqual({ ok: false, reason: 'not-an-object', field: null });
      }
    });

    it('never throws and always returns a typed refusal for any hostile input', () => {
      let getterRan = false;
      const getterInput: Record<string, unknown> = {};
      Object.defineProperty(getterInput, 'name', {
        enumerable: true,
        get() {
          getterRan = true;
          throw new Error('boom');
        },
      });
      const sparse = new Array(2);
      const hostile: readonly unknown[] = [
        null,
        undefined,
        42,
        'text',
        true,
        { name: 'x'.repeat(11) },
        { name: null },
        { items: sparse },
        { kind: 'c' },
        getterInput,
      ];
      const schema: PlainRecordSchema = {
        name: { kind: 'string', maxLength: 10 },
        items: { kind: 'array', maxLength: 2, items: { kind: 'string', maxLength: 10 } },
        kind: { kind: 'literal', values: ['a'] },
      };
      for (const input of hostile) {
        expect(() => readPlainRecord(input, schema)).not.toThrow();
        const read = readPlainRecord(input, schema);
        expect(read.ok).toBe(false);
        if (!read.ok) {
          expect([
            'not-an-object',
            'not-plain',
            'not-data-property',
            'missing-field',
            'wrong-type',
            'too-long',
            'not-a-literal',
            'sparse-array',
          ]).toContain(read.reason);
        }
      }
      expect(getterRan).toBe(false);
    });
  });

  it('reads exactly one descriptor per expected field and touches no other trap', () => {
    const traps = { get: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, getPrototypeOf: 0 };
    const input = new Proxy({ name: 'ada' }, {
      get(target, property, receiver) {
        traps.get += 1;
        return Reflect.get(target, property, receiver);
      },
      ownKeys(target) {
        traps.ownKeys += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, property) {
        traps.getOwnPropertyDescriptor += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      getPrototypeOf(target) {
        traps.getPrototypeOf += 1;
        return Reflect.getPrototypeOf(target);
      },
    });
    const read = readPlainRecord(input, STRING_ONLY);
    expect(read).toEqual({ ok: true, value: { name: 'ada' } });
    expect(traps.getOwnPropertyDescriptor).toBe(1);
    expect(traps.getPrototypeOf).toBeLessThanOrEqual(1);
    expect(traps.get).toBe(0);
    expect(traps.ownKeys).toBe(0);
  });

  it('never echoes an input value into a refusal', () => {
    const credential = 'gh' + 'p_' + 'x'.repeat(30);
    const read = readPlainRecord({ name: credential }, STRING_ONLY);
    const serialized = JSON.stringify(read);
    expect(serialized).not.toContain(credential);
    expect(serialized).toBe(JSON.stringify({ ok: false, reason: 'too-long', field: 'name' }));
  });

  it('refuses a schema wider than MAX_SCHEMA_FIELDS', () => {
    const wide: Record<string, PlainFieldSchema> = {};
    for (let i = 0; i < MAX_SCHEMA_FIELDS + 1; i += 1) {
      wide[`field${i}`] = { kind: 'string', maxLength: 10 };
    }
    expect(readPlainRecord({}, wide)).toEqual({ ok: false, reason: 'invalid-schema', field: null });
  });

  it('refuses a schema declaring __proto__', () => {
    const schema: Record<string, PlainFieldSchema> = {};
    Object.defineProperty(schema, '__proto__', {
      enumerable: true,
      value: { kind: 'string', maxLength: 10 },
    });
    expect(readPlainRecord({}, schema)).toEqual({ ok: false, reason: 'invalid-schema', field: null });
  });

  it('refuses a schema with a negative bound', () => {
    expect(readPlainRecord({}, { x: { kind: 'string', maxLength: -1 } })).toEqual({
      ok: false,
      reason: 'invalid-schema',
      field: null,
    });
    expect(readPlainRecord({}, { x: { kind: 'integer', min: -1 } })).toEqual({
      ok: false,
      reason: 'invalid-schema',
      field: null,
    });
    expect(readPlainRecord({}, { x: { kind: 'integer', max: -1 } })).toEqual({
      ok: false,
      reason: 'invalid-schema',
      field: null,
    });
  });

  it('refuses input deeper than MAX_DEPTH as too-deep', () => {
    let schema: PlainRecordSchema = { leaf: { kind: 'string', maxLength: 10 } };
    let input: unknown = { leaf: 'x' };
    for (let i = 0; i < MAX_DEPTH + 1; i += 1) {
      schema = { next: { kind: 'record', schema } };
      input = { next: input };
    }
    const read = readPlainRecord(input, schema);
    expect(read).toEqual({
      ok: false,
      reason: 'too-deep',
      field: 'next.next.next.next.next.next.next.next.next',
    });
  });

  it('refuses nine nested array layers as too-deep', () => {
    let itemSchema: PlainFieldSchema = { kind: 'string', maxLength: 10 };
    let value: unknown = 'x';
    for (let i = 0; i < MAX_DEPTH + 1; i += 1) {
      itemSchema = { kind: 'array', maxLength: 1, items: itemSchema };
      value = [value];
    }
    const schema: PlainRecordSchema = { items: itemSchema };
    const read = readPlainRecord({ items: value }, schema);
    expect(read).toEqual({
      ok: false,
      reason: 'too-deep',
      field: 'items[0][0][0][0][0][0][0][0]',
    });
  });

  it('refuses a schema with a non-finite bound', () => {
    expect(readPlainRecord({}, { x: { kind: 'string', maxLength: Infinity } })).toEqual({
      ok: false,
      reason: 'invalid-schema',
      field: null,
    });
    expect(readPlainRecord({}, { x: { kind: 'string', maxLength: Number.NaN } })).toEqual({
      ok: false,
      reason: 'invalid-schema',
      field: null,
    });
    expect(readPlainRecord(
      {},
      { x: { kind: 'array', maxLength: Infinity, items: { kind: 'string', maxLength: 10 } } },
    )).toEqual({
      ok: false,
      reason: 'invalid-schema',
      field: null,
    });
  });
});
