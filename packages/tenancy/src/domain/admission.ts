/**
 * Pure outside-organisation admission decision (FC3C). Given an organisation
 * id and an admission gate record, decide whether work from outside the
 * default organisation is admitted. Pure domain code: no Node, filesystem,
 * subprocess, network or vendor imports, no clock reads, no port calls —
 * the gate arrives as data and the decision is a pure result.
 *
 * Hostile-input posture: the organisation id and the gate are untrusted.
 * Null, undefined, wrong primitives, arrays, array-likes, non-plain
 * prototypes, getters/setters (never invoked), hostile Proxies (trap throws
 * or inconsistent reports), wrong key sets, non-enumerable keys, symbol
 * keys, oversized strings and prototype-polluting keys are each refused
 * with a typed reason, never a throw and never a pass. A Proxy that lies
 * consistently in every trap is an accepted residual.
 */

import {
  DEFAULT_ORGANIZATION_ID,
  ORGANIZATION_ID_PATTERN,
  isZonedIsoDateTime,
} from "./entities/index.js";

/** The admission gate record as it is decided on: three plain data fields. */
export interface AdmissionGateRecord {
  /** `closed` refuses outside work; `open` admits it (for a valid organisation). */
  readonly state: "closed" | "open";
  /** Who recorded the gate state; a non-empty, bounded, trimmed string. */
  readonly recordedBy: string;
  /** When the gate state was recorded; a zoned, calendar-valid ISO-8601 timestamp. */
  readonly recordedAtIso: string;
}

/**
 * The admission decision. Either admitted, or refused with a stable reason:
 * `invalid-organization-id`, `invalid-gate`, `gate-closed`,
 * `invalid-gate-state`, `invalid-recorded-by` or `invalid-recorded-at`.
 */
export type AdmissionDecision =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly reason: string };

/** The only own keys an AdmissionGateRecord may carry, in canonical order. */
const GATE_KEYS: readonly string[] = ["state", "recordedBy", "recordedAtIso"];

/** Longest accepted `recordedBy` value. */
const MAX_RECORDED_BY_LENGTH = 256;

/**
 * Decide outside-organisation admission. Pure.
 *
 * Cost bound: O(N) in the number of the gate's own keys, for exactly one
 * super-constant step — the `Reflect.ownKeys` enumeration, which must walk
 * every own key and allocate one array of length N before an oversized key
 * set can be refused. That enumeration is irreducible: extra, symbol,
 * non-enumerable and prototype-polluting own keys are visible only through
 * it, and no fixed set of descriptor probes can detect them, so the exact
 * key-set check cannot be made O(1) on an arbitrary object. The function
 * performs no allocation of its own beyond that one intrinsic array:
 * duplicate keys are caught without a set (with `length === 3` and every
 * key a canonical member, a duplicate would leave a canonical key absent,
 * and that key's descriptor probe refuses), and the three field values are
 * held in locals, so auxiliary memory is the single intrinsic `ownKeys`
 * array and nothing else. Everything after the enumeration is O(1): a
 * fixed 3-key descriptor pass, three bounded field checks and one
 * id-pattern test.
 *
 * The default organisation is always admitted, even against a closed
 * gate: this decision is about outside tenants, and the retired default
 * organisation's `acceptsNewWork` state is not decided here.
 */
export function decideOutsideTenantAdmission(
  organizationId: unknown,
  gate: unknown,
): AdmissionDecision {
  if (
    typeof organizationId !== "string" ||
    organizationId.length === 0 ||
    organizationId.length > 64 ||
    !ORGANIZATION_ID_PATTERN.test(organizationId)
  ) {
    return { admitted: false, reason: "invalid-organization-id" };
  }
  if (organizationId === DEFAULT_ORGANIZATION_ID) {
    return { admitted: true };
  }
  const gateObject = gate as object;
  // Every intrinsic reflection on `gate` is wrapped: a revoked Proxy makes
  // even `Array.isArray` throw, and a Proxy can arm a throwing
  // `getPrototypeOf` trap. Any escape here refuses as `invalid-gate`.
  let prototype: object | null;
  let isArray: boolean;
  try {
    isArray = Array.isArray(gateObject);
    prototype = Object.getPrototypeOf(gateObject);
  } catch {
    return { admitted: false, reason: "invalid-gate" };
  }
  if (isArray || prototype !== Object.prototype && prototype !== null) {
    return { admitted: false, reason: "invalid-gate" };
  }
  let ownKeys: readonly PropertyKey[];
  try {
    ownKeys = Reflect.ownKeys(gateObject);
  } catch {
    return { admitted: false, reason: "invalid-gate" };
  }
  // The key set must be exactly the three canonical keys: length, string
  // type, pollution and membership are all checked, so a Proxy reporting
  // three unrelated keys while fabricating descriptors is refused. With
  // `length === 3` and every key a canonical member, a duplicated key would
  // leave a canonical key absent and that key's descriptor probe below
  // refuses, so no set is needed to catch duplicates.
  if (ownKeys.length !== GATE_KEYS.length) {
    return { admitted: false, reason: "invalid-gate" };
  }
  for (const key of ownKeys) {
    if (typeof key !== "string") {
      return { admitted: false, reason: "invalid-gate" };
    }
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      return { admitted: false, reason: "invalid-gate" };
    }
    if (!GATE_KEYS.includes(key)) {
      return { admitted: false, reason: "invalid-gate" };
    }
  }
  let state: unknown;
  let recordedBy: unknown;
  let recordedAtIso: unknown;
  for (const key of GATE_KEYS) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(gateObject, key);
    } catch {
      return { admitted: false, reason: "invalid-gate" };
    }
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      return { admitted: false, reason: "invalid-gate" };
    }
    if (key === "state") {
      state = descriptor.value;
    } else if (key === "recordedBy") {
      recordedBy = descriptor.value;
    } else {
      recordedAtIso = descriptor.value;
    }
  }
  if (state === "closed") {
    return { admitted: false, reason: "gate-closed" };
  }
  if (state !== "open") {
    return { admitted: false, reason: "invalid-gate-state" };
  }
  if (typeof recordedBy !== "string" || recordedBy.length > MAX_RECORDED_BY_LENGTH) {
    return { admitted: false, reason: "invalid-recorded-by" };
  }
  if (recordedBy.trim().length === 0) {
    return { admitted: false, reason: "invalid-recorded-by" };
  }
  if (!isZonedIsoDateTime(recordedAtIso)) {
    return { admitted: false, reason: "invalid-recorded-at" };
  }
  return { admitted: true };
}
