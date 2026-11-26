/**
 * FC17D: pure scoped-halt decider over org, cell and global scopes. Three
 * exported functions — `decideHaltRequest` (does this halt/lift request
 * stand?), `isDispatchHalted` (is a dispatch target blocked right now?) and
 * `decideScopedHalt` (both at once) — read untrusted input once through
 * `snapshotPlainData` from `@fleet/shared` and never throw, never echo a
 * value or ID, never read a clock and never log. A malformed or hostile read
 * is a typed refusal for a decision and a `true` (halted) answer for the
 * dispatch gate: fail closed.
 *
 * Hostile-input cost bounds (stated per check):
 * - Proxy, revoked Proxy, non-plain prototype, non-finite number, `-0`,
 *   `undefined`, function: `O(1)` inside `snapshotPlainData` before any key
 *   enumeration.
 * - Enormous array length (`> 1000`): `O(1)` length pre-gate inside
 *   `snapshotPlainData` before own-keys enumeration.
 * - Sparse array holes, accessors (never invoked), symbol keys,
 *   non-enumerable keys, too-deep, too-long strings: one descriptor check
 *   per own key/index, `O(own keys)`.
 * - Own `__proto__` keys, extra/unknown keys, missing required keys: after
 *   the snapshot succeeds, one `Object.keys` enumeration per record,
 *   `O(own keys)`.
 * No refusal ever stringifies or echoes a refused value or ID.
 */

import {
  snapshotPlainData,
  type IsProxy,
  type PlainDataLimits,
  type PlainDataSnapshot,
} from '@fleet/shared';

/** Hard cap on how many halt records one request may carry. */
export const MAX_SCOPED_HALTS = 1000;

/** Explicit snapshot limits for every scoped-halt read (FC17D). */
export const SCOPED_HALT_LIMITS: PlainDataLimits = Object.freeze({
  maxDepth: 6,
  maxKeys: 16,
  maxArrayLength: MAX_SCOPED_HALTS,
  // 1000 entries of up to 4 fields = 5000 nodes, plus root/request/target
  // overhead.
  maxNodes: 6000,
  maxStringLength: 1024,
});

/** The scope a halt record names. */
export type HaltScope = 'org' | 'cell' | 'global';

/** Who imposed (or lifted) a halt. */
export type HaltActorKind = 'org-admin' | 'operator';

/** One halt state record for one scope and, except `global`, one id. */
export interface ScopedHaltEntry {
  readonly scope: HaltScope;
  readonly id?: string;
  readonly halted: boolean;
  readonly imposedBy: HaltActorKind;
}

/** The dispatch target an org's and cell's scoping compares against. */
export interface ScopedHaltTarget {
  readonly organizationId: string;
  readonly cellId: string;
}

/** The halt or lift request an actor asks the decider to permit. */
export interface ScopedHaltRequest {
  readonly scope: HaltScope;
  readonly id?: string;
  readonly halted: boolean;
  readonly confirmGlobalLift?: boolean;
}

/** The fixed refusal reasons of the scoped-halt deciders (FC17D). */
export type ScopedHaltReason =
  | 'invalid-input'
  | 'invalid-actor'
  | 'invalid-actor-organization'
  | 'invalid-request'
  | 'invalid-halts'
  | 'invalid-target'
  | 'not-permitted'
  | 'global-lift-confirmation-required';

/** `decideHaltRequest` outcome. */
export type ScopedHaltDecision =
  | {
      readonly ok: true;
      readonly scope: HaltScope;
      readonly id?: string;
      readonly halted: boolean;
      readonly imposedBy: HaltActorKind;
    }
  | {
      readonly ok: false;
      readonly reason: ScopedHaltReason;
    };

/** `decideScopedHalt` outcome. */
export type ScopedHaltWithDispatchDecision =
  | {
      readonly ok: true;
      readonly requestDecision: {
        readonly scope: HaltScope;
        readonly id?: string;
        readonly halted: boolean;
        readonly imposedBy: HaltActorKind;
      };
      readonly dispatchHalted: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: ScopedHaltReason;
      readonly dispatchHalted: boolean;
    };

/** A non-empty trimmed string. */
function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

/**
 * The record as a plain object whose own enumerable keys are exactly a
 * subset of `allowed` — no extra, symbol or own-`__proto__` key:
 * `O(own keys)`, one enumeration (the only one). The value must be a
 * snapshot plain record already — the prototype check is a belt-and-braces
 * guard on the frozen copy. Missing keys are checked by the caller so a
 * missing root key can take its own field's reason.
 */
function plainRecordWithOnlyKeys(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return null;
  }
  const allowedSet = new Set<string>(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      return null;
    }
  }
  return value as Record<string, unknown>;
}

/** Validate a scope value. */
function isHaltScope(value: unknown): value is HaltScope {
  return value === 'org' || value === 'cell' || value === 'global';
}

/** Validate an actor kind value. */
function isHaltActorKind(value: unknown): value is HaltActorKind {
  return value === 'org-admin' || value === 'operator';
}

/**
 * Scope/id shape shared by `requested` and every halts entry: `id` is
 * required non-empty trimmed for `'org'` and `'cell'` and must be absent for
 * `'global'`.
 */
function validateScopeId(
  scope: unknown,
  id: unknown,
  hasId: boolean,
): boolean {
  if (!isHaltScope(scope)) {
    return false;
  }
  if (scope === 'global') {
    return !hasId;
  }
  return hasId && isNonEmptyTrimmedString(id);
}

/** A validated halts list (already snapshotted), or its refusal. */
type HaltsCheck =
  | { readonly ok: true; readonly entries: readonly ScopedHaltEntry[] }
  | { readonly ok: false };

/**
 * Validate the snapshotted `halts` value: a dense array of at most
 * `MAX_SCOPED_HALTS` entries, each an exact plain record. `O(own keys)` per
 * entry, one enumeration each.
 */
function validateHalts(value: unknown): HaltsCheck {
  if (!Array.isArray(value) || value.length > MAX_SCOPED_HALTS) {
    return { ok: false };
  }
  const entries: ScopedHaltEntry[] = [];
  for (const raw of value) {
    const record = plainRecordWithOnlyKeys(raw, ['scope', 'halted', 'imposedBy', 'id']);
    if (record === null) {
      return { ok: false };
    }
    if (
      !Object.hasOwn(record, 'scope') ||
      !Object.hasOwn(record, 'halted') ||
      !Object.hasOwn(record, 'imposedBy') ||
      !validateScopeId(record.scope, record.id, Object.hasOwn(record, 'id')) ||
      typeof record.halted !== 'boolean' ||
      !isHaltActorKind(record.imposedBy)
    ) {
      return { ok: false };
    }
    entries.push({
      scope: record.scope as HaltScope,
      ...(record.scope === 'global' ? {} : { id: record.id as string }),
      halted: record.halted,
      imposedBy: record.imposedBy,
    });
  }
  return { ok: true, entries };
}

/** A validated target (already snapshotted), or its refusal. */
type TargetCheck =
  | { readonly ok: true; readonly target: ScopedHaltTarget }
  | { readonly ok: false };

/**
 * Validate the snapshotted `target` value: an exact plain record with
 * non-empty trimmed `organizationId` and `cellId`.
 */
function validateTarget(value: unknown): TargetCheck {
  const record = plainRecordWithOnlyKeys(value, ['organizationId', 'cellId']);
  if (
    record === null ||
    !Object.hasOwn(record, 'organizationId') ||
    !Object.hasOwn(record, 'cellId') ||
    !isNonEmptyTrimmedString(record.organizationId) ||
    !isNonEmptyTrimmedString(record.cellId)
  ) {
    return { ok: false };
  }
  return { ok: true, target: { organizationId: record.organizationId, cellId: record.cellId } };
}

/**
 * The permission core over validated values: pure, no echo. `halts` is the
 * validated entry list used only for the org-admin lift guard.
 */
function decidePermission(
  actorKind: HaltActorKind,
  actorOrganizationId: string | undefined,
  requested: { scope: HaltScope; id: string; halted: boolean; confirmGlobalLift: boolean },
  entries: readonly ScopedHaltEntry[],
): { readonly permitted: true } | { readonly permitted: false; readonly reason: 'not-permitted' | 'global-lift-confirmation-required' } {
  const { scope, id, halted } = requested;
  // The shape of `requested` (a valid scope, an id present exactly when the
  // scope needs one) is already validated as `invalid-request` by the
  // caller; only permission is decided here.
  if (actorKind === 'org-admin') {
    if (scope !== 'org' || id !== actorOrganizationId) {
      return { permitted: false, reason: 'not-permitted' };
    }
    if (!halted) {
      // Lifting an operator-imposed halt on its own org is refused.
      const operatorImposed = entries.some(
        (entry) => entry.scope === 'org' && entry.id === id && entry.halted && entry.imposedBy === 'operator',
      );
      if (operatorImposed) {
        return { permitted: false, reason: 'not-permitted' };
      }
    }
    return { permitted: true };
  }
  if (scope === 'global' && !halted && requested.confirmGlobalLift !== true) {
    return { permitted: false, reason: 'global-lift-confirmation-required' };
  }
  return { permitted: true };
}

/**
 * The dispatch gate over already-validated values: a halt blocks the target
 * when any active record matches globally, by cell id, or by org id.
 * Contradictions resolve to halted when any record says halted. A halted
 * `'org'` never halts another `'org'` because the comparison is by id.
 */
function evaluateDispatchHalted(entries: readonly ScopedHaltEntry[], target: ScopedHaltTarget): boolean {
  for (const entry of entries) {
    if (!entry.halted) {
      continue;
    }
    if (
      entry.scope === 'global' ||
      (entry.scope === 'cell' && entry.id === target.cellId) ||
      (entry.scope === 'org' && entry.id === target.organizationId)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Map a snapshot refusal path to the fixed reason for the field it failed
 * in. `null` (a refusal at the root itself) is `invalid-input`; a missing
 * root key never reaches here — it is caught by the root key-set check and
 * takes its own field's reason.
 */
function reasonForSnapshotPath(path: string | null, hasTarget: boolean): ScopedHaltReason {
  if (path === null) {
    return 'invalid-input';
  }
  if (path === 'actorKind') {
    return 'invalid-actor';
  }
  if (path === 'actorOrganizationId') {
    return 'invalid-actor-organization';
  }
  if (path === 'requested' || path.startsWith('requested.')) {
    return 'invalid-request';
  }
  if (path === 'halts' || path.startsWith('halts[')) {
    return 'invalid-halts';
  }
  if (hasTarget && (path === 'target' || path.startsWith('target.'))) {
    return 'invalid-target';
  }
  return 'invalid-input';
}

/** Read `input` once through the shared snapshot with the scoped-halt limits. */
function snapshotInput(input: unknown, isProxy: IsProxy): PlainDataSnapshot {
  return snapshotPlainData(input, isProxy, SCOPED_HALT_LIMITS);
}

/**
 * Decide a halt or lift request on its own, without a dispatch target.
 * Reads `input` once through `snapshotPlainData` with `SCOPED_HALT_LIMITS`,
 * then validates the exact key set in `O(own keys), one enumeration` per
 * record. Never throws, never echoes a value or ID. `isProxy` is a required,
 * trusted, side-effect-free detector (in production the `types.isProxy`
 * predicate passed by infrastructure); there is no permissive default — a
 * caller that omits it fails closed, because `snapshotPlainData` refuses a
 * non-function detector and the refusals below are typed refusals.
 */
export function decideHaltRequest(input: unknown, isProxy: IsProxy): ScopedHaltDecision {
  const snapshot = snapshotInput(input, isProxy);
  if (!snapshot.ok) {
    return { ok: false, reason: reasonForSnapshotPath(snapshot.path, false) };
  }
  const root = plainRecordWithOnlyKeys(
    snapshot.value,
    ['actorKind', 'requested', 'halts', 'actorOrganizationId'],
  );
  if (root === null) {
    return { ok: false, reason: 'invalid-input' };
  }
  if (!Object.hasOwn(root, 'actorKind') || !isHaltActorKind(root.actorKind)) {
    return { ok: false, reason: 'invalid-actor' };
  }
  const actorKind: HaltActorKind = root.actorKind;
  let actorOrganizationId: string | undefined;
  if (actorKind === 'org-admin') {
    if (!isNonEmptyTrimmedString(root.actorOrganizationId)) {
      return { ok: false, reason: 'invalid-actor-organization' };
    }
    actorOrganizationId = root.actorOrganizationId;
  } else if (Object.hasOwn(root, 'actorOrganizationId')) {
    return { ok: false, reason: 'invalid-actor-organization' };
  }
  if (!Object.hasOwn(root, 'requested')) {
    return { ok: false, reason: 'invalid-request' };
  }
  const requested = plainRecordWithOnlyKeys(root.requested, ['scope', 'halted', 'id', 'confirmGlobalLift']);
  if (
    requested === null ||
    !Object.hasOwn(requested, 'scope') ||
    !Object.hasOwn(requested, 'halted') ||
    typeof requested.halted !== 'boolean' ||
    (Object.hasOwn(requested, 'confirmGlobalLift') && typeof requested.confirmGlobalLift !== 'boolean') ||
    !validateScopeId(requested.scope, requested.id, Object.hasOwn(requested, 'id'))
  ) {
    return { ok: false, reason: 'invalid-request' };
  }
  if (!Object.hasOwn(root, 'halts')) {
    return { ok: false, reason: 'invalid-halts' };
  }
  const haltsCheck = validateHalts(root.halts);
  if (!haltsCheck.ok) {
    return { ok: false, reason: 'invalid-halts' };
  }
  const permission = decidePermission(
    actorKind,
    actorOrganizationId,
    {
      scope: requested.scope as HaltScope,
      id: requested.id as string,
      halted: requested.halted,
      confirmGlobalLift: requested.confirmGlobalLift === true,
    },
    haltsCheck.entries,
  );
  if (!permission.permitted) {
    return { ok: false, reason: permission.reason };
  }
  const scope = requested.scope as HaltScope;
  return {
    ok: true,
    scope,
    ...(scope === 'global' ? {} : { id: requested.id as string }),
    halted: requested.halted,
    imposedBy: actorKind,
  };
}

/**
 * Decide whether a dispatch target is blocked by any valid halt record.
 * Reads `halts` and `target` once each through `snapshotPlainData` and is
 * fail-closed: every malformed or hostile read — a snapshot refusal, a
 * non-array, more than `MAX_SCOPED_HALTS` entries, a sparse hole, a
 * malformed entry or target, an own `__proto__` key, a missing required or
 * an extra unknown key — answers `true` (halted), never a pass. `isProxy` is
 * a required trusted detector: an omitted or non-function detector refuses
 * the snapshot, which fails closed to `true`.
 */
export function isDispatchHalted(halts: unknown, target: unknown, isProxy: IsProxy): boolean {
  const haltsSnapshot = snapshotPlainData(halts, isProxy, SCOPED_HALT_LIMITS);
  if (!haltsSnapshot.ok) {
    return true;
  }
  const targetSnapshot = snapshotPlainData(target, isProxy, SCOPED_HALT_LIMITS);
  if (!targetSnapshot.ok) {
    return true;
  }
  const entriesCheck = validateHalts(haltsSnapshot.value);
  if (!entriesCheck.ok) {
    return true;
  }
  const targetCheck = validateTarget(targetSnapshot.value);
  if (!targetCheck.ok) {
    return true;
  }
  return evaluateDispatchHalted(entriesCheck.entries, targetCheck.target);
}

/**
 * Decide the halt request and the current dispatch state in one read of the
 * combined input `{ actorKind, actorOrganizationId?, requested, halts,
 * target }`. Reads `input` once through `snapshotPlainData`. Fail-closed:
 * any snapshot refusal or an invalid `halts` or `target` reports
 * `dispatchHalted: true`; once every read is clean, a request refusal
 * reports the evaluated dispatch state instead of assuming one.
 */
export function decideScopedHalt(input: unknown, isProxy: IsProxy): ScopedHaltWithDispatchDecision {
  const snapshot = snapshotInput(input, isProxy);
  if (!snapshot.ok) {
    return { ok: false, reason: reasonForSnapshotPath(snapshot.path, true), dispatchHalted: true };
  }
  const root = plainRecordWithOnlyKeys(
    snapshot.value,
    ['actorKind', 'requested', 'halts', 'target', 'actorOrganizationId'],
  );
  if (root === null) {
    return { ok: false, reason: 'invalid-input', dispatchHalted: true };
  }
  if (!Object.hasOwn(root, 'actorKind') || !isHaltActorKind(root.actorKind)) {
    return { ok: false, reason: 'invalid-actor', dispatchHalted: true };
  }
  const actorKind: HaltActorKind = root.actorKind;
  let actorOrganizationId: string | undefined;
  if (actorKind === 'org-admin') {
    if (!isNonEmptyTrimmedString(root.actorOrganizationId)) {
      return { ok: false, reason: 'invalid-actor-organization', dispatchHalted: true };
    }
    actorOrganizationId = root.actorOrganizationId;
  } else if (Object.hasOwn(root, 'actorOrganizationId')) {
    return { ok: false, reason: 'invalid-actor-organization', dispatchHalted: true };
  }
  if (!Object.hasOwn(root, 'requested')) {
    return { ok: false, reason: 'invalid-request', dispatchHalted: true };
  }
  const requested = plainRecordWithOnlyKeys(root.requested, ['scope', 'halted', 'id', 'confirmGlobalLift']);
  if (
    requested === null ||
    !Object.hasOwn(requested, 'scope') ||
    !Object.hasOwn(requested, 'halted') ||
    typeof requested.halted !== 'boolean' ||
    (Object.hasOwn(requested, 'confirmGlobalLift') && typeof requested.confirmGlobalLift !== 'boolean') ||
    !validateScopeId(requested.scope, requested.id, Object.hasOwn(requested, 'id'))
  ) {
    return { ok: false, reason: 'invalid-request', dispatchHalted: true };
  }
  if (!Object.hasOwn(root, 'halts')) {
    return { ok: false, reason: 'invalid-halts', dispatchHalted: true };
  }
  if (!Object.hasOwn(root, 'target')) {
    return { ok: false, reason: 'invalid-target', dispatchHalted: true };
  }
  const haltsCheck = validateHalts(root.halts);
  const targetCheck = validateTarget(root.target);
  if (!haltsCheck.ok) {
    return { ok: false, reason: 'invalid-halts', dispatchHalted: true };
  }
  if (!targetCheck.ok) {
    return { ok: false, reason: 'invalid-target', dispatchHalted: true };
  }
  const dispatchHalted = evaluateDispatchHalted(haltsCheck.entries, targetCheck.target);
  const permission = decidePermission(
    actorKind,
    actorOrganizationId,
    {
      scope: requested.scope as HaltScope,
      id: requested.id as string,
      halted: requested.halted,
      confirmGlobalLift: requested.confirmGlobalLift === true,
    },
    haltsCheck.entries,
  );
  if (!permission.permitted) {
    return { ok: false, reason: permission.reason, dispatchHalted };
  }
  const scope = requested.scope as HaltScope;
  return {
    ok: true,
    requestDecision: {
      scope,
      ...(scope === 'global' ? {} : { id: requested.id as string }),
      halted: requested.halted,
      imposedBy: actorKind,
    },
    dispatchHalted,
  };
}
