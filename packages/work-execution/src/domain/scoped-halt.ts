/**
 * FC17.7 / FC-R89 — the scoped halt decider for org, cell and global halts.
 *
 * Pure domain code: every function takes `unknown`, reads each untrusted
 * value exactly once through `snapshotPlainData` from `@fleet/shared` with
 * the explicit `SCOPED_HALT_LIMITS` bounds, never throws, never reads a
 * clock, and never echoes an input value or identifier into a refusal. The
 * snapshot copy (a frozen plain-data value) is then validated by a single
 * own-keys enumeration, so no hand-rolled reflection on untrusted input is
 * needed here and the hostile-input ratchet stays flat.
 *
 * `isProxy` is a required parameter on every export, never defaulted: a
 * missing detector would let a Proxy fabricate a non-halted state, so
 * infrastructure callers pass `types.isProxy`.
 */

import { snapshotPlainData, type IsProxy, type PlainDataLimits, type PlainDataSnapshot } from '@fleet/shared';

/** The most halt entries a single request or dispatch check may carry. */
export const MAX_SCOPED_HALTS = 1000;

/**
 * Snapshot bounds for one scoped-halt input: 1 root + 1 request + 1 optional
 * target + an array of at most 1000 entries of at most 4 fields is at most
 * about 5000 entry nodes plus root/request/target overhead, so `maxNodes`
 * 6000 covers the whole shape; anything deeper than 6 levels is malformed
 * input for this decider and is refused by the snapshot itself.
 */
export const SCOPED_HALT_LIMITS: PlainDataLimits = Object.freeze({
  maxDepth: 6,
  maxKeys: 16,
  maxArrayLength: MAX_SCOPED_HALTS,
  maxNodes: 6000,
  maxStringLength: 1024,
});

/** The scopes a halt can apply to. */
export const HALT_SCOPES = ['org', 'cell', 'global'] as const;
// Frozen so runtime consumers cannot append undeclared scopes that the
// decider would then accept as known.
Object.freeze(HALT_SCOPES);

export type HaltScope = (typeof HALT_SCOPES)[number];

/** The actor kinds that may impose or lift a scoped halt. */
export const HALT_ACTOR_KINDS = ['org-admin', 'operator'] as const;
Object.freeze(HALT_ACTOR_KINDS);

export type HaltActorKind = (typeof HALT_ACTOR_KINDS)[number];

/** One recorded halt state for one scope and (for org and cell) one id. */
export interface ScopedHaltEntry {
  readonly scope: HaltScope;
  readonly id?: string;
  readonly halted: boolean;
  readonly imposedBy: HaltActorKind;
}

/** The org and cell a dispatch would run in. */
export interface ScopedHaltTarget {
  readonly organizationId: string;
  readonly cellId: string;
}

/** What the actor asks for. */
export interface ScopedHaltRequest {
  readonly scope: HaltScope;
  readonly id?: string;
  readonly halted: boolean;
  readonly confirmGlobalLift?: boolean;
}

export type ScopedHaltRefusalReason =
  | 'invalid-input'
  | 'invalid-actor'
  | 'invalid-actor-organization'
  | 'invalid-request'
  | 'invalid-halts'
  | 'invalid-target'
  | 'not-permitted'
  | 'global-lift-confirmation-required';

/** The decision of `decideHaltRequest`: a permit, or one typed refusal. */
export type HaltRequestDecision =
  | {
      readonly ok: true;
      readonly scope: HaltScope;
      readonly id?: string;
      readonly halted: boolean;
      readonly imposedBy: HaltActorKind;
    }
  | { readonly ok: false; readonly reason: ScopedHaltRefusalReason };

/** The decision of `decideScopedHalt`: the request decision plus whether dispatch is currently halted. */
export type ScopedHaltDecision =
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
  | { readonly ok: false; readonly reason: ScopedHaltRefusalReason; readonly dispatchHalted: boolean };

const ROOT_KEYS: readonly string[] = ['actorKind', 'actorOrganizationId', 'requested', 'halts'];
const ROOT_KEYS_WITH_TARGET: readonly string[] = [...ROOT_KEYS, 'target'];
const REQUEST_KEYS: readonly string[] = ['scope', 'id', 'halted', 'confirmGlobalLift'];
const ENTRY_KEYS: readonly string[] = ['scope', 'id', 'halted', 'imposedBy'];
const TARGET_KEYS: readonly string[] = ['organizationId', 'cellId'];

// Fresh refusal per failure path: a shared mutable instance could be
// reassigned by a caller and poison later refusals.
function refuse(reason: ScopedHaltRefusalReason): { ok: false; reason: ScopedHaltRefusalReason } {
  return { ok: false, reason };
}

/** The fixed path-to-reason mapping for a snapshot refusal (one reason per path). */
function reasonForPath(path: string | null): ScopedHaltRefusalReason {
  if (path === null) {
    return 'invalid-input';
  }
  if (path === 'actorKind' || path.startsWith('actorKind.')) {
    return 'invalid-actor';
  }
  if (path === 'actorOrganizationId' || path.startsWith('actorOrganizationId.')) {
    return 'invalid-actor-organization';
  }
  if (path === 'requested' || path.startsWith('requested.')) {
    return 'invalid-request';
  }
  if (path === 'halts' || path.startsWith('halts[')) {
    return 'invalid-halts';
  }
  if (path === 'target' || path.startsWith('target.')) {
    return 'invalid-target';
  }
  return 'invalid-input';
}

/** True when the string is non-empty and has no leading or trailing whitespace. */
function isTrimmedNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function isHaltScope(value: unknown): value is HaltScope {
  return typeof value === 'string' && (HALT_SCOPES as readonly string[]).includes(value);
}

function isActorKind(value: unknown): value is HaltActorKind {
  return typeof value === 'string' && (HALT_ACTOR_KINDS as readonly string[]).includes(value);
}

/**
 * A plain record from a snapshot copy with only allowed own keys. The value
 * here is the frozen plain-data copy produced by `snapshotPlainData`, so one
 * `Object.keys` enumeration sees every own enumerable string key it has;
 * non-enumerable, symbol and accessor keys can never reach this point.
 */
function readAllowedRecord(value: unknown, allowed: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const keys = Object.keys(value as Record<string, unknown>);
  for (const key of keys) {
    if (!allowed.includes(key)) {
      return null;
    }
  }
  const record = value as Record<string, unknown>;
  // The snapshot copies an own `__proto__` key as data; it is never allowed.
  if (Object.hasOwn(record, '__proto__')) {
    return null;
  }
  return record;
}

function readTargetRecord(value: unknown): ScopedHaltTarget | null {
  const record = readAllowedRecord(value, TARGET_KEYS);
  if (record === null) {
    return null;
  }
  for (const key of TARGET_KEYS) {
    if (!Object.hasOwn(record, key) || !isTrimmedNonEmpty(record[key])) {
      return null;
    }
  }
  return { organizationId: record['organizationId'] as string, cellId: record['cellId'] as string };
}

function readEntryRecord(value: unknown): ScopedHaltEntry | null {
  const record = readAllowedRecord(value, ENTRY_KEYS);
  if (record === null) {
    return null;
  }
  const scope = record['scope'];
  if (!isHaltScope(scope)) {
    return null;
  }
  if (typeof record['halted'] !== 'boolean') {
    return null;
  }
  const imposedBy = record['imposedBy'];
  if (!isActorKind(imposedBy)) {
    return null;
  }
  if (scope === 'global') {
    if (Object.hasOwn(record, 'id')) {
      return null;
    }
    return { scope, halted: record['halted'], imposedBy };
  }
  if (!Object.hasOwn(record, 'id') || !isTrimmedNonEmpty(record['id'])) {
    return null;
  }
  return { scope, id: record['id'] as string, halted: record['halted'], imposedBy };
}

/** The parsed and validated fields of one root input. */
type ParsedRoot =
  | {
      readonly ok: true;
      readonly actorKind: HaltActorKind;
      readonly actorOrganizationId?: string;
      readonly scope: HaltScope;
      readonly id?: string;
      readonly halted: boolean;
      readonly confirmGlobalLift?: boolean;
      readonly halts: readonly ScopedHaltEntry[];
    }
  | { readonly ok: false; readonly reason: ScopedHaltRefusalReason };

/**
 * Validates actor, actorOrganizationId, requested and halts (plus target when
 * `withTarget`) in that fixed order, so a missing root key always takes its
 * own field's reason.
 */
function parseRootFields(root: Record<string, unknown>, withTarget: boolean): ParsedRoot {
  if (!Object.hasOwn(root, 'actorKind')) {
    return { ok: false, reason: 'invalid-actor' };
  }
  const actorKind = root['actorKind'];
  if (!isActorKind(actorKind)) {
    return { ok: false, reason: 'invalid-actor' };
  }
  let actorOrganizationId: string | undefined;
  if (Object.hasOwn(root, 'actorOrganizationId')) {
    if (actorKind !== 'org-admin' || !isTrimmedNonEmpty(root['actorOrganizationId'])) {
      return { ok: false, reason: 'invalid-actor-organization' };
    }
    actorOrganizationId = root['actorOrganizationId'] as string;
  } else if (actorKind === 'org-admin') {
    return { ok: false, reason: 'invalid-actor-organization' };
  }
  if (!Object.hasOwn(root, 'requested')) {
    return { ok: false, reason: 'invalid-request' };
  }
  const requested = readAllowedRecord(root['requested'], REQUEST_KEYS);
  if (requested === null) {
    return { ok: false, reason: 'invalid-request' };
  }
  const scope = requested['scope'];
  if (!isHaltScope(scope)) {
    return { ok: false, reason: 'invalid-request' };
  }
  if (typeof requested['halted'] !== 'boolean') {
    return { ok: false, reason: 'invalid-request' };
  }
  let id: string | undefined;
  if (scope === 'global') {
    if (Object.hasOwn(requested, 'id')) {
      return { ok: false, reason: 'invalid-request' };
    }
  } else {
    if (!Object.hasOwn(requested, 'id') || !isTrimmedNonEmpty(requested['id'])) {
      return { ok: false, reason: 'invalid-request' };
    }
    id = requested['id'] as string;
  }
  let confirmGlobalLift: boolean | undefined;
  if (Object.hasOwn(requested, 'confirmGlobalLift')) {
    if (typeof requested['confirmGlobalLift'] !== 'boolean') {
      return { ok: false, reason: 'invalid-request' };
    }
    confirmGlobalLift = requested['confirmGlobalLift'] as boolean;
  }
  if (!Object.hasOwn(root, 'halts')) {
    return { ok: false, reason: 'invalid-halts' };
  }
  const haltsRaw = root['halts'];
  if (!Array.isArray(haltsRaw)) {
    return { ok: false, reason: 'invalid-halts' };
  }
  const halts: ScopedHaltEntry[] = [];
  for (const entry of haltsRaw) {
    const parsedEntry = readEntryRecord(entry);
    if (parsedEntry === null) {
      return { ok: false, reason: 'invalid-halts' };
    }
    halts.push(parsedEntry);
  }
  if (withTarget) {
    if (!Object.hasOwn(root, 'target')) {
      return { ok: false, reason: 'invalid-target' };
    }
    if (readTargetRecord(root['target']) === null) {
      return { ok: false, reason: 'invalid-target' };
    }
  }
  return {
    ok: true,
    actorKind,
    actorOrganizationId,
    scope,
    id,
    halted: requested['halted'] as boolean,
    confirmGlobalLift,
    halts,
  };
}

/** The permission rules: who may halt or lift which scope. */
function permitted(
  actorKind: HaltActorKind,
  actorOrganizationId: string | undefined,
  scope: HaltScope,
  id: string | undefined,
  halted: boolean,
  confirmGlobalLift: boolean | undefined,
  halts: readonly ScopedHaltEntry[],
): { ok: true } | { ok: false; reason: 'not-permitted' | 'global-lift-confirmation-required' } {
  if (actorKind === 'org-admin') {
    if (scope !== 'org' || id !== actorOrganizationId) {
      return { ok: false, reason: 'not-permitted' };
    }
    if (!halted) {
      // Lifting is refused when an operator imposed the active org halt.
      for (const entry of halts) {
        if (entry.scope === 'org' && entry.id === actorOrganizationId && entry.halted && entry.imposedBy === 'operator') {
          return { ok: false, reason: 'not-permitted' };
        }
      }
    }
    return { ok: true };
  }
  if (scope === 'global' && !halted && confirmGlobalLift !== true) {
    return { ok: false, reason: 'global-lift-confirmation-required' };
  }
  return { ok: true };
}

/** Whether one validated halt entry blocks the validated target. */
function entryBlocksTarget(entry: ScopedHaltEntry, target: ScopedHaltTarget): boolean {
  if (!entry.halted) {
    return false;
  }
  if (entry.scope === 'global') {
    return true;
  }
  // An org halt never blocks another org.
  if (entry.scope === 'org') {
    return entry.id === target.organizationId;
  }
  return entry.id === target.cellId;
}

/**
 * Whether dispatch is halted for the target under the recorded halts.
 * Fail closed: every refusal, malformed halts array or malformed target
 * reads as halted. Duplicate or contradictory entries for one scope resolve
 * to halted when any entry says `halted: true`.
 */
export function isDispatchHalted(halts: unknown, target: unknown, isProxy: IsProxy): boolean {
  const haltsSnapshot: PlainDataSnapshot = snapshotPlainData(halts, isProxy, SCOPED_HALT_LIMITS);
  if (!haltsSnapshot.ok) {
    return true;
  }
  const targetSnapshot: PlainDataSnapshot = snapshotPlainData(target, isProxy, SCOPED_HALT_LIMITS);
  if (!targetSnapshot.ok) {
    return true;
  }
  if (!Array.isArray(haltsSnapshot.value)) {
    return true;
  }
  const validatedTarget = readTargetRecord(targetSnapshot.value);
  if (validatedTarget === null) {
    return true;
  }
  let halted = false;
  for (const entry of haltsSnapshot.value) {
    const parsedEntry = readEntryRecord(entry);
    if (parsedEntry === null) {
      return true;
    }
    if (entryBlocksTarget(parsedEntry, validatedTarget)) {
      halted = true;
    }
  }
  return halted;
}

/**
 * Decides one halt or lift request against the permission rules. Reads the
 * untrusted input exactly once through the snapshot; every failure is a
 * typed reason and no input value or id is ever echoed.
 */
export function decideHaltRequest(input: unknown, isProxy: IsProxy): HaltRequestDecision {
  const snapshot: PlainDataSnapshot = snapshotPlainData(input, isProxy, SCOPED_HALT_LIMITS);
  if (!snapshot.ok) {
    return refuse(reasonForPath(snapshot.path));
  }
  const root = readAllowedRecord(snapshot.value, ROOT_KEYS);
  if (root === null) {
    return refuse('invalid-input');
  }
  const parsed = parseRootFields(root, false);
  if (!parsed.ok) {
    return refuse(parsed.reason);
  }
  const permit = permitted(parsed.actorKind, parsed.actorOrganizationId, parsed.scope, parsed.id, parsed.halted, parsed.confirmGlobalLift, parsed.halts);
  if (!permit.ok) {
    return refuse(permit.reason);
  }
  if (parsed.scope === 'global') {
    return { ok: true, scope: parsed.scope, halted: parsed.halted, imposedBy: parsed.actorKind };
  }
  return { ok: true, scope: parsed.scope, id: parsed.id, halted: parsed.halted, imposedBy: parsed.actorKind };
}

/**
 * Decides one halt or lift request and reports whether dispatch is currently
 * halted for the target. Fail closed: any snapshot refusal or malformed
 * `halts`/`target` reports `dispatchHalted: true`; with valid `halts` and
 * `target`, every other refusal carries the evaluated dispatch state.
 */
export function decideScopedHalt(input: unknown, isProxy: IsProxy): ScopedHaltDecision {
  const snapshot: PlainDataSnapshot = snapshotPlainData(input, isProxy, SCOPED_HALT_LIMITS);
  if (!snapshot.ok) {
    return { ok: false, reason: reasonForPath(snapshot.path), dispatchHalted: true };
  }
  const root = readAllowedRecord(snapshot.value, ROOT_KEYS_WITH_TARGET);
  if (root === null) {
    return { ok: false, reason: 'invalid-input', dispatchHalted: true };
  }
  const parsed = parseRootFields(root, true);
  if (!parsed.ok) {
    const structural = parsed.reason === 'invalid-halts' || parsed.reason === 'invalid-target';
    return {
      ok: false,
      reason: parsed.reason,
      dispatchHalted: structural ? true : isDispatchHalted(root['halts'], root['target'], isProxy),
    };
  }
  const permit = permitted(parsed.actorKind, parsed.actorOrganizationId, parsed.scope, parsed.id, parsed.halted, parsed.confirmGlobalLift, parsed.halts);
  const dispatchHalted = isDispatchHalted(root['halts'], root['target'], isProxy);
  if (!permit.ok) {
    return { ok: false, reason: permit.reason, dispatchHalted };
  }
  const requestDecision =
    parsed.scope === 'global'
      ? { scope: parsed.scope, halted: parsed.halted, imposedBy: parsed.actorKind }
      : { scope: parsed.scope, id: parsed.id, halted: parsed.halted, imposedBy: parsed.actorKind };
  return { ok: true, requestDecision, dispatchHalted };
}
