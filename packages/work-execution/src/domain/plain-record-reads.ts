/**
 * Shared pure readers for the lane-run records (K1-1 LaneRun, K3-1 leases).
 * Values are read through their own property descriptors, so no getter ever
 * runs. The optional-key and data-snapshot helpers are shared by the
 * `schemaVersion` readers (Q5a).
 */

import { isPlainRecordObject } from './record-schema-version.js';

/** A plain object with exactly the given own enumerable string keys, values
 * read through their own property descriptors (so no getter ever runs).
 * Anything else — a non-object, a prototype outside Object.prototype/null, a
 * missing or extra or non-enumerable key, a symbol key — returns null.
 */
export function readExactPlainRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!isPlainRecordObject(value)) {
    return null;
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length) {
    return null;
  }
  const out: Record<string, unknown> = {};
  for (const key of ownKeys) {
    if (copyAllowedEnumerableKey(value, key, keys, out) === false) {
      return null;
    }
  }
  return out;
}

/** Copy `key` when it is an allowed enumerable string key; false when the key is disallowed. */
function copyAllowedEnumerableKey(
  value: Record<string, unknown>,
  key: string | symbol,
  allowed: readonly string[],
  out: Record<string, unknown>,
): boolean {
  if (typeof key !== 'string' || !allowed.includes(key)) {
    return false;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor?.enumerable) {
    return false;
  }
  out[key] = descriptor.value;
  return true;
}

/**
 * A plain object whose own enumerable string keys are all in `allowed`, with
 * every `required` key present. Extra keys and symbol keys return null. An
 * enumerable getter on an allowed key is not invoked: the key is present in
 * the snapshot and its copied value is `undefined` (the same descriptor
 * semantics as `readExactPlainRecord`).
 */
export function readPlainRecordWithOptionalKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): Record<string, unknown> | null {
  if (!isPlainRecordObject(value)) {
    return null;
  }
  const allowed = [...required, ...optional];
  const out: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (copyAllowedEnumerableKey(value, key, allowed, out) === false) {
      return null;
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(out, key)) {
      return null;
    }
  }
  return out;
}

/**
 * A fresh copy of `value` when it is a plain object whose own keys are all
 * enumerable string data properties (no getter, no setter, nothing
 * non-enumerable); null otherwise. Stricter than the optional-key reader: an
 * enumerable getter here returns null rather than a copied `undefined`.
 */
export function snapshotPlainDataRecord(value: unknown): Record<string, unknown> | null {
  if (!isPlainRecordObject(value)) {
    return null;
  }
  const out: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (copyEnumerableDataKey(value, key, out) === false) {
      return null;
    }
  }
  return out;
}

/** Copy `key` when it is an enumerable string data property; false otherwise. */
function copyEnumerableDataKey(value: Record<string, unknown>, key: string | symbol, out: Record<string, unknown>): boolean {
  if (typeof key !== 'string') {
    return false;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) {
    return false;
  }
  out[key] = descriptor.value;
  return true;
}

/**
 * True when the date and time fields of an ISO-8601 string name a real calendar instant.
 * Date.parse rolls an impossible date such as 02-31 over into the next month instead of
 * refusing it, so the fields are checked here.
 */
export function isCalendarDateTime(iso: string): boolean {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  const hour = Number(iso.slice(11, 13));
  const minute = Number(iso.slice(14, 16));
  const second = Number(iso.slice(17, 19));
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}
