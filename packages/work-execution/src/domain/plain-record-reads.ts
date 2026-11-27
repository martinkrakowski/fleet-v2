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
  // Reflect.ownKeys is the one unavoidable enumeration (no API counts keys
  // without listing them): it runs exactly once per object and the count is
  // checked immediately, before any descriptor or value read — that immediate
  // count refusal is the accepted bound on hostile objects with many keys.
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
  if (typeof key !== 'string' || key === '__proto__' || !allowed.includes(key)) {
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
 * enumerable getter here returns null rather than a copied `undefined` —
 * including a degenerate accessor whose accessors are both `undefined`
 * (no `value` field), which the accessor checks alone would miss.
 */
export function snapshotPlainDataRecord(value: unknown): Record<string, unknown> | null {
  if (!isPlainRecordObject(value)) {
    return null;
  }
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (copyEnumerableDataKey(value, key, out) === false) {
      return null;
    }
  }
  return out;
}

/** Copy `key` when it is an enumerable string data property; false otherwise. */
function copyEnumerableDataKey(value: Record<string, unknown>, key: string | symbol, out: Record<string, unknown>): boolean {
  // An own `__proto__` key would set the copy's prototype on assignment, so it is refused.
  if (typeof key !== 'string' || key === '__proto__') {
    return false;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    !descriptor ||
    !descriptor.enumerable ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    // An accessor whose accessors are both `undefined` (for example
    // `defineProperty(value, key, { enumerable: true, get: undefined })`)
    // passes the two accessor checks above yet has no `value` field at all:
    // without this check it is copied as `descriptor.value` — the literal
    // `undefined`. An engine-built data descriptor always carries a `value`
    // field, so this refuses exactly that accessor class.
    // (`readBoundedDenseArray` applies the same check per index.)
    !('value' in descriptor)
  ) {
    return false;
  }
  out[key] = descriptor.value;
  return true;
}

/** A dense array of own enumerable data elements, with its true length. */
export interface BoundedDenseArray {
  readonly array: readonly unknown[];
  readonly length: number;
}

/**
 * Cost policy (decided, BL06a): ECMAScript `[[OwnPropertyKeys]]` has no
 * count-only primitive, so this helper applies an `O(1)` pre-gate on length
 * and prototype (invalid `cap`, non-array, wrong prototype, and every
 * forbidden `length` are refused before any key enumeration), then pays an
 * accepted engine-level `O(K)` bound in the target's own-property count `K`
 * for the single `Reflect.ownKeys` call needed to reject foreign named,
 * symbol and non-enumerable keys, followed by an `O(cap)` bound for the
 * per-index descriptor checks. There is no "linear in the capped input"
 * claim: the `O(K)` engine bound is the accepted cost of owning-keys
 * validation on every JavaScript engine.
 *
 * Returns the array's elements as a fresh dense copy when `value` is a
 * genuine `Array` (prototype exactly `Array.prototype`) whose own keys are
 * exactly the canonical dense indices `0..length-1` plus a plain data
 * `length`, with `length` a non-negative safe integer `<= cap`; null
 * otherwise. A missing, accessor, non-number, non-safe-integer, negative,
 * `>= 2**32 - 1`, or `> cap` length is refused in `O(1)` before any key
 * enumeration, so a revoked Proxy that throws there never reaches
 * `Reflect.ownKeys`. Holes, accessors, non-enumerable indices, symbol keys,
 * and extra named or non-canonical own keys (including `__proto__`,
 * `constructor`, `prototype`, `"01"`) return null without ever invoking a
 * getter or a Proxy `get` trap. Every failure, including a revoked Proxy
 * throwing anywhere along the path, returns null and never throws. Because
 * the copy is built only from the descriptor answers the target's own
 * reflection gives, a Proxy stand-in is either refused or yields exactly
 * the result the plain data its reflection reports would give: no `get`
 * trap is ever consulted, so a lying `get` trap cannot shorten the walk.
 */
export function readBoundedDenseArray(value: unknown, cap: number): BoundedDenseArray | null {
  if (!Number.isSafeInteger(cap) || cap < 0) {
    return null;
  }
  let isArray: boolean;
  let prototype: unknown;
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    isArray = Array.isArray(value);
    prototype = isArray ? Object.getPrototypeOf(value) : undefined;
    lengthDescriptor = isArray ? Object.getOwnPropertyDescriptor(value, 'length') : undefined;
  } catch {
    return null;
  }
  // O(1) gate: refuse everything a property descriptor can decide before any
  // key enumeration runs.
  if (
    !isArray ||
    prototype !== Array.prototype ||
    lengthDescriptor === undefined ||
    lengthDescriptor.get !== undefined ||
    lengthDescriptor.set !== undefined ||
    typeof lengthDescriptor.value !== 'number'
  ) {
    return null;
  }
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0 || length >= 2 ** 32 - 1 || length > cap) {
    return null;
  }
  let ownKeys: PropertyKey[];
  try {
    // Accepted O(K) engine bound: `[[OwnPropertyKeys]]` materializes all K
    // own keys; no count-only primitive exists on any engine.
    ownKeys = Reflect.ownKeys(value as object);
  } catch {
    return null;
  }
  if (ownKeys.length !== length + 1) {
    return null;
  }
  for (const key of ownKeys) {
    if (typeof key === 'symbol') {
      return null;
    }
    if (key === 'length') {
      continue;
    }
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= length || String(index) !== key) {
      return null;
    }
  }
  const out: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    // O(cap) traversal bound: one descriptor check per canonical index. The
    // descriptor call is wrapped because a hostile Proxy trap may throw; the
    // helper's contract is null rather than a propagated error.
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value as object, index);
    } catch {
      return null;
    }
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !('value' in descriptor)
    ) {
      return null;
    }
    // Use the descriptor already validated above: a Proxy could answer a
    // second descriptor request with an accessor or an altered value, so the
    // copy must come from the one this loop just proved to be a plain,
    // enumerable data property.
    out.push(descriptor.value);
  }
  return { array: out, length };
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
