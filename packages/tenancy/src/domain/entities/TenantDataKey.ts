/**
 * TenantDataKey: the per-organisation data-key record for deployments that
 * wrap data under a KMS. Pure domain code: no Node, filesystem, subprocess,
 * network or vendor imports, and no key material ever lives here — a record
 * holds only an opaque reference to wrapped key material, never key bytes.
 *
 * Hostile-input posture: validators refuse null, undefined, non-objects,
 * arrays, array-likes, non-plain prototypes, getters/setters (never read),
 * Proxies (via the injected detector, never through reflection traps),
 * oversized strings, prototype-polluting own keys and extra own keys, each
 * with a typed refusal, never a throw and never a pass. The record's own
 * keys are enumerated once: a key count over the seven allowed fields is
 * refused before any iteration, and every remaining key must be one of the
 * declared fields, so a record can never carry undeclared data.
 */

import type { IsProxy } from "@fleet/shared";

import {
  hasControlCharacter,
  isZonedIsoDateTime,
  ORGANIZATION_ID_PATTERN,
} from "./record-guards.js";

/** KMS availability as seen by the caller; lives in the domain so the key-use decider never depends on an application port. */
export type KmsHealth = "healthy" | "degraded" | "down";

/** The two operations a data key can be used for. */
export type KeyUseOperation = "wrap" | "unwrap";

/** Why a key use was refused; never carries key or tenant detail. */
export type KeyUseRefusalReason =
  | "invalid-request"
  | "unavailable"
  | "key-not-accessible"
  | "key-not-active";

/** Lifecycle status of a data key. */
export type TenantDataKeyStatus = "active" | "rotated" | "destroyed";

export interface TenantDataKeyRecord {
  readonly schemaVersion?: 1;
  readonly keyId: string;
  readonly organizationId: string;
  /** Opaque reference to wrapped key material; never key bytes. */
  readonly wrappedKeyRef: string;
  readonly status: TenantDataKeyStatus;
  readonly createdAtIso: string;
  readonly retiredAtIso: string | null;
}

/** The only own keys a TenantDataKeyRecord may carry. */
const TENANT_DATA_KEY_FIELDS: readonly string[] = [
  "schemaVersion",
  "keyId",
  "organizationId",
  "wrappedKeyRef",
  "status",
  "createdAtIso",
  "retiredAtIso",
];

/** The same fields as a set, so an enumerated own key is checked in O(1). */
const TENANT_DATA_KEY_FIELD_KEYS: ReadonlySet<string> = new Set(
  TENANT_DATA_KEY_FIELDS,
);

/**
 * Prototype-polluting own keys. A record carrying any of these as an own
 * property is refused with a typed reason; each is checked by one named
 * descriptor lookup, never by enumerating the record's keys.
 */
const PROTOTYPE_POLLUTING_KEYS: readonly string[] = [
  "__proto__",
  "constructor",
  "prototype",
];

/** One data key id: lower-case alphanumerics and dashes, like an organization id. */
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

const MAX_KEY_ID_LENGTH = 63;
const MAX_WRAPPED_KEY_REF_LENGTH = 256;
/** The pattern allows at most 63 characters, so anything longer is refused before the regex runs. */
const MAX_ORGANIZATION_ID_LENGTH = 63;
/**
 * Longest zoned ISO-8601 timestamp the format allows:
 * `YYYY-MM-DDTHH:MM:SS.mmmmmmmmm±HH:MM` is 35 characters; anything longer is
 * refused before the pattern and calendar checks run, keeping the check O(1).
 */
const MAX_ISO_TIMESTAMP_LENGTH = 64;

/** Build a refused key-record result; never carries untrusted values. */
function keyRefused(reason: string): ParseTenantDataKeyRecordResult {
  return { ok: false, reason };
}

/**
 * One named field read through its own property descriptor: O(1) — a single
 * hash lookup. The value is returned without ever invoking an accessor; a
 * getter/setter or a non-enumerable own property is refused.
 */
function readDataField(
  input: object,
  key: string,
):
  | { readonly ok: true; readonly present: boolean; readonly value: unknown }
  | { readonly ok: false; readonly reason: string } {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (descriptor === undefined) {
    return { ok: true, present: false, value: undefined };
  }
  if (descriptor.get !== undefined || descriptor.set !== undefined) {
    return { ok: false, reason: `tenant data key record ${key} has a getter or setter property` };
  }
  if (!descriptor.enumerable) {
    return { ok: false, reason: `tenant data key record ${key} is a non-enumerable property` };
  }
  return { ok: true, present: true, value: descriptor.value };
}

export type ParseTenantDataKeyRecordResult =
  | { readonly ok: true; readonly record: TenantDataKeyRecord }
  | { readonly ok: false; readonly reason: string };

/**
 * Validate unknown input as a TenantDataKeyRecord; a refused value never
 * throws. The organisation id is required and never defaulted to
 * `DEFAULT_ORGANIZATION_ID`: an absent, null, undefined, empty or invalid
 * organisation id is a refusal.
 *
 * Extra own keys are refused: the record's own keys are enumerated once
 * with `Reflect.ownKeys` (so symbol-keyed extras are seen too), a key count
 * above the seven allowed fields is refused before any iteration, and every
 * remaining key must be one of the declared fields or the record is
 * refused — the unknown key's name and value are never echoed. This
 * enumeration is the minimum work any correct extra-key refusal must do;
 * apart from it the parse stays O(1): the seven fixed fields are each read
 * by name with one `Object.getOwnPropertyDescriptor` call, the three
 * prototype-polluting key names are each checked with one further named
 * descriptor lookup, and every per-field check runs over a length-capped
 * string, so no cost follows string content or a hostile value's size.
 */
export function parseTenantDataKeyRecord(
  input: unknown,
  isProxy?: IsProxy,
): ParseTenantDataKeyRecordResult {
  try {
    // The detector runs FIRST, before any reflection could observe a trap.
    if (typeof isProxy === "function") {
      let notProxy: boolean;
      try {
        notProxy = isProxy(input) === false;
      } catch {
        return keyRefused("tenant data key record is a hostile runtime value");
      }
      if (!notProxy) {
        return keyRefused("tenant data key record must be a plain object, not a Proxy");
      }
    }
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return keyRefused("tenant data key record must be a plain object");
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      return keyRefused("tenant data key record must be a plain object");
    }
    // Prototype-polluting own keys are refused outright, each by one named
    // descriptor lookup; the key's value is never read.
    for (const polluting of PROTOTYPE_POLLUTING_KEYS) {
      if (Object.getOwnPropertyDescriptor(input, polluting) !== undefined) {
        return keyRefused(`tenant data key record has the prototype-polluting key ${polluting}`);
      }
    }
    // Extra own keys are refused: the count is checked before iterating,
    // and every surviving key must be a declared field. Symbol-keyed own
    // properties are included, so an undeclared key cannot hide behind a
    // symbol. Key names and values are never echoed into the reason.
    const ownKeys = Reflect.ownKeys(input);
    if (ownKeys.length > TENANT_DATA_KEY_FIELDS.length) {
      return keyRefused("tenant data key record has too many own keys");
    }
    for (const ownKey of ownKeys) {
      if (typeof ownKey !== "string") {
        return keyRefused("tenant data key record has a symbol own key");
      }
      if (!TENANT_DATA_KEY_FIELD_KEYS.has(ownKey)) {
        return keyRefused("tenant data key record has an extra unknown key");
      }
    }
    // Read exactly the fixed fields, each by one named descriptor lookup.
    const fields = new Map<string, { readonly present: boolean; readonly value: unknown }>();
    for (const field of TENANT_DATA_KEY_FIELDS) {
      const read = readDataField(input, field);
      if (!read.ok) {
        return keyRefused(read.reason);
      }
      fields.set(field, { present: read.present, value: read.value });
    }
    const schemaVersion = fields.get("schemaVersion");
    const keyId = fields.get("keyId");
    const organizationId = fields.get("organizationId");
    const wrappedKeyRef = fields.get("wrappedKeyRef");
    const status = fields.get("status");
    const createdAtIso = fields.get("createdAtIso");
    const retiredAtIso = fields.get("retiredAtIso");
    if (schemaVersion !== undefined && schemaVersion.present && schemaVersion.value !== 1) {
      return keyRefused("tenant data key record schemaVersion must be 1 when present");
    }
    if (typeof keyId?.value !== "string") {
      return keyRefused("tenant data key record keyId must be a string");
    }
    const keyIdString: string = keyId.value;
    if (keyIdString.length > MAX_KEY_ID_LENGTH || !KEY_ID_PATTERN.test(keyIdString)) {
      return keyRefused("tenant data key record keyId must match the key id pattern");
    }
    if (typeof organizationId?.value !== "string" || organizationId.value.length === 0
      || organizationId.value.length > MAX_ORGANIZATION_ID_LENGTH
      || !ORGANIZATION_ID_PATTERN.test(organizationId.value)) {
      return keyRefused("tenant data key record organizationId must match the organization id pattern");
    }
    if (typeof wrappedKeyRef?.value !== "string") {
      return keyRefused("tenant data key record wrappedKeyRef must be a string");
    }
    const wrappedKeyRefString: string = wrappedKeyRef.value;
    if (wrappedKeyRefString.length < 1
      || wrappedKeyRefString.length > MAX_WRAPPED_KEY_REF_LENGTH) {
      return keyRefused("tenant data key record wrappedKeyRef must be 1 to 256 characters");
    }
    if (hasControlCharacter(wrappedKeyRefString)) {
      return keyRefused("tenant data key record wrappedKeyRef must not contain control characters");
    }
    if (status?.value !== "active" && status?.value !== "rotated" && status?.value !== "destroyed") {
      return keyRefused("tenant data key record status must be active, rotated or destroyed");
    }
    if (typeof createdAtIso?.value !== "string" || createdAtIso.value.length > MAX_ISO_TIMESTAMP_LENGTH
      || !isZonedIsoDateTime(createdAtIso.value)) {
      return keyRefused("tenant data key record createdAtIso must be a zoned ISO-8601 timestamp");
    }
    const statusValue = status.value as TenantDataKeyStatus;
    const retiredAtIsoValue = retiredAtIso?.value;
    if (retiredAtIsoValue === null) {
      if (statusValue !== "active") {
        return keyRefused("tenant data key record retiredAtIso must be set when status is not active");
      }
    } else {
      if (typeof retiredAtIsoValue !== "string" || retiredAtIsoValue.length > MAX_ISO_TIMESTAMP_LENGTH
        || !isZonedIsoDateTime(retiredAtIsoValue)) {
        return keyRefused("tenant data key record retiredAtIso must be null or a zoned ISO-8601 timestamp");
      }
      if (statusValue === "active") {
        return keyRefused("tenant data key record retiredAtIso must be null when status is active");
      }
    }
    const parsed: {
      schemaVersion?: 1;
      keyId: string;
      organizationId: string;
      wrappedKeyRef: string;
      status: TenantDataKeyStatus;
      createdAtIso: string;
      retiredAtIso: string | null;
    } = {
      keyId: keyIdString,
      organizationId: organizationId.value,
      wrappedKeyRef: wrappedKeyRefString,
      status: statusValue,
      createdAtIso: createdAtIso.value,
      retiredAtIso: retiredAtIsoValue as string | null,
    };
    if (schemaVersion !== undefined && schemaVersion.present && schemaVersion.value === 1) {
      parsed.schemaVersion = 1;
    }
    return { ok: true, record: Object.freeze(parsed) };
  } catch {
    // A revoked or trap-throwing Proxy may surface anywhere above; fail
    // closed rather than propagate the throw.
    return keyRefused("tenant data key record is a hostile runtime value");
  }
}

export type KeyUseDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: KeyUseRefusalReason };

/**
 * Decide whether a key use may proceed. Fail-closed: every malformed or
 * unknown input is refused, never thrown, and no untrusted value is ever
 * echoed into a reason. Reason precedence is strict:
 *
 * 1. `invalid-request` — the record fails parsing, the requested
 *    organisation id fails the organisation id pattern, or the operation is
 *    not `wrap` or `unwrap`.
 * 2. `unavailable` — the KMS health is anything but `healthy`.
 * 3. `key-not-accessible` — the key belongs to another organisation
 *    (checked before status, so a foreign caller cannot distinguish active
 *    from rotated from destroyed keys of another organisation; the same
 *    single reason a missing key returns at the port layer, preventing a
 *    cross-tenant existence oracle).
 * 4. `key-not-active` — a destroyed key, or a rotated key for `wrap`
 *    (superseded keys never encrypt new data; they still unwrap existing
 *    wrapped data).
 *
 * Cost bound: one parse pass — the own-key enumeration is the minimum any
 * correct extra-key refusal needs, and every other step is a fixed number
 * of equality and pattern checks over bounded strings.
 */
export function decideKeyUse(
  record: unknown,
  kmsHealth: unknown,
  requestedOrganizationId: unknown,
  operation: unknown,
): KeyUseDecision {
  const parsed = (() => {
    try {
      return parseTenantDataKeyRecord(record);
    } catch {
      // A Proxy with throwing traps may surface anywhere in the snapshot;
      // fail closed rather than propagate the throw.
      return keyRefused("tenant data key record could not be parsed");
    }
  })();
  if (!parsed.ok) {
    return { allowed: false, reason: "invalid-request" };
  }
  if (typeof requestedOrganizationId !== "string"
    || !ORGANIZATION_ID_PATTERN.test(requestedOrganizationId)) {
    return { allowed: false, reason: "invalid-request" };
  }
  if (operation !== "wrap" && operation !== "unwrap") {
    return { allowed: false, reason: "invalid-request" };
  }
  if (kmsHealth !== "healthy") {
    return { allowed: false, reason: "unavailable" };
  }
  if (parsed.record.organizationId !== requestedOrganizationId) {
    return { allowed: false, reason: "key-not-accessible" };
  }
  if (parsed.record.status === "destroyed") {
    return { allowed: false, reason: "key-not-active" };
  }
  if (parsed.record.status === "rotated" && operation === "wrap") {
    return { allowed: false, reason: "key-not-active" };
  }
  return { allowed: true };
}
