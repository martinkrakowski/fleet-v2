/**
 * A pure runtime-input guard: snapshots an unknown value into a frozen plain
 * record using own data properties only. No getter ever runs, no prototype
 * field is read, dense arrays only, typed field checks per schema, and every
 * bound comes from the schema or the exported limits, so the reader is
 * bounded by construction. It never throws: a hostile Proxy trap or a
 * throwing descriptor is a typed refusal (`hostile`), never an exception.
 */

export type PlainFieldSchema =
  | { readonly kind: 'string'; readonly maxLength: number; readonly optional?: true }
  | { readonly kind: 'integer'; readonly min?: number; readonly max?: number; readonly optional?: true }
  | { readonly kind: 'boolean'; readonly optional?: true }
  | { readonly kind: 'literal'; readonly values: readonly string[]; readonly optional?: true }
  | { readonly kind: 'record'; readonly schema: PlainRecordSchema; readonly optional?: true }
  | { readonly kind: 'array'; readonly items: PlainFieldSchema; readonly maxLength: number; readonly optional?: true };

export type PlainRecordSchema = Readonly<Record<string, PlainFieldSchema>>;

export type PlainRecordFailureReason =
  | 'not-an-object'
  | 'not-plain'
  | 'not-data-property'
  | 'missing-field'
  | 'wrong-type'
  | 'too-long'
  | 'out-of-range'
  | 'not-a-literal'
  | 'sparse-array'
  | 'too-many-items'
  | 'too-deep'
  | 'hostile'
  | 'invalid-schema';

export type PlainRecordRead =
  | { readonly ok: true; readonly value: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly reason: PlainRecordFailureReason; readonly field: string | null };

/** At most this many declared fields in one schema level. */
export const MAX_SCHEMA_FIELDS = 64;
/** At most this many nested record/array levels. */
export const MAX_DEPTH = 8;

/** A schema that cannot be trusted never leaks a field or value. */
const INVALID_SCHEMA: PlainRecordRead = { ok: false, reason: 'invalid-schema', field: null };

interface ReadState {
  /** The field path whose read was in flight, `null` before any field read. */
  inFlight: string | null;
}

export function readPlainRecord(input: unknown, schema: PlainRecordSchema): PlainRecordRead {
  const state: ReadState = { inFlight: null };
  try {
    return readSnap(input, schema, 0, '', state);
  } catch {
    return { ok: false, reason: 'hostile', field: state.inFlight };
  }
}

function readSnap(
  input: unknown,
  schema: PlainRecordSchema,
  depth: number,
  path: string,
  state: ReadState,
): PlainRecordRead {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return INVALID_SCHEMA;
  }
  const keys = Object.keys(schema);
  if (keys.length > MAX_SCHEMA_FIELDS) {
    return INVALID_SCHEMA;
  }
  for (const key of keys) {
    if (key === '__proto__' || !isValidFieldSchema(schema[key])) {
      return INVALID_SCHEMA;
    }
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, reason: 'not-an-object', field: path === '' ? null : path };
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    return { ok: false, reason: 'not-plain', field: path === '' ? null : path };
  }
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const fieldPath = path === '' ? key : `${path}.${key}`;
    state.inFlight = fieldPath;
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined) {
      if (schema[key].optional) {
        continue;
      }
      return { ok: false, reason: 'missing-field', field: fieldPath };
    }
    if (descriptor.get !== undefined || descriptor.set !== undefined || !descriptor.enumerable) {
      return { ok: false, reason: 'not-data-property', field: fieldPath };
    }
    const valueRead = readValue(descriptor.value, schema[key], depth, fieldPath, state);
    if (!valueRead.ok) {
      return valueRead;
    }
    out[key] = valueRead.value;
  }
  Object.freeze(out);
  return { ok: true, value: out };
}

type ValueRead =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: PlainRecordFailureReason; readonly field: string | null };

function readValue(
  value: unknown,
  schema: PlainFieldSchema,
  depth: number,
  path: string,
  state: ReadState,
): ValueRead {
  switch (schema.kind) {
    case 'string':
      if (typeof value !== 'string') {
        return { ok: false, reason: 'wrong-type', field: path };
      }
      if (value.length > schema.maxLength) {
        return { ok: false, reason: 'too-long', field: path };
      }
      return { ok: true, value };
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        return { ok: false, reason: 'wrong-type', field: path };
      }
      if (schema.min !== undefined && value < schema.min) {
        return { ok: false, reason: 'out-of-range', field: path };
      }
      if (schema.max !== undefined && value > schema.max) {
        return { ok: false, reason: 'out-of-range', field: path };
      }
      return { ok: true, value };
    case 'boolean':
      if (typeof value !== 'boolean') {
        return { ok: false, reason: 'wrong-type', field: path };
      }
      return { ok: true, value };
    case 'literal':
      if (typeof value !== 'string' || !schema.values.includes(value)) {
        return { ok: false, reason: 'not-a-literal', field: path };
      }
      return { ok: true, value };
    case 'record':
      if (depth + 1 > MAX_DEPTH) {
        return { ok: false, reason: 'too-deep', field: path };
      }
      return readSnap(value, schema.schema, depth + 1, path, state);
    case 'array': {
      if (!Array.isArray(value)) {
        return { ok: false, reason: 'wrong-type', field: path };
      }
      if (value.length > schema.maxLength) {
        return { ok: false, reason: 'too-many-items', field: path };
      }
      if (!isValidFieldSchema(schema.items)) {
        return INVALID_SCHEMA;
      }
      const items: unknown[] = new Array(value.length);
      for (let i = 0; i < value.length; i += 1) {
        const itemPath = `${path}[${i}]`;
        state.inFlight = itemPath;
        if (!Object.hasOwn(value, i)) {
          return { ok: false, reason: 'sparse-array', field: itemPath };
        }
        const itemRead = readValue(value[i], schema.items, depth, itemPath, state);
        if (!itemRead.ok) {
          return itemRead;
        }
        items[i] = itemRead.value;
      }
      Object.freeze(items);
      return { ok: true, value: items };
    }
    default:
      return INVALID_SCHEMA;
  }
}

/** Whether a runtime field schema is well-formed enough to trust its bounds. */
function isValidFieldSchema(field: unknown): boolean {
  if (typeof field !== 'object' || field === null) {
    return false;
  }
  const candidate = field as {
    readonly kind?: unknown;
    readonly maxLength?: unknown;
    readonly min?: unknown;
    readonly max?: unknown;
    readonly values?: unknown;
  };
  switch (candidate.kind) {
    case 'string':
      return typeof candidate.maxLength === 'number' && candidate.maxLength >= 0;
    case 'integer':
      return (candidate.min === undefined || (typeof candidate.min === 'number' && candidate.min >= 0))
        && (candidate.max === undefined || (typeof candidate.max === 'number' && candidate.max >= 0));
    case 'boolean':
      return true;
    case 'literal':
      return Array.isArray(candidate.values) && candidate.values.every((entry) => typeof entry === 'string');
    case 'record':
      return true;
    case 'array':
      return typeof candidate.maxLength === 'number' && candidate.maxLength >= 0;
    default:
      return false;
  }
}
