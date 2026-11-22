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
 * enumerable getter here returns null rather than a copied `undefined`.
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
  if (!descriptor || !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) {
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
 * Proxy policy (BL06a fallback bound): every Proxy exotic object —
 * transparent, revoked, consistent-liar, descriptor-spoofing, or throwing —
 * is refused outright, before any reflection runs, by a `structuredClone`
 * probe on every array-shaped input, so no Proxy trap (`get`,
 * `getOwnPropertyDescriptor`, `ownKeys`, `getPrototypeOf`) ever fires and no
 * getter is read on the refusal path: the serializer refuses a Proxy at its
 * root, before it walks anything. `types.isProxy` from `node:util` would do
 * this in `O(1)`, but lint:arch refuses node builtins in the domain layer
 * and no pure-language test for a Proxy exists (the same bound
 * `BriefPackage.vo.ts` documents), so the probe is the simplest rule that
 * still refuses every stand-in. Its two accepted bounds are documented here
 * and asserted in the tests: the probe is `O(size)` on array-shaped input
 * rather than `O(1)`, and on input that is not a Proxy it walks cloneable
 * data, so a getter or accessor on the value or on an object stored in a
 * valid slot may be read once during the probe. Every refusal decision and
 * every returned element still comes solely from property descriptors — a
 * probe read never enters the copy — and uncloneable data values (functions,
 * cycles) are refused by the same probe.
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
 * `constructor`, `prototype`, `"01"`) return null; the walk itself never
 * invokes a getter — the pre-probe's single read of cloneable data is the
 * only path that may touch one (the documented bound above). Every failure,
 * including a revoked Proxy throwing anywhere along the path, returns null
 * and never throws.
 */
export function readBoundedDenseArray(value: unknown, cap: number): BoundedDenseArray | null {
  if (!Number.isSafeInteger(cap) || cap < 0) {
    return null;
  }
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    return null;
  }
  if (!isArray) {
    return null;
  }
  // Proxy pre-check (BL06a fallback bound, documented in the JSDoc above):
  // the probe refuses every Proxy exotic object before any reflection runs,
  // firing no trap and reading no getter on the refusal path. It is the
  // simplest rule available — lint:arch refuses the `node:util` builtin in
  // the domain layer (`types.isProxy`) and no pure-language test for a
  // Proxy exists — so, unlike `types.isProxy`, it walks cloneable data on
  // the accept path; its reads never enter the copy, which comes solely
  // from the descriptor walk below.
  try {
    structuredClone(value);
  } catch {
    return null;
  }
  let prototype: unknown;
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    prototype = Object.getPrototypeOf(value);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  } catch {
    return null;
  }
  // O(1) gate: refuse everything a property descriptor can decide before any
  // key enumeration runs.
  if (
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
