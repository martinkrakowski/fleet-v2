/**
 * FC6C: pure org-bound API token record parser, use decider and rotation
 * decider. Pure domain code: no Node, filesystem, subprocess, network,
 * database or vendor imports; no clock (`Date.now`, `new Date()`), no
 * randomness, no cryptographic primitive — the caller supplies `nowIso`,
 * `newTokenId` and every secret digest.
 *
 * The seven-scope list mirrors `MINTABLE_SESSION_SCOPES` in
 * `apps/api/server/wiring/session-exchange.ts` plus `orchestrate`; the alias
 * exists here because `@fleet/tenancy` cannot import from `apps/api`.
 *
 * Hostile-input rule (every public function): every untrusted value is read
 * exactly once through `snapshotPlainData`, which refuses null-hostile
 * shapes, accessors (getters never run), Proxies (via the injected
 * detector), symbol keys, sparse arrays, cycles, oversized strings and
 * non-plain prototypes with a typed refusal. After the snapshot the root is
 * verified to be a non-null non-array object and its own keys are screened
 * via `Reflect.ownKeys` against the prototype-polluting names, `length` and
 * the exact allowed keys, because the snapshot copies an own `__proto__` key
 * as data. Every failure path returns a typed refusal result — never a
 * throw, never a pass — and no rejected value, digest or secret is ever
 * echoed into a refusal.
 *
 * Cost bounds (all O(1)):
 * - snapshots are bounded by `maxDepth <= 3`, `maxKeys <= 12`,
 *   `maxArrayLength <= 7`, `maxNodes <= 32`, `maxStringLength <= 4096`;
 * - key screening inspects at most 12 own keys against fixed sets;
 * - `scopes` validation checks at most 7 elements against a 7-element set;
 * - string length checks run before regex/ISO parsing;
 * - instant comparisons via `compareZonedIsoInstants` cost two `Date.parse`
 *   calls and fixed-width sub-millisecond digit slicing;
 * - digest comparison runs a fixed 64-iteration XOR loop (constant time).
 */

import { snapshotPlainData, type IsProxy } from "@fleet/shared";

import {
  compareZonedIsoInstants,
  isZonedIsoDateTime,
  MAX_STRING_LENGTH,
  ORGANIZATION_ID_PATTERN,
} from "./entities/record-guards.js";
import { HOSTED_SCOPES, type HostedScope } from "./role-scopes.js";
import { ACTOR_PATTERN, SECRET_DIGEST_LENGTH, SECRET_DIGEST_PATTERN } from "./sign-in-link.js";
import { FORBIDDEN_KEY_SET } from "./value-objects/Role.vo.js";

/** The seven hosted scopes an API token may grant (see the header note). */
export const API_TOKEN_SCOPES = HOSTED_SCOPES;

export type ApiTokenScope = HostedScope;

/** The only own keys an API token record may carry. */
export type ApiTokenRecord = {
  readonly tokenId: string;
  readonly organizationId: string;
  readonly actor: string;
  readonly scopes: readonly ApiTokenScope[];
  readonly secretDigest: string;
  readonly issuedAtIso: string;
  readonly expiresAtIso: string;
  readonly revokedAtIso: string | null;
  readonly registeredOrchestrator?: boolean;
};

export type ApiTokenRefusalReason =
  | "invalid-record"
  | "digest-mismatch"
  | "wrong-organization"
  | "revoked"
  | "expired"
  | "not-yet-valid"
  | "scope-not-granted"
  | "orchestrate-not-registered"
  | "invalid-input";

export type ApiTokenParseResult =
  | { readonly outcome: "parsed"; readonly record: ApiTokenRecord }
  | { readonly outcome: "refused"; readonly reason: "invalid-record" };

export type ApiTokenUseResult =
  | {
      readonly outcome: "allowed";
      readonly tokenId: string;
      readonly organizationId: string;
      readonly actor: string;
      readonly scopes: readonly ApiTokenScope[];
    }
  | { readonly outcome: "refused"; readonly reason: ApiTokenRefusalReason };

export type ApiTokenRotationResult =
  | {
      readonly outcome: "rotated";
      readonly revokedRecord: ApiTokenRecord;
      readonly successorPending: true;
      readonly newTokenId: string;
      readonly note: "successor-must-be-minted-separately";
    }
  | { readonly outcome: "refused"; readonly reason: ApiTokenRefusalReason };

const API_TOKEN_SCOPE_SET: ReadonlySet<string> = new Set<string>(API_TOKEN_SCOPES);

/** A detector that detects nothing, used when the caller supplies none. */
const NO_DETECTOR: IsProxy = () => false;

const RECORD_KEYS: readonly string[] = [
  "tokenId",
  "organizationId",
  "actor",
  "scopes",
  "secretDigest",
  "issuedAtIso",
  "expiresAtIso",
  "revokedAtIso",
  "registeredOrchestrator",
];
const REQUIRED_RECORD_KEYS: readonly string[] = RECORD_KEYS.slice(0, 8);

const USE_KEYS: readonly string[] = [
  "record",
  "presentedDigest",
  "organizationId",
  "requiredScope",
  "nowIso",
];
const ROTATION_KEYS: readonly string[] = ["record", "organizationId", "nowIso", "newTokenId"];

/** Key names refused wherever a key-shaped own key is screened. */
const FORBIDDEN_OWN_KEYS: ReadonlySet<string> = new Set<string>([
  ...FORBIDDEN_KEY_SET,
  "length",
]);

const RECORD_LIMITS = Object.freeze({
  maxDepth: 2,
  maxKeys: 12,
  maxArrayLength: 7,
  maxNodes: 32,
  maxStringLength: MAX_STRING_LENGTH,
});

const WRAPPER_LIMITS = Object.freeze({
  maxDepth: 3,
  maxKeys: 12,
  maxArrayLength: 7,
  maxNodes: 32,
  maxStringLength: MAX_STRING_LENGTH,
});

/**
 * Narrow a wrapper's `record` branch: `snapshotPlainData` accepts `null`,
 * primitives and arrays, so the branch is verified to be a non-null
 * non-array plain object before `buildRecord` screens its own keys.
 * Returns null otherwise. Cost bound: O(1).
 */
function wrapperRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** `parseApiTokenRecord`: any snapshot path is `invalid-record`. */
const INVALID_RECORD: ApiTokenParseResult = { outcome: "refused", reason: "invalid-record" };
const INVALID_INPUT: ApiTokenRefusalReason = "invalid-input";

/**
 * Map a snapshot refusal path from a use/rotation wrapper to a reason: the
 * `record` branch is `invalid-record`, everything else (root, wrapper
 * fields) is `invalid-input`. Cost bound: O(1).
 */
function wrapperReason(path: string | null): ApiTokenRefusalReason {
  if (path === "record" || (path !== null && path.startsWith("record."))) {
    return "invalid-record";
  }
  return INVALID_INPUT;
}

/**
 * Screen an already-snapshotted plain object's own keys: all strings, no
 * prototype-polluting names, no `length`, and every key in `allowed`. Cost
 * bound: O(1) — one pass over at most `maxKeys` (12) own keys.
 */
function screenOwnKeys(
  snap: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  const ownKeys = Reflect.ownKeys(snap);
  if (ownKeys.length > allowed.size) {
    return false;
  }
  for (const key of ownKeys) {
    if (typeof key !== "string") {
      return false;
    }
    if (FORBIDDEN_OWN_KEYS.has(key) || !allowed.has(key)) {
      return false;
    }
  }
  return true;
}

/** An actor-shaped id, length-checked before the regex. O(1). */
function isValidActorId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128
    && ACTOR_PATTERN.test(value);
}

/** Exactly 64 lowercase hex characters, length-checked before the regex. O(1). */
function isValidDigest(value: unknown): value is string {
  return (
    typeof value === "string"
    && value.length === SECRET_DIGEST_LENGTH
    && SECRET_DIGEST_PATTERN.test(value)
  );
}

/** A zoned ISO-8601 timestamp, length-checked before the regex. O(1). */
function isValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && isZonedIsoDateTime(value);
}

/**
 * Validate the `scopes` field of an already-snapshotted record: a dense
 * array of 1..7 members, every member a known scope, no duplicates. Cost
 * bound: O(1) — at most 7 elements against a 7-element set.
 */
function isValidScopeList(value: unknown): value is readonly ApiTokenScope[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > API_TOKEN_SCOPES.length) {
    return false;
  }
  const seen = new Set<string>();
  for (const scope of value) {
    if (typeof scope !== "string" || !API_TOKEN_SCOPE_SET.has(scope) || seen.has(scope)) {
      return false;
    }
    seen.add(scope);
  }
  return true;
}

/**
 * Validate the fields of an already-snapshotted record object and build the
 * typed record. Returns null on any malformed field. Cost bound: O(1) — a
 * fixed number of bounded field checks.
 */
function buildRecord(snap: Record<string, unknown>): ApiTokenRecord | null {
  if (!screenOwnKeys(snap, new Set<string>(RECORD_KEYS))) {
    return null;
  }
  for (const key of REQUIRED_RECORD_KEYS) {
    if (!Object.hasOwn(snap, key)) {
      return null;
    }
  }
  if (!isValidActorId(snap.tokenId) || !isValidActorId(snap.actor)) {
    return null;
  }
  if (typeof snap.organizationId !== "string" || !ORGANIZATION_ID_PATTERN.test(snap.organizationId)) {
    return null;
  }
  if (!isValidDigest(snap.secretDigest)) {
    return null;
  }
  if (!isValidScopeList(snap.scopes)) {
    return null;
  }
  if (!isValidTimestamp(snap.issuedAtIso) || !isValidTimestamp(snap.expiresAtIso)) {
    return null;
  }
  if (compareZonedIsoInstants(snap.expiresAtIso, snap.issuedAtIso) <= 0) {
    return null;
  }
  let revokedAtIso: string | null = null;
  if (snap.revokedAtIso !== null) {
    if (!isValidTimestamp(snap.revokedAtIso)) {
      return null;
    }
    if (compareZonedIsoInstants(snap.revokedAtIso, snap.issuedAtIso) < 0) {
      return null;
    }
    revokedAtIso = snap.revokedAtIso;
  }
  let registeredOrchestrator: boolean | undefined;
  if (Object.hasOwn(snap, "registeredOrchestrator")) {
    if (typeof snap.registeredOrchestrator !== "boolean") {
      return null;
    }
    registeredOrchestrator = snap.registeredOrchestrator;
  }
  return {
    tokenId: snap.tokenId,
    organizationId: snap.organizationId,
    actor: snap.actor,
    scopes: Object.freeze(snap.scopes.slice()) as readonly ApiTokenScope[],
    secretDigest: snap.secretDigest,
    issuedAtIso: snap.issuedAtIso,
    expiresAtIso: snap.expiresAtIso,
    revokedAtIso,
    ...(registeredOrchestrator === undefined ? {} : { registeredOrchestrator }),
  };
}

/**
 * Snapshot unknown input as a plain object (refusing every hostile shape)
 * and screen its own keys. Returns null on any refusal. Cost bound: O(1).
 */
function snapObject(
  value: unknown,
  isProxy: IsProxy,
  limits: { readonly maxDepth: number; readonly maxKeys: number; readonly maxArrayLength: number; readonly maxNodes: number; readonly maxStringLength: number },
): Record<string, unknown> | null {
  const snapshot = snapshotPlainData(value, isProxy, limits);
  if (!snapshot.ok) {
    return null;
  }
  const snap = snapshot.value;
  if (typeof snap !== "object" || snap === null || Array.isArray(snap)) {
    return null;
  }
  return snap as Record<string, unknown>;
}

/**
 * Parse one untrusted API token record. The record is read once through
 * `snapshotPlainData` (getters never run, Proxies refused via the injected
 * detector); every field is validated before a record is produced. Returns
 * `{ outcome: "refused", reason: "invalid-record" }` on every hostile or
 * malformed shape, never a throw, and never echoes the digest.
 */
export function parseApiTokenRecord(raw: unknown, isProxy?: IsProxy): ApiTokenParseResult {
  const snap = snapObject(raw, isProxy ?? NO_DETECTOR, RECORD_LIMITS);
  if (snap === null) {
    return INVALID_RECORD;
  }
  if (!screenOwnKeys(snap, new Set<string>(RECORD_KEYS))) {
    return INVALID_RECORD;
  }
  const record = buildRecord(snap);
  if (record === null) {
    return INVALID_RECORD;
  }
  return { outcome: "parsed", record };
}

/**
 * Constant-time digest comparison: a fixed 64-iteration XOR loop, so the
 * comparison cost never depends on how many leading characters match. O(1).
 */
function digestsMatch(presented: string, stored: string): boolean {
  let diff = 0;
  for (let i = 0; i < SECRET_DIGEST_LENGTH; i += 1) {
    diff |= presented.charCodeAt(i) ^ stored.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Decide whether an API token may be used for `requiredScope` in
 * `organizationId` at `nowIso`, in a fixed order:
 *
 * 1. snapshot and validate the wrapper (any failure is `invalid-input`,
 *    the `record` branch `invalid-record`);
 * 2. validate the record (`invalid-record`);
 * 3. constant-time digest comparison (`digest-mismatch`);
 * 4. organization binding (`wrong-organization`), revocation (`revoked`),
 *    the validity window via `compareZonedIsoInstants` (`not-yet-valid`,
 *    `expired`), the scope grant (`scope-not-granted`) and, for the
 *    `orchestrate` scope only, `registeredOrchestrator`
 *    (`orchestrate-not-registered`);
 * 5. otherwise the use is allowed — the success result never carries the
 *    stored digest.
 */
export function decideApiTokenUse(input: unknown, isProxy?: IsProxy): ApiTokenUseResult {
  const detector = isProxy ?? NO_DETECTOR;
  const wrapper = snapshotPlainData(input, detector, WRAPPER_LIMITS);
  if (!wrapper.ok) {
    return { outcome: "refused", reason: wrapperReason(wrapper.path) };
  }
  const snap = wrapper.value;
  if (typeof snap !== "object" || snap === null || Array.isArray(snap)) {
    return { outcome: "refused", reason: INVALID_INPUT };
  }
  const snapRecord = snap as Record<string, unknown>;
  if (!screenOwnKeys(snapRecord, new Set<string>(USE_KEYS))) {
    return { outcome: "refused", reason: INVALID_INPUT };
  }
  for (const key of USE_KEYS) {
    if (!Object.hasOwn(snapRecord, key)) {
      return { outcome: "refused", reason: INVALID_INPUT };
    }
  }
  if (!isValidDigest(snapRecord.presentedDigest)) {
    return { outcome: "refused", reason: INVALID_INPUT };
  }
  if (
    typeof snapRecord.organizationId !== "string"
    || !ORGANIZATION_ID_PATTERN.test(snapRecord.organizationId)
  ) {
    return { outcome: "refused", reason: INVALID_INPUT };
  }
  if (
    typeof snapRecord.requiredScope !== "string"
    || FORBIDDEN_OWN_KEYS.has(snapRecord.requiredScope)
    || !API_TOKEN_SCOPE_SET.has(snapRecord.requiredScope)
  ) {
    return { outcome: "refused", reason: INVALID_INPUT };
  }
  if (!isValidTimestamp(snapRecord.nowIso)) {
    return { outcome: "refused", reason: INVALID_INPUT };
  }
  const recordSnap = wrapperRecord(snapRecord.record);
  if (recordSnap === null) {
    return { outcome: "refused", reason: "invalid-record" };
  }
  const record = buildRecord(recordSnap);
  if (record === null) {
    return { outcome: "refused", reason: "invalid-record" };
  }
  if (!digestsMatch(snapRecord.presentedDigest, record.secretDigest)) {
    return { outcome: "refused", reason: "digest-mismatch" };
  }
  if (record.organizationId !== snapRecord.organizationId) {
    return { outcome: "refused", reason: "wrong-organization" };
  }
  if (record.revokedAtIso !== null) {
    return { outcome: "refused", reason: "revoked" };
  }
  if (compareZonedIsoInstants(snapRecord.nowIso, record.issuedAtIso) < 0) {
    return { outcome: "refused", reason: "not-yet-valid" };
  }
  if (compareZonedIsoInstants(snapRecord.nowIso, record.expiresAtIso) >= 0) {
    return { outcome: "refused", reason: "expired" };
  }
  const requiredScope = snapRecord.requiredScope as ApiTokenScope;
  if (!record.scopes.includes(requiredScope)) {
    return { outcome: "refused", reason: "scope-not-granted" };
  }
  if (requiredScope === "orchestrate" && record.registeredOrchestrator !== true) {
    return { outcome: "refused", reason: "orchestrate-not-registered" };
  }
  return {
    outcome: "allowed",
    tokenId: record.tokenId,
    organizationId: record.organizationId,
    actor: record.actor,
    scopes: record.scopes,
  };
}

/**
 * Decide one API token rotation: the old record is marked revoked at
 * `nowIso` and the successor must be minted separately. Fixed order:
 * wrapper validation (`invalid-input`, the `record` branch
 * `invalid-record`), record validation (`invalid-record`), organization
 * binding (`wrong-organization`), a colliding `newTokenId`
 * (`invalid-input`), revocation (`revoked`) and the validity window
 * (`not-yet-valid`, `expired`).
 */
export function decideApiTokenRotation(input: unknown, isProxy?: IsProxy): ApiTokenRotationResult {
  const detector = isProxy ?? NO_DETECTOR;
  const wrapper = snapshotPlainData(input, detector, WRAPPER_LIMITS);
  if (!wrapper.ok) {
    return { outcome: "refused", reason: wrapperReason(wrapper.path) };
  }
  const snap = wrapper.value;
  if (typeof snap !== "object" || snap === null || Array.isArray(snap)) {
    return { outcome: "refused", reason: INVALID_INPUT };
  }
  const snapRecord = snap as Record<string, unknown>;
  if (!screenOwnKeys(snapRecord, new Set<string>(ROTATION_KEYS))) {
    return { outcome: "refused", reason: INVALID_INPUT };
  }
  for (const key of ROTATION_KEYS) {
    if (!Object.hasOwn(snapRecord, key)) {
      return { outcome: "refused", reason: INVALID_INPUT };
    }
  }
  if (
    typeof snapRecord.organizationId !== "string"
    || !ORGANIZATION_ID_PATTERN.test(snapRecord.organizationId)
  ) {
    return { outcome: "refused", reason: INVALID_INPUT };
  }
  if (!isValidTimestamp(snapRecord.nowIso)) {
    return { outcome: "refused", reason: INVALID_INPUT };
  }
  if (!isValidActorId(snapRecord.newTokenId)) {
    return { outcome: "refused", reason: INVALID_INPUT };
  }
  const recordSnap = wrapperRecord(snapRecord.record);
  if (recordSnap === null) {
    return { outcome: "refused", reason: "invalid-record" };
  }
  const record = buildRecord(recordSnap);
  if (record === null) {
    return { outcome: "refused", reason: "invalid-record" };
  }
  if (record.organizationId !== snapRecord.organizationId) {
    return { outcome: "refused", reason: "wrong-organization" };
  }
  if (snapRecord.newTokenId === record.tokenId) {
    return { outcome: "refused", reason: INVALID_INPUT };
  }
  if (record.revokedAtIso !== null) {
    return { outcome: "refused", reason: "revoked" };
  }
  if (compareZonedIsoInstants(snapRecord.nowIso, record.issuedAtIso) < 0) {
    return { outcome: "refused", reason: "not-yet-valid" };
  }
  if (compareZonedIsoInstants(snapRecord.nowIso, record.expiresAtIso) >= 0) {
    return { outcome: "refused", reason: "expired" };
  }
  return {
    outcome: "rotated",
    revokedRecord: { ...record, revokedAtIso: snapRecord.nowIso },
    successorPending: true,
    newTokenId: snapRecord.newTokenId,
    note: "successor-must-be-minted-separately",
  };
}
