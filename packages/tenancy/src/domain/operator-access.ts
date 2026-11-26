/**
 * Pure time-bounded operator-access decider. Pure domain code: no Node,
 * filesystem, subprocess, network or vendor imports; no clock, no
 * randomness — the caller supplies `nowIso` inside the envelope.
 *
 * An operator reaches one organisation only through a time-bounded grant
 * naming the actor, the organisation, a reason and an expiry; there is
 * never a standing cross-tenant owner.
 *
 * Hostile-input posture: null, undefined, primitives, arrays, array holes,
 * array-likes, non-plain prototypes, getters/setters (never read — the
 * snapshot reads own data descriptors only), detectable Proxies (via the
 * required, caller-supplied `isProxy` detector — an absent or
 * non-function detector is itself refused, never defaulted to
 * "detects nothing"), symbol keys, oversized strings and
 * prototype-polluting own keys (`__proto__`, `constructor`, `prototype`,
 * `length`) are each refused with a typed result, never a throw and never
 * a pass.
 *
 * Cost bounds:
 * - `parseOperatorAccessGrant`: O(1) — one fixed 5-key `readRecord`
 *   snapshot (`maxDepth: 1`, `maxKeys: 6`, `maxStringLength: 4096`),
 *   bounded pattern checks (actor at most 128 characters, organisation id
 *   at most 63), `hasControlCharacter` bounded by
 *   `MAX_OPERATOR_REASON_LENGTH` (512 characters), and two
 *   `isZonedIsoDateTime` / `compareZonedIsoInstants` calls.
 * - `decideOperatorAccess`: O(1) — one fixed 3-key envelope
 *   `snapshotPlainData` pass (`maxDepth: 2`, `maxKeys: 8`,
 *   `maxArrayLength: 0`, `maxNodes: 16`, `maxStringLength: 4096`), one
 *   `parseOperatorAccessGrant` call, and O(1) instant and string
 *   comparisons.
 *
 * Every refusal returns a typed result and an audit row, and never echoes
 * `grant.reason` or any rejected input value.
 */

import { snapshotPlainData, type IsProxy } from "@fleet/shared";

import { ACTOR_PATTERN } from "./sign-in-link.js";
import {
  MAX_STRING_LENGTH,
  ORGANIZATION_ID_PATTERN,
  checkSnapshotKeys,
  compareZonedIsoInstants,
  hasControlCharacter,
  isZonedIsoDateTime,
  readRecord,
} from "./entities/record-guards.js";

/** An operator grant lives at most 4 hours. */
export const OPERATOR_ACCESS_MAX_DURATION_MS = 4 * 60 * 60 * 1000;

/** A reason is at most this many characters. */
export const MAX_OPERATOR_REASON_LENGTH = 512;

export interface OperatorAccessGrant {
  readonly actor: string;
  readonly organizationId: string;
  readonly reason: string;
  readonly grantedAtIso: string;
  readonly expiresAtIso: string;
}

export interface OperatorAccessAuditRow {
  readonly actor: string;
  readonly organizationId: string;
  readonly reason: string;
  readonly atIso: string;
}

export type OperatorAccessRefusalReason =
  | "invalid-grant"
  | "wrong-organization"
  | "not-yet-valid"
  | "expired"
  | "invalid-input";

export type ParseOperatorAccessGrantResult =
  | { readonly outcome: "parsed"; readonly grant: OperatorAccessGrant }
  | { readonly outcome: "refused"; readonly reason: "invalid-grant" };

export type OperatorAccessDecisionResult =
  | {
      readonly outcome: "allowed";
      readonly actor: string;
      readonly organizationId: string;
      readonly audit: OperatorAccessAuditRow;
    }
  | {
      readonly outcome: "refused";
      readonly reason: OperatorAccessRefusalReason;
      readonly audit: OperatorAccessAuditRow;
    };

/** The only own keys a grant record may carry. */
const GRANT_KEYS: ReadonlySet<string> = new Set([
  "actor",
  "organizationId",
  "reason",
  "grantedAtIso",
  "expiresAtIso",
]);

/** The only own keys the `decideOperatorAccess` envelope may carry. */
const ENVELOPE_KEYS: ReadonlySet<string> = new Set(["grant", "organizationId", "nowIso"]);

/** Prototype-polluting and array-like keys, screened without enumeration. */
const FORBIDDEN_KEYS: readonly string[] = ["__proto__", "constructor", "prototype", "length"];

/**
 * The proxy detector is required and trusted: every caller must supply one
 * explicitly. An absent (`undefined`) or non-function detector is refused —
 * there is no silent "detects nothing" default, because a Proxy wrapping a
 * valid grant could otherwise run reflection traps during snapshotting and
 * be accepted.
 */
function resolveDetector(
  isProxy: IsProxy,
): { ok: true; detector: IsProxy } | { ok: false } {
  if (typeof isProxy !== "function") {
    return { ok: false };
  }
  return { ok: true, detector: isProxy };
}

/** A string matching ACTOR_PATTERN, length-checked before the regex. O(1). */
function isValidGrantActor(value: unknown): value is string {
  return (
    typeof value === "string" && value.length >= 1 && value.length <= 128 && ACTOR_PATTERN.test(value)
  );
}

/** A string matching ORGANIZATION_ID_PATTERN, length-checked before the regex. O(1). */
function isValidGrantOrganizationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 63 &&
    ORGANIZATION_ID_PATTERN.test(value)
  );
}

/**
 * The sub-millisecond fractional digits of a zoned ISO-8601 string that
 * already passed `isZonedIsoDateTime`, padded and sliced the same way
 * `compareZonedIsoInstants` compares them. `Date.parse` keeps only
 * millisecond precision, so two instants inside the same millisecond can
 * still differ below it.
 */
function subMillisDigits(iso: string): string {
  const match = /\.(\d{1,9})/.exec(iso);
  return (match === null ? "" : match[1]).padEnd(9, "0").slice(3);
}

/**
 * Snapshot an unknown value as a plain grant record whose own data
 * properties are exactly the five grant keys, then validate every field.
 * No getter and no Proxy `get` trap ever runs: `readRecord` reads own data
 * descriptors through one bounded snapshot pass, and hostile names are
 * screened without enumerating own properties. Returns `refused` on any
 * hostile shape.
 *
 * Cost bound: O(1) — one fixed 5-key `readRecord` pass, bounded pattern
 * checks, `hasControlCharacter` bounded by 512 characters, and two bounded
 * instant comparisons.
 */
export function parseOperatorAccessGrant(
  raw: unknown,
  isProxy: IsProxy,
): ParseOperatorAccessGrantResult {
  const REFUSED: ParseOperatorAccessGrantResult = Object.freeze({
    outcome: "refused",
    reason: "invalid-grant",
  });
  const resolved = resolveDetector(isProxy);
  if (!resolved.ok) {
    return REFUSED;
  }
  const read = readRecord(raw, resolved.detector, GRANT_KEYS);
  if (!read.ok) {
    return REFUSED;
  }
  const record = read.value;
  try {
    for (const key of FORBIDDEN_KEYS) {
      if (Object.getOwnPropertyDescriptor(record, key) !== undefined) {
        return REFUSED;
      }
    }
  } catch {
    // A frozen plain snapshot cannot throw here; kept for symmetry and
    // safety against future snapshot changes.
    return REFUSED;
  }
  for (const key of GRANT_KEYS) {
    if (!Object.hasOwn(record, key)) {
      return REFUSED;
    }
  }
  if (!isValidGrantActor(record.actor)) {
    return REFUSED;
  }
  if (!isValidGrantOrganizationId(record.organizationId)) {
    return REFUSED;
  }
  const reason = record.reason;
  if (
    typeof reason !== "string" ||
    reason.length < 1 ||
    reason.length > MAX_OPERATOR_REASON_LENGTH ||
    hasControlCharacter(reason)
  ) {
    return REFUSED;
  }
  if (!isZonedIsoDateTime(record.grantedAtIso) || !isZonedIsoDateTime(record.expiresAtIso)) {
    return REFUSED;
  }
  const grantedAtIso = record.grantedAtIso;
  const expiresAtIso = record.expiresAtIso;
  // The expiry must be strictly after the grant instant.
  if (compareZonedIsoInstants(expiresAtIso, grantedAtIso) <= 0) {
    return REFUSED;
  }
  // The duration is at most OPERATOR_ACCESS_MAX_DURATION_MS. Date.parse
  // keeps only millisecond precision, so when the parsed difference lands
  // exactly on the maximum, the sub-millisecond fractional digits of
  // `expiresAtIso` must not exceed those of `grantedAtIso`, which would
  // push the true duration past the bound.
  const durationMs = Date.parse(expiresAtIso) - Date.parse(grantedAtIso);
  if (durationMs > OPERATOR_ACCESS_MAX_DURATION_MS) {
    return REFUSED;
  }
  if (durationMs === OPERATOR_ACCESS_MAX_DURATION_MS) {
    if (subMillisDigits(expiresAtIso) > subMillisDigits(grantedAtIso)) {
      return REFUSED;
    }
  }
  const grant: OperatorAccessGrant = Object.freeze({
    actor: record.actor,
    organizationId: record.organizationId,
    reason,
    grantedAtIso,
    expiresAtIso,
  });
  return { outcome: "parsed", grant };
}

/**
 * Decide one operator-access request against a time-bounded grant.
 *
 * Fixed order:
 *
 * 1. resolve the proxy detector (absent or non-function is `invalid-input`);
 * 2. snapshot the envelope once — any snapshot failure at `grant` or
 *    `grant.*` maps to `invalid-grant`, any other failure to `invalid-input`;
 * 3. key-check the snapshotted envelope against `ENVELOPE_KEYS`
 *    (`invalid-input`);
 * 4. validate `organizationId` and `nowIso` (`invalid-input`);
 * 5. parse the grant (`invalid-grant`);
 * 6. cross-organisation is `wrong-organization`;
 * 7. `nowIso` before `grantedAtIso` is `not-yet-valid`;
 * 8. `nowIso` at or after `expiresAtIso` is `expired`;
 * 9. otherwise the access is allowed.
 *
 * Every decision (allowed or refused) returns one frozen audit row
 * `{ actor, organizationId, reason, atIso }`. On any refusal,
 * `audit.reason` is the refusal code and the audit row never contains
 * `grant.reason` or any rejected input value.
 */
export function decideOperatorAccess(
  input: unknown,
  isProxy: IsProxy,
): OperatorAccessDecisionResult {
  const UNKNOWN_AUDIT: OperatorAccessAuditRow = Object.freeze({
    actor: "unknown",
    organizationId: "unknown",
    reason: "invalid-input",
    atIso: "unknown",
  });
  const resolved = resolveDetector(isProxy);
  if (!resolved.ok) {
    return { outcome: "refused", reason: "invalid-input", audit: UNKNOWN_AUDIT };
  }
  const { detector } = resolved;
  const snapshot = snapshotPlainData(input, detector, {
    maxDepth: 2,
    maxKeys: 8,
    maxArrayLength: 0,
    maxNodes: 16,
    maxStringLength: MAX_STRING_LENGTH,
  });
  if (!snapshot.ok) {
    const atGrant = snapshot.path === "grant" || (snapshot.path?.startsWith("grant.") ?? false);
    return {
      outcome: "refused",
      reason: atGrant ? "invalid-grant" : "invalid-input",
      audit: Object.freeze({
        actor: "unknown",
        organizationId: "unknown",
        reason: atGrant ? "invalid-grant" : "invalid-input",
        atIso: "unknown",
      }),
    };
  }
  const value = snapshot.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { outcome: "refused", reason: "invalid-input", audit: UNKNOWN_AUDIT };
  }
  const envelope = value as Record<string, unknown>;
  const keyRefusal = checkSnapshotKeys(envelope, ENVELOPE_KEYS);
  if (keyRefusal !== null) {
    return { outcome: "refused", reason: "invalid-input", audit: UNKNOWN_AUDIT };
  }
  try {
    for (const key of FORBIDDEN_KEYS) {
      if (Object.getOwnPropertyDescriptor(envelope, key) !== undefined) {
        return { outcome: "refused", reason: "invalid-input", audit: UNKNOWN_AUDIT };
      }
    }
  } catch {
    return { outcome: "refused", reason: "invalid-input", audit: UNKNOWN_AUDIT };
  }
  const rawOrganizationId = envelope.organizationId;
  const rawNowIso = envelope.nowIso;
  const validOrganizationId =
    typeof rawOrganizationId === "string" && ORGANIZATION_ID_PATTERN.test(rawOrganizationId)
      ? rawOrganizationId
      : null;
  const validNowIso = isZonedIsoDateTime(rawNowIso) ? rawNowIso : null;
  if (validOrganizationId === null || validNowIso === null) {
    return {
      outcome: "refused",
      reason: "invalid-input",
      audit: Object.freeze({
        actor: "unknown",
        organizationId: validOrganizationId ?? "unknown",
        reason: "invalid-input",
        atIso: validNowIso ?? "unknown",
      }),
    };
  }
  const organizationId = validOrganizationId;
  const nowIso = validNowIso;
  const hasGrantKey = Object.hasOwn(envelope, "grant");
  const parsed = hasGrantKey
    ? parseOperatorAccessGrant(envelope.grant, detector)
    : ({ outcome: "refused", reason: "invalid-grant" } as const);
  if (parsed.outcome !== "parsed") {
    return {
      outcome: "refused",
      reason: "invalid-grant",
      audit: Object.freeze({
        actor: "unknown",
        organizationId,
        reason: "invalid-grant",
        atIso: nowIso,
      }),
    };
  }
  const grant = parsed.grant;
  if (grant.organizationId !== organizationId) {
    return {
      outcome: "refused",
      reason: "wrong-organization",
      audit: Object.freeze({
        actor: grant.actor,
        organizationId,
        reason: "wrong-organization",
        atIso: nowIso,
      }),
    };
  }
  if (compareZonedIsoInstants(nowIso, grant.grantedAtIso) < 0) {
    return {
      outcome: "refused",
      reason: "not-yet-valid",
      audit: Object.freeze({
        actor: grant.actor,
        organizationId,
        reason: "not-yet-valid",
        atIso: nowIso,
      }),
    };
  }
  if (compareZonedIsoInstants(nowIso, grant.expiresAtIso) >= 0) {
    return {
      outcome: "refused",
      reason: "expired",
      audit: Object.freeze({
        actor: grant.actor,
        organizationId,
        reason: "expired",
        atIso: nowIso,
      }),
    };
  }
  return {
    outcome: "allowed",
    actor: grant.actor,
    organizationId: grant.organizationId,
    audit: Object.freeze({
      actor: grant.actor,
      organizationId: grant.organizationId,
      reason: grant.reason,
      atIso: nowIso,
    }),
  };
}
