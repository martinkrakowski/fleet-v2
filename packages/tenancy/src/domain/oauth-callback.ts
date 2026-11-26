/**
 * Pure OAuth sign-in callback verification decider (plan item FC-6.2). Pure
 * domain code: no Node, filesystem, subprocess, network or vendor imports;
 * no clock, no randomness, no cryptographic primitive — the caller supplies
 * `nowIso` and both state digests, and the code exchange itself happens
 * elsewhere through a port that is not part of this unit.
 *
 * Hostile-input rule (every public function): null, undefined, non-objects,
 * arrays, sparse arrays, array-likes, getters (never read — the snapshot
 * refuses accessors by descriptor), Proxies (refused via the injected,
 * caller-supplied detector — an absent detector fails closed because pure
 * domain code cannot verify plainness by itself), oversized strings, symbol
 * keys and prototype-polluting own keys are each
 * refused with a typed result, never a throw and never a pass.
 *
 * Both `parseOAuthPendingState` and `decideOAuthCallback` read the untrusted
 * object exactly once through `snapshotPlainData` from `@fleet/shared` (plus
 * `checkSnapshotKeys` from `entities/record-guards.ts`), refusing extra or
 * unknown keys in O(own keys), one enumeration.
 *
 * Cost bounds: every field, timestamp and digest check is O(1) — length
 * checks before regex/parsing, and a fixed 64-iteration XOR loop for the
 * state-digest comparison.
 */

import { snapshotPlainData, type IsProxy } from "@fleet/shared";

import {
  MAX_STRING_LENGTH,
  ORGANIZATION_ID_PATTERN,
  checkSnapshotKeys,
  isZonedIsoDateTime,
} from "./entities/record-guards.js";

/** A pending OAuth state lives at most 10 minutes. */
export const OAUTH_PENDING_STATE_MAX_TTL_MS = 10 * 60 * 1000;

/** A state digest is exactly 64 lowercase hex characters. */
export const OAUTH_STATE_DIGEST_LENGTH = 64;
export const OAUTH_STATE_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** At most this many characters before any timestamp is regex-tested. */
const MAX_ISO_LENGTH = 64;

export type OAuthPendingStateRecord = {
  readonly stateDigest: string;
  readonly organizationId: string;
  readonly issuedAtIso: string;
  readonly expiresAtIso: string;
  readonly consumed: boolean;
};

export type OAuthCallbackRefusalReason =
  | "invalid-pending"
  | "state-mismatch"
  | "already-consumed"
  | "expired"
  | "provider-denied"
  | "missing-code"
  | "invalid-input";

export type OAuthPendingStateParseResult =
  | { readonly ok: true; readonly value: OAuthPendingStateRecord }
  | { readonly ok: false; readonly reason: "invalid-pending" };

export type OAuthCallbackDecision =
  | { readonly outcome: "accepted"; readonly organizationId: string }
  | { readonly outcome: "refused"; readonly reason: OAuthCallbackRefusalReason };

const PENDING_KEYS: ReadonlySet<string> = new Set([
  "stateDigest",
  "organizationId",
  "issuedAtIso",
  "expiresAtIso",
  "consumed",
]);

const INPUT_KEYS: ReadonlySet<string> = new Set([
  "pending",
  "callbackStateDigest",
  "providerError",
  "hasCode",
  "nowIso",
]);

/** The exact own keys a pending state record may carry, as an array. */
const PENDING_KEY_LIST = ["stateDigest", "organizationId", "issuedAtIso", "expiresAtIso", "consumed"] as const;

/** The exact own keys the callback decision input may carry, as an array. */
const INPUT_KEY_LIST = ["pending", "callbackStateDigest", "providerError", "hasCode", "nowIso"] as const;

/**
 * Exactly 64 lowercase hex characters, length-checked before the regex. O(1).
 */
function isValidStateDigest(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === OAUTH_STATE_DIGEST_LENGTH &&
    OAUTH_STATE_DIGEST_PATTERN.test(value)
  );
}

/** An organization id, length-checked before the regex. O(1). */
function isValidOrganizationId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 63 && ORGANIZATION_ID_PATTERN.test(value);
}

/** A zoned ISO-8601 timestamp, length-checked before the regex. O(1). */
function isValidIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_ISO_LENGTH && isZonedIsoDateTime(value);
}

/**
 * Resolve the proxy detector. Pure domain code cannot distinguish a plain
 * object from a faithful Proxy without a trusted, injected detector (in
 * production the `types.isProxy` predicate, adapted by infrastructure), so
 * there is no safe default: an absent or non-function detector fails closed
 * and no untrusted object is ever read without one. A detector that throws
 * is reported by the snapshot as a refusal. Cost bound: O(1).
 */
function resolveDetector(isProxy: unknown): { ok: true; detector: IsProxy } | { ok: false } {
  if (typeof isProxy !== "function") {
    return { ok: false };
  }
  return { ok: true, detector: isProxy as IsProxy };
}

/**
 * Validate the already-snapshotted pending record fields. Returns the typed
 * record, or null on any invalid field. Cost bound: O(1) — a fixed number of
 * length checks, regex tests over bounded strings, and one Date.parse pair.
 */
function validatePendingFields(
  record: Record<string, unknown>,
): OAuthPendingStateRecord | null {
  if (!isValidStateDigest(record.stateDigest)) {
    return null;
  }
  if (!isValidOrganizationId(record.organizationId)) {
    return null;
  }
  if (!isValidIsoTimestamp(record.issuedAtIso) || !isValidIsoTimestamp(record.expiresAtIso)) {
    return null;
  }
  if (typeof record.consumed !== "boolean") {
    return null;
  }
  const issuedMs = Date.parse(record.issuedAtIso);
  const expiresMs = Date.parse(record.expiresAtIso);
  const lifetime = expiresMs - issuedMs;
  if (!(lifetime > 0 && lifetime <= OAUTH_PENDING_STATE_MAX_TTL_MS)) {
    return null;
  }
  return {
    stateDigest: record.stateDigest,
    organizationId: record.organizationId,
    issuedAtIso: record.issuedAtIso,
    expiresAtIso: record.expiresAtIso,
    consumed: record.consumed,
  };
}

/**
 * Parse one stored pending-state record. The untrusted `raw` is read exactly
 * once through `snapshotPlainData` (depth 1, at most 6 keys, no arrays, at
 * most 8 nodes, strings capped at `MAX_STRING_LENGTH`), then its own keys
 * are checked against the exact five-key set — missing keys, extra keys,
 * symbol keys and prototype-polluting keys are each refused. Every field is
 * validated afterwards in O(1). An absent, non-function or throwing detector
 * is refused too (pure domain code has no safe default detector, so callers
 * must inject one — production passes an adapted `types.isProxy`); a refusal
 * never echoes any input value.
 */
export function parseOAuthPendingState(
  raw: unknown,
  isProxy?: IsProxy,
): OAuthPendingStateParseResult {
  const detector = resolveDetector(isProxy);
  if (!detector.ok) {
    return { ok: false, reason: "invalid-pending" };
  }
  const snapshot = snapshotPlainData(raw, detector.detector, {
    maxDepth: 1,
    maxKeys: 6,
    maxArrayLength: 0,
    maxNodes: 8,
    maxStringLength: MAX_STRING_LENGTH,
  });
  if (!snapshot.ok) {
    return { ok: false, reason: "invalid-pending" };
  }
  const value = snapshot.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "invalid-pending" };
  }
  const record = value as Record<string, unknown>;
  if (checkSnapshotKeys(record, PENDING_KEYS) !== null) {
    return { ok: false, reason: "invalid-pending" };
  }
  for (const key of PENDING_KEY_LIST) {
    if (!Object.hasOwn(record, key)) {
      return { ok: false, reason: "invalid-pending" };
    }
  }
  const parsed = validatePendingFields(record);
  if (parsed === null) {
    return { ok: false, reason: "invalid-pending" };
  }
  return { ok: true, value: parsed };
}

/**
 * Whether a snapshot refusal path (or a missing key name) belongs to the
 * nested `pending` object: the path is exactly `"pending"` or starts with
 * `"pending."`. O(1) — bounded string comparisons.
 */
function isPendingPath(path: string | null, key?: string): boolean {
  if (key === "pending") {
    return true;
  }
  if (path === null) {
    return false;
  }
  return path === "pending" || path.startsWith("pending.");
}

/**
 * Decide one OAuth callback in a fixed, documented order:
 *
 * 1. `invalid-input`: validate `nowIso`, `callbackStateDigest`,
 *    `providerError` (`null | boolean | string`; `undefined` is refused) and
 *    `hasCode` (`boolean`), plus the outer input shape and detector;
 * 2. `invalid-pending`: validate the snapshotted `pending` object with the
 *    same field and lifetime rules as `parseOAuthPendingState`;
 * 3. `already-consumed`: `pending.consumed === true` refuses before expiry
 *    or digest so a consumed state never reveals whether the digest matched;
 * 4. `expired`: outside `[issuedAtIso, expiresAtIso)`;
 * 5. `state-mismatch`: a fixed 64-iteration XOR comparison — O(1) constant
 *    time;
 * 6. `provider-denied`: `providerError === true` or a non-empty string
 *    (never echoed);
 * 7. `missing-code`: `hasCode !== true`;
 * 8. otherwise the callback is accepted for `pending.organizationId`.
 *
 * No refusal ever echoes a rejected value, a digest, or the provider error
 * text.
 */
export function decideOAuthCallback(
  input: unknown,
  isProxy?: IsProxy,
): OAuthCallbackDecision {
  const detector = resolveDetector(isProxy);
  if (!detector.ok) {
    return { outcome: "refused", reason: "invalid-input" };
  }
  const snapshot = snapshotPlainData(input, detector.detector, {
    maxDepth: 2,
    maxKeys: 6,
    maxArrayLength: 0,
    maxNodes: 16,
    maxStringLength: MAX_STRING_LENGTH,
  });
  if (!snapshot.ok) {
    const reason: OAuthCallbackRefusalReason = isPendingPath(snapshot.path)
      ? "invalid-pending"
      : "invalid-input";
    return { outcome: "refused", reason };
  }
  const outer = snapshot.value;
  if (typeof outer !== "object" || outer === null || Array.isArray(outer)) {
    return { outcome: "refused", reason: "invalid-input" };
  }
  const inputRecord = outer as Record<string, unknown>;
  const keyRefusal = checkSnapshotKeys(inputRecord, INPUT_KEYS);
  if (keyRefusal !== null) {
    return { outcome: "refused", reason: "invalid-input" };
  }
  for (const key of INPUT_KEY_LIST) {
    if (!Object.hasOwn(inputRecord, key)) {
      return {
        outcome: "refused",
        reason: key === "pending" ? "invalid-pending" : "invalid-input",
      };
    }
  }

  // 1. invalid-input: the outer scalar and string fields, in fixed order.
  if (!isValidIsoTimestamp(inputRecord.nowIso)) {
    return { outcome: "refused", reason: "invalid-input" };
  }
  if (!isValidStateDigest(inputRecord.callbackStateDigest)) {
    return { outcome: "refused", reason: "invalid-input" };
  }
  const providerError: unknown = inputRecord.providerError;
  if (
    !(
      providerError === null ||
      typeof providerError === "boolean" ||
      (typeof providerError === "string" && providerError.length <= MAX_STRING_LENGTH)
    )
  ) {
    return { outcome: "refused", reason: "invalid-input" };
  }
  if (typeof inputRecord.hasCode !== "boolean") {
    return { outcome: "refused", reason: "invalid-input" };
  }

  // 2. invalid-pending: the nested pending object, same rules as
  //    parseOAuthPendingState. The snapshot copy is frozen, so these reads
  //    touch no caller-controlled object.
  const pendingRaw = inputRecord.pending;
  if (typeof pendingRaw !== "object" || pendingRaw === null || Array.isArray(pendingRaw)) {
    return { outcome: "refused", reason: "invalid-pending" };
  }
  const pending = pendingRaw as Record<string, unknown>;
  if (checkSnapshotKeys(pending, PENDING_KEYS) !== null) {
    return { outcome: "refused", reason: "invalid-pending" };
  }
  for (const key of PENDING_KEY_LIST) {
    if (!Object.hasOwn(pending, key)) {
      return { outcome: "refused", reason: "invalid-pending" };
    }
  }
  const pendingState = validatePendingFields(pending);
  if (pendingState === null) {
    return { outcome: "refused", reason: "invalid-pending" };
  }

  // 3. already-consumed, before expiry or digest.
  if (pendingState.consumed) {
    return { outcome: "refused", reason: "already-consumed" };
  }

  // 4. expired: outside [issuedAtIso, expiresAtIso).
  const nowMs = Date.parse(inputRecord.nowIso);
  const issuedMs = Date.parse(pendingState.issuedAtIso);
  const expiresMs = Date.parse(pendingState.expiresAtIso);
  if (nowMs < issuedMs || nowMs >= expiresMs) {
    return { outcome: "refused", reason: "expired" };
  }

  // 5. state-mismatch: fixed 64-iteration XOR loop, O(1) constant time.
  const presented = inputRecord.callbackStateDigest;
  let diff = 0;
  for (let i = 0; i < OAUTH_STATE_DIGEST_LENGTH; i += 1) {
    diff |= presented.charCodeAt(i) ^ pendingState.stateDigest.charCodeAt(i);
  }
  if (diff !== 0) {
    return { outcome: "refused", reason: "state-mismatch" };
  }

  // 6. provider-denied (the error text is never echoed).
  if (providerError === true || (typeof providerError === "string" && providerError.length > 0)) {
    return { outcome: "refused", reason: "provider-denied" };
  }

  // 7. missing-code.
  if (inputRecord.hasCode !== true) {
    return { outcome: "refused", reason: "missing-code" };
  }

  // 8. accepted.
  return { outcome: "accepted", organizationId: pendingState.organizationId };
}
