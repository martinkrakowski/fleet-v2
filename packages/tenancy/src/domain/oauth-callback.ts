/**
 * Pure OAuth sign-in callback verification decider (FC-6.2). Pure domain
 * code: no Node, filesystem, subprocess, network or vendor imports; no
 * clock, no randomness, no cryptographic primitive — the caller supplies
 * `nowIso` and the stored pending-state record. The code exchange itself
 * happens elsewhere, through a port that is not part of this unit.
 *
 * Hostile-input rule (every public function): null, undefined, non-objects,
 * non-iterable primitives, arrays, array holes, array-likes, getters (never
 * read — refused by descriptor inside `snapshotPlainData`), Proxies (via the
 * injected detector), oversized strings and prototype-polluting own keys are
 * each refused with a typed result, never a throw and never a pass. The
 * untrusted object is read exactly once, through `snapshotPlainData` from
 * `@fleet/shared`, and its own keys are checked with `checkSnapshotKeys` in
 * O(own keys), one enumeration.
 *
 * Cost bounds:
 * - Snapshots are bounded (`maxDepth`, `maxKeys`, `maxNodes`), so each read
 *   inspects a fixed number of nodes: O(1) in the input's total shape.
 * - String length bounds are checked before regex/parsing: O(1).
 * - The digest comparison runs a fixed 64-iteration XOR loop: O(1)
 *   constant time.
 * - Every field, timestamp and lifetime check is O(1).
 *
 * A refusal never echoes the presented or stored digest, or the provider
 * error text.
 */

import { snapshotPlainData, type IsProxy } from "@fleet/shared";

import {
  checkSnapshotKeys,
  isZonedIsoDateTime,
  MAX_STRING_LENGTH,
  ORGANIZATION_ID_PATTERN,
} from "./entities/record-guards.js";

/** A pending OAuth state lives at most 10 minutes. */
export const OAUTH_PENDING_STATE_MAX_TTL_MS = 10 * 60 * 1000;

/** An OAuth state digest is exactly 64 lowercase hex characters. */
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

/** The only own keys a pending-state record may carry. */
const PENDING_KEYS: ReadonlySet<string> = new Set([
  "stateDigest",
  "organizationId",
  "issuedAtIso",
  "expiresAtIso",
  "consumed",
]);

/** The only own keys the callback decision input may carry. */
const INPUT_KEYS: ReadonlySet<string> = new Set([
  "pending",
  "callbackStateDigest",
  "providerError",
  "hasCode",
  "nowIso",
]);

const REQUIRED_INPUT_KEYS = ["callbackStateDigest", "providerError", "hasCode", "nowIso"] as const;

/** A detector that detects nothing, used when the caller supplies none. */
const NO_DETECTOR: IsProxy = () => false;

/**
 * Resolve the optional proxy detector: absent means no detection, a
 * supplied non-function is refused. A detector that throws is reported by
 * the snapshot as `detector-threw`. Cost bound: O(1).
 */
function resolveDetector(
  isProxy: IsProxy | undefined,
): { ok: true; detector: IsProxy } | { ok: false } {
  if (isProxy === undefined) {
    return { ok: true, detector: NO_DETECTOR };
  }
  if (typeof isProxy !== "function") {
    return { ok: false };
  }
  return { ok: true, detector: isProxy };
}

/** Exactly 64 lowercase hex characters, length-checked before the regex. O(1). */
function isValidStateDigest(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === OAUTH_STATE_DIGEST_LENGTH &&
    OAUTH_STATE_DIGEST_PATTERN.test(value)
  );
}

/** An organization id, length-checked before the regex. O(1). */
function isValidOrganizationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 63 &&
    ORGANIZATION_ID_PATTERN.test(value)
  );
}

/**
 * Validate the already-snapshotted pending-state fields and lifetime.
 * Every check is O(1): fixed-length checks before regexes, two bounded
 * timestamp parses, one subtraction.
 */
function pendingFieldsValid(record: Record<string, unknown>): boolean {
  if (!isValidStateDigest(record.stateDigest)) {
    return false;
  }
  if (!isValidOrganizationId(record.organizationId)) {
    return false;
  }
  if (
    typeof record.issuedAtIso !== "string" ||
    record.issuedAtIso.length > MAX_ISO_LENGTH ||
    !isZonedIsoDateTime(record.issuedAtIso)
  ) {
    return false;
  }
  if (
    typeof record.expiresAtIso !== "string" ||
    record.expiresAtIso.length > MAX_ISO_LENGTH ||
    !isZonedIsoDateTime(record.expiresAtIso)
  ) {
    return false;
  }
  if (typeof record.consumed !== "boolean") {
    return false;
  }
  const issuedMs = Date.parse(record.issuedAtIso);
  const expiresMs = Date.parse(record.expiresAtIso);
  const lifetime = expiresMs - issuedMs;
  return lifetime > 0 && lifetime <= OAUTH_PENDING_STATE_MAX_TTL_MS;
}

type PendingSnapshot =
  | { readonly ok: true; readonly value: OAuthPendingStateRecord }
  | { readonly ok: false };

/**
 * Snapshot an unknown value as a plain pending-state record: read exactly
 * once through `snapshotPlainData` (depth 1, at most 6 keys, no arrays,
 * at most 8 nodes, strings capped at `MAX_STRING_LENGTH`), then
 * `checkSnapshotKeys` requires the exact own key set in O(own keys), one
 * enumeration, refusing missing, extra, symbol and prototype-polluting
 * keys. Any refusal is one typed outcome; no value is ever echoed.
 * Cost bound: O(1) — a bounded snapshot plus one bounded key pass.
 */
function snapshotPendingState(value: unknown, detector: IsProxy): PendingSnapshot {
  const snap = snapshotPlainData(value, detector, {
    maxDepth: 1,
    maxKeys: 6,
    maxArrayLength: 0,
    maxNodes: 8,
    maxStringLength: MAX_STRING_LENGTH,
  });
  if (!snap.ok) {
    return { ok: false };
  }
  const read = snap.value;
  if (typeof read !== "object" || read === null || Array.isArray(read)) {
    return { ok: false };
  }
  const record = read as Record<string, unknown>;
  if (checkSnapshotKeys(record, PENDING_KEYS) !== null) {
    return { ok: false };
  }
  if (!pendingFieldsValid(record)) {
    return { ok: false };
  }
  return {
    ok: true,
    value: {
      stateDigest: record.stateDigest as string,
      organizationId: record.organizationId as string,
      issuedAtIso: record.issuedAtIso as string,
      expiresAtIso: record.expiresAtIso as string,
      consumed: record.consumed as boolean,
    },
  };
}

/**
 * Parse and validate a stored pending-state record. Hostile or invalid
 * input — including a non-function or throwing `isProxy` detector — is a
 * typed refusal that echoes nothing. Cost bound: O(1).
 */
export function parseOAuthPendingState(
  raw: unknown,
  isProxy?: IsProxy,
): OAuthPendingStateParseResult {
  const resolved = resolveDetector(isProxy);
  if (!resolved.ok) {
    return { ok: false, reason: "invalid-pending" };
  }
  const snapshot = snapshotPendingState(raw, resolved.detector);
  if (!snapshot.ok) {
    return { ok: false, reason: "invalid-pending" };
  }
  return { ok: true, value: snapshot.value };
}

/**
 * Map a `snapshotPlainData` refusal path of the outer callback input to a
 * decision reason: any refusal at or inside `pending` is `invalid-pending`,
 * every other refusal (root, outer fields) is `invalid-input`. The path is
 * one of the fixed key names, so naming it is safe; no value is echoed.
 */
function mapSnapshotPath(path: string | null): OAuthCallbackRefusalReason {
  if (path !== null && (path === "pending" || path.startsWith("pending."))) {
    return "invalid-pending";
  }
  return "invalid-input";
}

/**
 * Decide one OAuth callback in a fixed order:
 *
 * 1. `invalid-input` — snapshot the outer input once and validate `nowIso`,
 *    `callbackStateDigest`, `providerError` and `hasCode`;
 * 2. `invalid-pending` — validate the nested pending-state record;
 * 3. `already-consumed` — a consumed state is refused before expiry or
 *    digest checks, so it never reveals whether the digest matched;
 * 4. `expired` — outside `[issuedAtIso, expiresAtIso)`;
 * 5. `state-mismatch` — a fixed 64-iteration XOR comparison;
 * 6. `provider-denied` — the provider error text is never echoed;
 * 7. `missing-code` — no authorization code accompanied the callback;
 * 8. otherwise the callback is accepted for the pending state's organization.
 *
 * Cost bound: O(1) throughout — bounded snapshots, fixed field checks, one
 * fixed 64-iteration loop.
 */
export function decideOAuthCallback(input: unknown, isProxy?: IsProxy): OAuthCallbackDecision {
  const resolved = resolveDetector(isProxy);
  if (!resolved.ok) {
    return { outcome: "refused", reason: "invalid-input" };
  }
  const snap = snapshotPlainData(input, resolved.detector, {
    maxDepth: 2,
    maxKeys: 6,
    maxArrayLength: 0,
    maxNodes: 16,
    maxStringLength: MAX_STRING_LENGTH,
  });
  if (!snap.ok) {
    return { outcome: "refused", reason: mapSnapshotPath(snap.path) };
  }
  const read = snap.value;
  if (typeof read !== "object" || read === null || Array.isArray(read)) {
    return { outcome: "refused", reason: "invalid-input" };
  }
  const record = read as Record<string, unknown>;
  // Exact own keys on the outer input: one enumeration, O(own keys).
  if (checkSnapshotKeys(record, INPUT_KEYS) !== null) {
    return { outcome: "refused", reason: "invalid-input" };
  }
  if (!Object.hasOwn(record, "pending")) {
    return { outcome: "refused", reason: "invalid-pending" };
  }
  for (const key of REQUIRED_INPUT_KEYS) {
    if (!Object.hasOwn(record, key)) {
      return { outcome: "refused", reason: "invalid-input" };
    }
  }

  // 1. Outer input fields, each O(1), length-checked before any regex.
  const nowIso = record.nowIso;
  if (typeof nowIso !== "string" || nowIso.length > MAX_ISO_LENGTH || !isZonedIsoDateTime(nowIso)) {
    return { outcome: "refused", reason: "invalid-input" };
  }
  if (!isValidStateDigest(record.callbackStateDigest)) {
    return { outcome: "refused", reason: "invalid-input" };
  }
  const providerError = record.providerError;
  if (
    providerError !== null &&
    typeof providerError !== "boolean" &&
    (typeof providerError !== "string" || providerError.length > MAX_STRING_LENGTH)
  ) {
    return { outcome: "refused", reason: "invalid-input" };
  }
  if (typeof record.hasCode !== "boolean") {
    return { outcome: "refused", reason: "invalid-input" };
  }

  // 2. The nested pending-state record (an already-frozen snapshot copy).
  const pending = snapshotPendingState(record.pending, resolved.detector);
  if (!pending.ok) {
    return { outcome: "refused", reason: "invalid-pending" };
  }

  // 3. A consumed state never reveals whether the digest matched.
  if (pending.value.consumed) {
    return { outcome: "refused", reason: "already-consumed" };
  }

  // 4. The callback must arrive inside [issuedAtIso, expiresAtIso).
  const nowMs = Date.parse(nowIso);
  const issuedMs = Date.parse(pending.value.issuedAtIso);
  const expiresMs = Date.parse(pending.value.expiresAtIso);
  if (nowMs < issuedMs || nowMs >= expiresMs) {
    return { outcome: "refused", reason: "expired" };
  }

  // 5. Fixed 64-iteration XOR loop: O(1) constant time, no early exit.
  const presented = record.callbackStateDigest as string;
  const stored = pending.value.stateDigest;
  let diff = 0;
  for (let i = 0; i < OAUTH_STATE_DIGEST_LENGTH; i += 1) {
    diff |= presented.charCodeAt(i) ^ stored.charCodeAt(i);
  }
  if (diff !== 0) {
    return { outcome: "refused", reason: "state-mismatch" };
  }

  // 6. A provider error refuses without ever echoing its text.
  if (providerError === true || (typeof providerError === "string" && providerError.length > 0)) {
    return { outcome: "refused", reason: "provider-denied" };
  }

  // 7. The authorization code must be present.
  if (record.hasCode !== true) {
    return { outcome: "refused", reason: "missing-code" };
  }

  // 8. Accepted for the pending state's organization.
  return { outcome: "accepted", organizationId: pending.value.organizationId };
}
