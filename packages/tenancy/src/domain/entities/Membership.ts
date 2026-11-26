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
 * Cost bound: `decideMembershipChange` is O(n) over `members` (one
 * validation pass plus one indexing pass), bounded by
 * `MAX_MEMBERS = 10_000`; `canActAs` (Role.vo) is O(1).
 */

import type { IsProxy } from "@fleet/shared";

import { isZonedIsoDateTime, ORGANIZATION_ID_PATTERN } from "./record-guards.js";
import {
  canActAs,
  FORBIDDEN_KEY_SET,
  isValidRole,
  type Role,
} from "../value-objects/Role.vo.js";

export { canActAs, isValidRole };
export { isZonedIsoDateTime, ORGANIZATION_ID_PATTERN };
export type { Role };

/**
 * Copied verbatim from `apps/api/server/wiring/session-exchange.ts:35`
 * (`ACTOR_PATTERN`); packages may not import apps, so the pattern is
 * duplicated here with the citation as its source of truth.
 */
export const ACTOR_PATTERN = /^[A-Za-z0-9._@-]{1,128}$/;

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

/** True when the value is a plain, non-array, non-Proxy object. */
function isPlainObject(value: unknown, isProxy: IsProxy | undefined): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  if (isProxy !== undefined && isProxy(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Inspect an object's own string keys without reading values: refuses
 * symbols, prototype-polluting keys and accessor properties (getters and
 * setters are detected via `Object.getOwnPropertyDescriptor` and never
 * invoked). Returns the refusal reason, or null.
 *
 * Cost bound: O(k) over the object's own keys, bounded by the allowed-key
 * set sizes (at most 6 for a record, 5 for a change).
 */
function inspectOwnKeys(
  value: object,
  allowedKeys: ReadonlySet<string>,
): string | null {
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key !== "string") {
      return "invalid-input";
    }
    // Prototype-polluting keys are refused before any shape or count check.
    if (FORBIDDEN_KEY_SET.has(key)) {
      return "forbidden-key";
    }
    if (!allowedKeys.has(key)) {
      return "invalid-input";
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "get" in descriptor) {
      return "getter-not-allowed";
    }
  }
  if (keys.length > allowedKeys.size) {
    return "invalid-input";
  }
  return null;
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
  if (!isPlainObject(value, isProxy)) {
    return { ok: false, reason: "invalid-input" };
  }
  const keyReason = inspectOwnKeys(value as object, RECORD_ALLOWED_KEYS);
  if (keyReason !== null) {
    return { ok: false, reason: keyReason };
  }
  const record = value as Record<string, unknown>;
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
  if (typeof members !== "object" || members === null || !Array.isArray(members)) {
    return { ok: false, reason: "invalid-members-list" };
  }
  if (isProxy !== undefined && isProxy(members)) {
    return { ok: false, reason: "invalid-members-list" };
  }
  const array = members as unknown[];
  if (array.length > MAX_MEMBERS) {
    return { ok: false, reason: "too-many-members" };
  }
  // Scan the array's own keys for accessors and polluting keys BEFORE any
  // element read, so a getter at an index is detected via its property
  // descriptor and never invoked. `length` is a built-in own
  // non-enumerable property and is skipped; the scan is O(n + k), still
  // bounded by MAX_MEMBERS plus any extra own keys.
  for (const key of Reflect.ownKeys(array as object)) {
    if (typeof key !== "string") {
      return { ok: false, reason: "invalid-members-list" };
    }
    if (key === "length") {
      continue;
    }
    if (FORBIDDEN_KEY_SET.has(key)) {
      return { ok: false, reason: "forbidden-key" };
    }
    const descriptor = Object.getOwnPropertyDescriptor(array, key);
    if (descriptor !== undefined && "get" in descriptor) {
      return { ok: false, reason: "getter-not-allowed" };
    }
  }
  // Length is already bounded above, so this single pass is O(n) with
  // n <= MAX_MEMBERS. Each element becomes a frozen validated copy; the
  // caller's array and its elements are never mutated.
  const validated: MembershipRecord[] = [];
  for (let i = 0; i < array.length; i += 1) {
    if (!(i in array)) {
      return { ok: false, reason: "sparse-members-list" };
    }
    const element = validateMembershipRecord(array[i], isProxy);
    if (!element.ok) {
      return {
        ok: false,
        reason: element.reason === "invalid-input" ? "invalid-members-list" : element.reason,
      };
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
  if (!isPlainObject(change, isProxy)) {
    return { ok: false, reason: "invalid-input" };
  }
  const keyReason = inspectOwnKeys(change as object, CHANGE_ALLOWED_KEYS);
  if (keyReason !== null) {
    return { ok: false, reason: keyReason };
  }
  const value = change as Record<string, unknown>;
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
 * - An actor appears at most once per organization.
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
  const byActor = new Map<string, MembershipRecord>();
  let ownerCount = 0;
  for (const record of existing) {
    if (record.organizationId !== decided.organizationId) {
      return { ok: false, reason: "organization-mismatch" };
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
  const changed: MembershipRecord = Object.freeze({
    schemaVersion: target.schemaVersion,
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
