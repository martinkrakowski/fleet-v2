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
 * with a typed refusal, never a throw and never a pass. The record is
 * copied once through the shared snapshot and only the copy is validated.
 */

import type { IsProxy } from "@fleet/shared";

import {
  compareZonedIsoInstants,
  hasControlCharacter,
  isZonedIsoDateTime,
  ORGANIZATION_ID_PATTERN,
  snapshotRecord,
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
const TENANT_DATA_KEY_FIELD_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "keyId",
  "organizationId",
  "wrappedKeyRef",
  "status",
  "createdAtIso",
  "retiredAtIso",
]);

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

export type ParseTenantDataKeyRecordResult =
  | { readonly ok: true; readonly record: TenantDataKeyRecord }
  | { readonly ok: false; readonly reason: string };

/**
 * Validate unknown input as a TenantDataKeyRecord; a refused value never
 * throws. The organisation id is required and never defaulted to
 * `DEFAULT_ORGANIZATION_ID`: an absent, null, undefined, empty or invalid
 * organisation id is a refusal.
 *
 * The input is read ONCE, by `snapshotRecord` (the shared bounded snapshot): no
 * getter and no Proxy `get` trap ever runs and no value can change between
 * check and use; every check below runs on the frozen snapshot. Extra,
 * symbol-keyed and prototype-polluting own keys are refused with a reason
 * that never echoes a value (an unknown key's name is not echoed either).
 *
 * Cost bound: the snapshot's own-key enumeration is the
 * minimum any correct extra-key refusal must do (O(own keys)); apart from
 * it the parse is O(1) — every per-field check runs over a length-capped
 * string.
 */
export function parseTenantDataKeyRecord(
  input: unknown,
  isProxy?: IsProxy,
): ParseTenantDataKeyRecordResult {
  const read = snapshotRecord("tenant data key", input, isProxy, TENANT_DATA_KEY_FIELD_KEYS);
  if (!read.ok) {
    return keyRefused(read.reason);
  }
  const fields = read.value;
  const schemaVersionPresent = Object.hasOwn(fields, "schemaVersion");
  const keyId = fields.keyId;
  const organizationId = fields.organizationId;
  const wrappedKeyRef = fields.wrappedKeyRef;
  const status = fields.status;
  const createdAtIso = fields.createdAtIso;
  const retiredAtIso = fields.retiredAtIso;
  if (schemaVersionPresent && fields.schemaVersion !== 1) {
    return keyRefused("tenant data key record schemaVersion must be 1 when present");
  }
  if (typeof keyId !== "string") {
    return keyRefused("tenant data key record keyId must be a string");
  }
  if (keyId.length > MAX_KEY_ID_LENGTH || !KEY_ID_PATTERN.test(keyId)) {
    return keyRefused("tenant data key record keyId must match the key id pattern");
  }
  if (typeof organizationId !== "string" || organizationId.length === 0
    || organizationId.length > MAX_ORGANIZATION_ID_LENGTH
    || !ORGANIZATION_ID_PATTERN.test(organizationId)) {
    return keyRefused("tenant data key record organizationId must match the organization id pattern");
  }
  if (typeof wrappedKeyRef !== "string") {
    return keyRefused("tenant data key record wrappedKeyRef must be a string");
  }
  if (wrappedKeyRef.length < 1 || wrappedKeyRef.length > MAX_WRAPPED_KEY_REF_LENGTH) {
    return keyRefused("tenant data key record wrappedKeyRef must be 1 to 256 characters");
  }
  if (hasControlCharacter(wrappedKeyRef)) {
    return keyRefused("tenant data key record wrappedKeyRef must not contain control characters");
  }
  if (status !== "active" && status !== "rotated" && status !== "destroyed") {
    return keyRefused("tenant data key record status must be active, rotated or destroyed");
  }
  if (typeof createdAtIso !== "string" || createdAtIso.length > MAX_ISO_TIMESTAMP_LENGTH
    || !isZonedIsoDateTime(createdAtIso)) {
    return keyRefused("tenant data key record createdAtIso must be a zoned ISO-8601 timestamp");
  }
  if (retiredAtIso === null) {
    if (status !== "active") {
      return keyRefused("tenant data key record retiredAtIso must be set when status is not active");
    }
  } else {
    if (typeof retiredAtIso !== "string" || retiredAtIso.length > MAX_ISO_TIMESTAMP_LENGTH
      || !isZonedIsoDateTime(retiredAtIso)) {
      return keyRefused("tenant data key record retiredAtIso must be null or a zoned ISO-8601 timestamp");
    }
    if (status === "active") {
      return keyRefused("tenant data key record retiredAtIso must be null when status is active");
    }
    if (compareZonedIsoInstants(retiredAtIso, createdAtIso) < 0) {
      return keyRefused("tenant data key record retiredAtIso must not precede createdAtIso");
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
    keyId,
    organizationId,
    wrappedKeyRef,
    status,
    createdAtIso,
    retiredAtIso: retiredAtIso as string | null,
  };
  if (schemaVersionPresent) {
    parsed.schemaVersion = 1;
  }
  return { ok: true, record: Object.freeze(parsed) };
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
 * Cost bound: one parse pass — the snapshot's own-key enumeration is the
 * minimum any correct extra-key refusal needs, and every other step is a
 * fixed number of equality and pattern checks over bounded strings.
 */
export function decideKeyUse(
  record: unknown,
  kmsHealth: unknown,
  requestedOrganizationId: unknown,
  operation: unknown,
  isProxy?: IsProxy,
): KeyUseDecision {
  // The optional detector is passed through so infrastructure can refuse a
  // Proxy-wrapped record outright (the domain cannot import the runtime's
  // detector itself). Without it a Proxy is read once through its own data
  // descriptors, never through [[Get]]: a Proxy that lies consistently in
  // every trap is the accepted residual. No production caller exists yet
  // (this package is domain-only: no port, use case or adapter reads a
  // record), so the future KMS port adapter MUST pass `types.isProxy`.
  const parsed = parseTenantDataKeyRecord(record, isProxy);
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
