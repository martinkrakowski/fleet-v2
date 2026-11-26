/**
 * Membership: one actor's role inside one organization, and the pure
 * decision procedure for membership changes. Pure domain code: no Node,
 * filesystem, subprocess, network or vendor imports; every timestamp is
 * passed in, never read from a clock.
 *
 * Hostile-input posture: `validateMembershipRecord`, `validateMembersList`
 * and `decideMembershipChange` treat every input as untrusted. null,
 * undefined, wrong primitives, arrays (where an object is required),
 * array-likes, non-plain prototypes, sparse arrays, getters (inspected via
 * property descriptors, never invoked), detectable Proxies (via the
 * injected detector), oversized member lists and prototype-polluting keys
 * are each refused with a typed `{ ok: false, reason }` result, never a
 * throw and never a pass.
 *
 * The proxy detector is an OPTIONAL last argument on every exported
 * validator, so the three-argument `decideMembershipChange(members, change,
 * nowIso)` contract works. When a detector is supplied, a detectable Proxy
 * is refused before any reflection operation runs; a supplied value that is
 * not a function is refused (`proxy-detector-required`) and a detector that
 * throws is refused as `detector-threw`. Every untrusted input is copied
 * ONCE by `snapshotPlainData` (through its own data descriptors, so no
 * getter and no Proxy `get` trap ever runs and no value can change between
 * check and use); only the frozen snapshot is validated. Without a
 * detector, a throwing Proxy trap is a typed refusal (a Proxy that lies
 * consistently in every trap is an accepted residual).
 *
 * Cost bound: `decideMembershipChange` is O(n) over `members` (one
 * validation pass plus one indexing pass), bounded by
 * `MAX_MEMBERS = 10_000`; `canActAs` (Role.vo) is O(1).
 */

import { snapshotPlainData, type IsProxy } from "@fleet/shared";

import {
  checkSnapshotKeys,
  isZonedIsoDateTime,
  ORGANIZATION_ID_PATTERN,
  readRecord,
  type RecordRefusal,
} from "./record-guards.js";
import { ACTOR_PATTERN } from "../sign-in-link.js";
import {
  canActAs,
  FORBIDDEN_KEY_SET,
  isValidRole,
  type Role,
} from "../value-objects/Role.vo.js";

export { canActAs, isValidRole };
export { isZonedIsoDateTime, ORGANIZATION_ID_PATTERN };
export type { Role };

/** An organization's membership list is bounded. */
export const MAX_MEMBERS = 10_000;

export { ROLES, MEMBERSHIP_ACTIONS } from "../value-objects/Role.vo.js";
export type { MembershipAction } from "../value-objects/Role.vo.js";

export interface MembershipRecord {
  readonly schemaVersion?: 1;
  readonly organizationId: string;
  readonly actor: string;
  readonly role: Role;
  readonly addedAtIso: string;
  readonly addedBy: string;
}

/** The only own keys a MembershipRecord may carry. */
const RECORD_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "organizationId",
  "actor",
  "role",
  "addedAtIso",
  "addedBy",
]);

/** The only own keys a MembershipChange may carry. */
const CHANGE_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "kind",
  "organizationId",
  "actingActor",
  "actor",
  "role",
]);

export type MembershipChange =
  | {
      readonly kind: "add";
      readonly organizationId: string;
      readonly actingActor: string;
      readonly actor: string;
      readonly role: Role;
    }
  | {
      readonly kind: "change-role";
      readonly organizationId: string;
      readonly actingActor: string;
      readonly actor: string;
      readonly role: Role;
    }
  | {
      readonly kind: "remove";
      readonly organizationId: string;
      readonly actingActor: string;
      readonly actor: string;
    };

export type MembershipDecision =
  | { readonly ok: true; readonly members: readonly MembershipRecord[] }
  | { readonly ok: false; readonly reason: string };

/** A detector that detects nothing, used when the caller supplies none. */
const NO_DETECTOR: IsProxy = () => false;

/**
 * Resolve the optional proxy detector: absent means no detection, a
 * supplied non-function is refused (`proxy-detector-required`). A detector
 * that throws is reported by the snapshot as `detector-threw`.
 *
 * Cost bound: O(1).
 */
function resolveDetector(
  isProxy: unknown,
): { ok: true; detector: IsProxy } | { ok: false; reason: string } {
  if (isProxy === undefined) {
    return { ok: true, detector: NO_DETECTOR };
  }
  if (typeof isProxy !== "function") {
    return { ok: false, reason: "proxy-detector-required" };
  }
  return { ok: true, detector: isProxy as IsProxy };
}

/** Map a typed record refusal to this module's stable reason codes. */
function recordRefusalCode(refusal: RecordRefusal): string {
  switch (refusal.kind) {
    case "snapshot":
      if (refusal.reason === "accessor") {
        return "getter-not-allowed";
      }
      // `invalid-limits` is how the snapshot reports a detector that throws
      // while screening its own (fixed, valid) limits argument.
      return refusal.reason === "detector-threw" || refusal.reason === "invalid-limits"
        ? "detector-threw"
        : "invalid-input";
    case "forbidden-key":
      return "forbidden-key";
    case "unknown-key":
      return FORBIDDEN_KEY_SET.has(refusal.key) ? "forbidden-key" : "invalid-input";
    default:
      return "invalid-input";
  }
}

/**
 * Validate one membership record's field values. Returns the refusal
 * reason, or null.
 *
 * Cost bound: O(1) — a fixed number of pattern tests and timestamp parses
 * over bounded strings.
 */
function checkRecordFields(record: Record<string, unknown>): string | null {
  if (Object.hasOwn(record, "schemaVersion") && record.schemaVersion !== 1) {
    return "invalid-schema-version";
  }
  const organizationId = record.organizationId;
  if (typeof organizationId !== "string" || !ORGANIZATION_ID_PATTERN.test(organizationId)) {
    return "invalid-organization-id";
  }
  if (typeof record.actor !== "string" || !ACTOR_PATTERN.test(record.actor)) {
    return "invalid-actor";
  }
  if (!isValidRole(record.role)) {
    return "invalid-role";
  }
  if (!isZonedIsoDateTime(record.addedAtIso)) {
    return "invalid-timestamp";
  }
  if (typeof record.addedBy !== "string" || !ACTOR_PATTERN.test(record.addedBy)) {
    return "invalid-actor";
  }
  return null;
}

/**
 * Validate unknown input as a MembershipRecord; a refused value never
 * throws.
 *
 * Cost bound: O(1) — one pass over at most the 6 allowed own keys plus a
 * fixed number of field checks.
 */
export function validateMembershipRecord(
  value: unknown,
  isProxy?: IsProxy,
): { ok: true; record: MembershipRecord } | { ok: false; reason: string } {
  const detector = resolveDetector(isProxy);
  if (!detector.ok) {
    return { ok: false, reason: detector.reason };
  }
  const read = readRecord(value, detector.detector, RECORD_ALLOWED_KEYS);
  if (!read.ok) {
    return { ok: false, reason: recordRefusalCode(read.refusal) };
  }
  return validateRecordSnapshot(read.value);
}

/**
 * Validate an already-snapshotted record (a frozen copy: every field was
 * read once through its own data descriptor) and build the frozen result.
 */
function validateRecordSnapshot(
  record: Record<string, unknown>,
): { ok: true; record: MembershipRecord } | { ok: false; reason: string } {
  const fieldReason = checkRecordFields(record);
  if (fieldReason !== null) {
    return { ok: false, reason: fieldReason };
  }
  const validated: {
    schemaVersion?: 1;
    organizationId: string;
    actor: string;
    role: Role;
    addedAtIso: string;
    addedBy: string;
  } = {
    organizationId: record.organizationId as string,
    actor: record.actor as string,
    role: record.role as Role,
    addedAtIso: record.addedAtIso as string,
    addedBy: record.addedBy as string,
  };
  if (record.schemaVersion === 1) {
    validated.schemaVersion = 1;
  }
  return { ok: true, record: Object.freeze(validated) };
}

/**
 * Validate an untrusted members list. One pass: shape, length bound,
 * sparseness, accessors, prototype-polluting keys, element validity and
 * duplicate actors.
 *
 * Cost bound: O(n) over at most `MAX_MEMBERS` elements, each element
 * validated in O(1).
 */
export function validateMembersList(
  members: unknown,
  isProxy?: IsProxy,
): { ok: true; members: readonly MembershipRecord[] } | { ok: false; reason: string } {
  const detector = resolveDetector(isProxy);
  if (!detector.ok) {
    return { ok: false, reason: detector.reason };
  }
  // One snapshot of the whole list: every index and field is read once,
  // through its own data descriptor (an inherited getter at a hole, an
  // accessor, a Proxy `get` trap or a flip-flopping value never runs), and
  // an extra own key on the array is refused. Everything below validates
  // the frozen snapshot only.
  const snapshot = snapshotPlainData(members, detector.detector, {
    maxDepth: 2,
    maxKeys: RECORD_ALLOWED_KEYS.size + 1,
    maxArrayLength: MAX_MEMBERS,
    maxNodes: MAX_MEMBERS * (RECORD_ALLOWED_KEYS.size + 1) + 1,
    maxStringLength: 4096,
  });
  if (!snapshot.ok) {
    switch (snapshot.reason) {
      case "too-many-items":
        return { ok: false, reason: "too-many-members" };
      case "sparse-array":
        return { ok: false, reason: "sparse-members-list" };
      case "accessor":
        return { ok: false, reason: "getter-not-allowed" };
      case "detector-threw":
      case "invalid-limits":
        return { ok: false, reason: "detector-threw" };
      default:
        return { ok: false, reason: "invalid-members-list" };
    }
  }
  if (!Array.isArray(snapshot.value)) {
    return { ok: false, reason: "invalid-members-list" };
  }
  const validated: MembershipRecord[] = [];
  for (const entry of snapshot.value as unknown[]) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, reason: "invalid-members-list" };
    }
    const keyRefusal = checkSnapshotKeys(entry as Record<string, unknown>, RECORD_ALLOWED_KEYS);
    if (keyRefusal !== null) {
      const code = recordRefusalCode(keyRefusal);
      return { ok: false, reason: code === "invalid-input" ? "invalid-members-list" : code };
    }
    const element = validateRecordSnapshot(entry as Record<string, unknown>);
    if (!element.ok) {
      return { ok: false, reason: element.reason };
    }
    validated.push(element.record);
  }
  return { ok: true, members: validated };
}

/**
 * Validate an untrusted membership change. Returns the parsed change, or
 * the refusal reason.
 *
 * Cost bound: O(1) — one pass over at most the 5 allowed own keys plus a
 * fixed number of field checks.
 */
export function validateMembershipChange(
  change: unknown,
  isProxy?: IsProxy,
): { ok: true; change: MembershipChange } | { ok: false; reason: string } {
  const detector = resolveDetector(isProxy);
  if (!detector.ok) {
    return { ok: false, reason: detector.reason };
  }
  const read = readRecord(change, detector.detector, CHANGE_ALLOWED_KEYS);
  if (!read.ok) {
    return { ok: false, reason: recordRefusalCode(read.refusal) };
  }
  const value = read.value;
  const kind = value.kind;
  if (kind !== "add" && kind !== "change-role" && kind !== "remove") {
    return { ok: false, reason: "invalid-kind" };
  }
  const organizationId = value.organizationId;
  if (typeof organizationId !== "string" || !ORGANIZATION_ID_PATTERN.test(organizationId)) {
    return { ok: false, reason: "invalid-organization-id" };
  }
  if (typeof value.actingActor !== "string" || !ACTOR_PATTERN.test(value.actingActor)) {
    return { ok: false, reason: "invalid-actor" };
  }
  if (typeof value.actor !== "string" || !ACTOR_PATTERN.test(value.actor)) {
    return { ok: false, reason: "invalid-actor" };
  }
  if (kind === "remove") {
    // A remove carries no role, but a `role` key that is present must
    // still be a valid role: garbage is refused instead of silently ignored.
    if (Object.hasOwn(value, "role") && !isValidRole(value.role)) {
      return { ok: false, reason: "invalid-role" };
    }
    return {
      ok: true,
      change: Object.freeze({
        kind,
        organizationId,
        actingActor: value.actingActor,
        actor: value.actor,
      }),
    };
  }
  if (!isValidRole(value.role)) {
    return { ok: false, reason: "invalid-role" };
  }
  return {
    ok: true,
    change: Object.freeze({
      kind,
      organizationId,
      actingActor: value.actingActor,
      actor: value.actor,
      role: value.role,
    }),
  };
}

/**
 * Decide a membership change against a members list at `nowIso`. Pure: the
 * input `members` array and its elements are never mutated; the returned
 * list and records are frozen copies.
 *
 * Invariants, in decision order:
 * - `change.actingActor` resolves the caller's role by lookup in `members`
 *   only (the caller's role is never an input).
 * - An empty members list admits only the first-owner bootstrap
 *   (`add` with `role: 'owner'`).
 * - Every record must name `change.organizationId`.
 * - Only a member with `manage-members` permission may act.
 * - An actor appears at most once per organization; an existing list that
 *   already carries two records for one actor is refused.
 * - The last owner can neither be removed nor demoted.
 *
 * Cost bound: O(n) over `members` (bounded by `MAX_MEMBERS = 10_000`): one
 * validation pass, one organization-consistency and actor-index pass, and
 * one owner count — each element's own validation is O(1).
 */
export function decideMembershipChange(
  members: unknown,
  change: unknown,
  nowIso: unknown,
  isProxy?: IsProxy,
): MembershipDecision {
  const detectorCheck = resolveDetector(isProxy);
  if (!detectorCheck.ok) {
    return { ok: false, reason: detectorCheck.reason };
  }
  const list = validateMembersList(members, isProxy);
  if (!list.ok) {
    return { ok: false, reason: list.reason };
  }
  const parsedChange = validateMembershipChange(change, isProxy);
  if (!parsedChange.ok) {
    return { ok: false, reason: parsedChange.reason };
  }
  const decided = parsedChange.change;
  if (!isZonedIsoDateTime(nowIso)) {
    return { ok: false, reason: "invalid-timestamp" };
  }
  const existing = list.members;
  // One indexing pass: organization consistency, actor index, owner count.
  // A record whose actor is already indexed means the existing list itself
  // violates the at-most-once-per-organization invariant, so the change is
  // refused instead of silently keeping (or overwriting) one of the
  // duplicate records.
  const byActor = new Map<string, MembershipRecord>();
  let ownerCount = 0;
  for (const record of existing) {
    if (record.organizationId !== decided.organizationId) {
      return { ok: false, reason: "organization-mismatch" };
    }
    if (byActor.has(record.actor)) {
      return { ok: false, reason: "duplicate-actor" };
    }
    byActor.set(record.actor, record);
    if (record.role === "owner") {
      ownerCount += 1;
    }
  }
  if (existing.length === 0) {
    if (decided.kind !== "add" || decided.role !== "owner") {
      return { ok: false, reason: "first-owner-required" };
    }
    const first: MembershipRecord = Object.freeze({
      organizationId: decided.organizationId,
      actor: decided.actor,
      role: decided.role,
      addedAtIso: nowIso,
      addedBy: decided.actingActor,
    });
    return { ok: true, members: Object.freeze([first]) };
  }
  const actingMember = byActor.get(decided.actingActor);
  if (actingMember === undefined || !canActAs(actingMember.role, "manage-members")) {
    return { ok: false, reason: "not-permitted" };
  }
  if (decided.kind === "add") {
    if (byActor.has(decided.actor)) {
      return { ok: false, reason: "duplicate-actor" };
    }
    const added: MembershipRecord = Object.freeze({
      organizationId: decided.organizationId,
      actor: decided.actor,
      role: decided.role,
      addedAtIso: nowIso,
      addedBy: decided.actingActor,
    });
    return { ok: true, members: Object.freeze([...existing, added]) };
  }
  const target = byActor.get(decided.actor);
  if (target === undefined) {
    return { ok: false, reason: "unknown-actor" };
  }
  if (decided.kind === "remove") {
    if (target.role === "owner" && ownerCount === 1) {
      return { ok: false, reason: "last-owner" };
    }
    return {
      ok: true,
      members: Object.freeze(existing.filter((record) => record !== target)),
    };
  }
  // change-role
  if (target.role === "owner" && decided.role !== "owner" && ownerCount === 1) {
    return { ok: false, reason: "last-owner" };
  }
  // Preserve the target's schemaVersion without writing an own
  // `schemaVersion: undefined` property: an explicit undefined own key
  // would fail validateMembershipRecord with `invalid-schema-version`
  // downstream, so the key is present only when the target carries it.
  const changed: MembershipRecord = Object.freeze({
    ...(target.schemaVersion === 1 ? { schemaVersion: 1 as const } : {}),
    organizationId: target.organizationId,
    actor: target.actor,
    role: decided.role,
    addedAtIso: target.addedAtIso,
    addedBy: target.addedBy,
  });
  return {
    ok: true,
    members: Object.freeze(
      existing.map((record) => (record === target ? changed : record)),
    ),
  };
}
