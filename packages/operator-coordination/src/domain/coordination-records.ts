/**
 * Coordination records are the pure domain facts shared by more than one
 * contract: the persisted profile, the aggregate's request snapshot and its
 * child receipts, and the bounded attention summary. They are plain
 * serializable data with no behaviour, so they live here rather than in any
 * single port module and never carry credentials, tokens or client content.
 */

import type { CoordinationKindValue } from './value-objects/CoordinationKind.vo.js';
import type { CoordinationStateValue } from './value-objects/CoordinationState.vo.js';
import {
  MERGE_GRANT_FORGE_KINDS,
  POLICY_GRANT_SOURCE_FOR_KIND,
  parsePolicyDecisionRevision,
  policyGrantForgeKindOf,
} from './policy-grants.js';

/**
 * One clone of a project's repository on an installation host. `path` is the
 * clone directory; `worktreeRoot` is the directory holding the clone's
 * worktrees, and must lie outside the clone itself.
 */
export interface ProjectCloneRecord {
  readonly path: string;
  readonly worktreeRoot: string;
}

/** Outcome of one probe check: verified, failed, or not exercised. */
export type ProjectProbeResult = 'pass' | 'fail' | 'unknown';

/**
 * One named check in a probe receipt. `host` is the host the check ran on, or
 * null when the check is not host-specific; `detail` carries human-readable
 * evidence and never a credential, token or secret value.
 */
export interface ProjectProbeCheckRecord {
  readonly name: string;
  readonly host: string | null;
  readonly result: ProjectProbeResult;
  readonly detail: string;
}

/**
 * One project's generator state, read from files only. `state` is fleet-v2's
 * own vocabulary; a version the project does not state is null. Never a
 * credential, a path or a URL.
 */
export type ProjectGeneratorStateValue =
  | 'provisioned'
  | 'provisioned-legacy'
  | 'adopting'
  | 'none';

export interface ProjectGeneratorStateRecord {
  readonly state: ProjectGeneratorStateValue;
  readonly generatorVersion: string | null;
  readonly pinnedVersion: string | null;
}

/** Durable receipt proving a project was probed at a point in time. */
export interface ProjectProbeReceiptRecord {
  readonly probedAtIso: string;
  readonly probedFrom: string;
  readonly checks: readonly ProjectProbeCheckRecord[];
  /** The project's generator state; absent when the probe did not read it. */
  readonly generatorState?: ProjectGeneratorStateRecord;
}

/**
 * Private installation references for one project. It names the designated
 * dispatcher host and the approved policy revision; it never stores a
 * credential, token or secret value.
 */
export interface ProjectProfileRecord {
  readonly projectId: string;
  readonly displayName: string;
  readonly repository: string;
  readonly designatedDispatcherHost: string;
  readonly policyRevision: string;
  readonly maxConcurrentLanes: number;
  readonly runnerCapabilities: Readonly<Record<string, boolean | string>>;
  readonly revision: number;
  readonly updatedAtIso: string;
  readonly status: 'active' | 'retired';
  readonly defaultBranch: string | null;
  readonly clones: Readonly<Record<string, ProjectCloneRecord>>;
  readonly gateProcedures: readonly string[];
  readonly defaultAllowedPathPrefixes: readonly string[];
  readonly lastProbe: ProjectProbeReceiptRecord | null;
}

/**
 * Input shape accepted by `ProjectProfile.fromRecord`. The six fields added in
 * profile v2 are optional here because records written before this lane lack
 * them; the entity fills defaults for a missing field.
 */
export type ProjectProfileInput = Omit<
  ProjectProfileRecord,
  | 'status'
  | 'defaultBranch'
  | 'clones'
  | 'gateProcedures'
  | 'defaultAllowedPathPrefixes'
  | 'lastProbe'
> &
  Partial<
    Pick<
      ProjectProfileRecord,
      | 'status'
      | 'defaultBranch'
      | 'clones'
      | 'gateProcedures'
      | 'defaultAllowedPathPrefixes'
      | 'lastProbe'
    >
  >;

/**
 * Durable receipt binding one grant to one action id and attempt. A second,
 * unrelated action never reuses a recorded consumption.
 */
export interface AuthorizationConsumptionRecord {
  readonly consumptionId: string;
  readonly grantId: string;
  readonly requestId: string;
  readonly actionId: string;
  readonly attemptId: string;
  readonly expectedHeadSha: string;
  readonly consumedAtIso: string;
}

/**
 * An actual recipient response with its provenance. Silence and transport
 * delivery are not acknowledgement; only a recorded response is.
 */
export interface RelayAcknowledgementRecord {
  readonly acknowledgementId: string;
  readonly requestId: string;
  readonly recipientId: string;
  readonly responseSummary: string;
  readonly provenance: string;
  readonly acknowledgedAtIso: string;
}

/**
 * The coordinates of a policy grant (auto-merge plan A3): the work order it serves, the attempt whose
 * accepted head it authorises, and the acceptance receipt that made it eligible. Present only on a
 * grant issued from an installation setting; an owner grant never carries it.
 */
export interface PolicyGrantRecord {
  readonly workOrderId: string;
  readonly attemptId: string;
  readonly acceptanceReceiptId: string;
}

/** The repository coordinates of an attempt-less merge grant (DT6b). */
export interface MergeGrantRepositoryRef {
  readonly owner: string;
  readonly repo: string;
}

/**
 * The coordinates of an attempt-less merge grant (DT6b): the repository and pull
 * request it serves. Present only on a merge grant issued from the merge setting;
 * a policy grant (A3) and every other request never carries it.
 */
export interface MergeGrantRecord {
  readonly repository: MergeGrantRepositoryRef;
  readonly pullRequestNumber: number;
}

/**
 * The stored grant record version that records the attempt a grant is bound to (CO24e).
 * A record without `grantRecordVersion` is a legacy grant: it carries no attempt and
 * is bound by scope and exact head only, until it expires.
 */
export const GRANT_RECORD_VERSION = 2 as const;

/**
 * The exact scope of a release grant (cutover row CO14): `release:install`,
 * `release:swap` or `release:rollback`. A release grant is attempt-less by
 * design (CO24g): it is anchored by its scope and exact head and consumed once
 * by its deterministic action id, so it never binds a work attempt. No other
 * `release:*` scope is exempt: an unknown release scope is an owner grant and
 * must bind an attempt like any other.
 */
export const RELEASE_ACTION_SCOPES = ['release:install', 'release:swap', 'release:rollback'] as const;

/** True only for one of the three exact release action scopes; such a grant never binds an attempt. */
export function isReleaseActionScope(actionScope: string): boolean {
  return (RELEASE_ACTION_SCOPES as readonly string[]).includes(actionScope);
}

/**
 * The release root a release grant (CO14, follow-up) is bound to. A grant
 * recorded for root R authorizes only an operation on root R. Pure: bounded
 * absolute path text with no control character and no `..` segment; anything
 * else is not a root coordinate.
 */
export function isReleaseRootCoordinate(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    return false;
  }
  if (!value.startsWith('/') || /[\p{C}]/u.test(value)) {
    return false;
  }
  return !value.split('/').includes('..');
}

/** A release root read from runtime data: absent, a valid coordinate, or invalid (never conflated). */
export type ReleaseRootRead =
  | { readonly state: 'absent' }
  | { readonly state: 'valid'; readonly value: string }
  | { readonly state: 'invalid' };

/**
 * Reads `releaseRoot` from a record through its own property descriptor, so an
 * accessor, a throwing Proxy trap or an inherited value never runs code. A
 * missing or `undefined` field is absent; a valid coordinate is valid; anything
 * else (wrong type, empty, oversized, accessor, hostile) is invalid and must
 * fail closed, never be treated as absent.
 */
export function readReleaseRoot(record: object): ReleaseRootRead {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, 'releaseRoot');
    if (descriptor === undefined) {
      return { state: 'absent' };
    }
    if (!('value' in descriptor)) {
      return { state: 'invalid' };
    }
    if (descriptor.value === undefined) {
      return { state: 'absent' };
    }
    return isReleaseRootCoordinate(descriptor.value)
      ? { state: 'valid', value: descriptor.value }
      : { state: 'invalid' };
  } catch {
    return { state: 'invalid' };
  }
}

/** True when the two reads may authorize one another: both absent, or both valid and equal. */
export function releaseRootsAgree(a: ReleaseRootRead, b: ReleaseRootRead): boolean {
  if (a.state === 'invalid' || b.state === 'invalid') {
    return false;
  }
  return a.state === 'absent' ? b.state === 'absent' : b.state === 'valid' && a.value === b.value;
}

/**
 * The prefix of the request id a release grant is bound by (a digest of its
 * coordinates, RR1). A release record whose id does not start with it carries
 * an unsigned root (pre-RR1) and fails closed on resolve and consumption.
 */
export const RELEASE_GRANT_DIGEST_PREFIX = 'release-grant-' as const;

/**
 * Bounded-input caps for release grant coordinate parsing. Every parser here
 * is linear in these caps and never traverses more than they allow: at most
 * `MAX_RELEASE_GRANT_KEYS` own keys per object (exactly five are accepted)
 * and at most `MAX_RELEASE_ROOT_LENGTH` characters of release root.
 */
export const MAX_RELEASE_ROOT_LENGTH = 4096 as const;
export const MAX_RELEASE_GRANT_KEYS = 5 as const;

/** A release grant's per-request nonce: exactly 32 lowercase hex characters (16 random bytes). */
export function isReleaseNonce(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}

/**
 * Reads `releaseNonce` from a record through its own property descriptor. A
 * missing, accessor or malformed value is `undefined`, so a release record
 * without a valid nonce fails closed at the digest recompute.
 */
export function readReleaseNonce(record: object): string | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, 'releaseNonce');
    if (descriptor === undefined || !('value' in descriptor)) {
      return undefined;
    }
    return isReleaseNonce(descriptor.value) ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/** Every typed way a release grant coordinate read can fail closed. */
export type ReleaseGrantErrorCode =
  | 'release-grant-not-object'
  | 'release-grant-unexpected-key'
  | 'release-grant-accessor-forbidden'
  | 'release-grant-forbidden-key'
  | 'release-grant-invalid-scope'
  | 'release-grant-invalid-project'
  | 'release-grant-invalid-head'
  | 'release-grant-invalid-root'
  | 'release-grant-invalid-nonce'
  | 'release-grant-invalid-input';

/** The outcome of one release grant coordinate read: the coordinates, or a named refusal code. */
export type ReleaseGrantCheck =
  | {
      readonly ok: true;
      readonly value: {
        readonly actionScope: string;
        readonly projectId: string;
        readonly expectedHeadSha: string;
        readonly releaseRoot: string;
        readonly nonce: string;
      };
    }
  | { readonly ok: false; readonly code: ReleaseGrantErrorCode };

const RELEASE_GRANT_KEYS = ['actionScope', 'projectId', 'expectedHeadSha', 'releaseRoot', 'nonce'] as const;
const RELEASE_GRANT_FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'] as const;

/**
 * True only for a plain object (no array, no function, prototype
 * `Object.prototype` or null). Prototype and type checks never read the
 * object's own properties, so no accessor or trap can run here. A revoked
 * Proxy (whose target is gone) can make even `Array.isArray` or
 * `Object.getPrototypeOf` throw; every such throw is a typed refusal, never
 * an exception.
 */
function isPlainReleaseGrantObject(
  value: unknown,
): { readonly ok: true } | { readonly ok: false; readonly code: ReleaseGrantErrorCode } {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, code: 'release-grant-not-object' };
  }
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    return { ok: false, code: 'release-grant-invalid-input' };
  }
  if (isArray) {
    return { ok: false, code: 'release-grant-not-object' };
  }
  let proto: unknown;
  try {
    proto = Object.getPrototypeOf(value);
  } catch {
    return { ok: false, code: 'release-grant-invalid-input' };
  }
  if (proto === Object.prototype || proto === null) {
    return { ok: true };
  }
  return { ok: false, code: 'release-grant-not-object' };
}

type ReleaseGrantSnapshot =
  | { readonly ok: true; readonly keys: string[]; readonly values: Record<string, unknown> }
  | { readonly ok: false; readonly code: ReleaseGrantErrorCode };

/**
 * Snapshot a plain object's own enumerable data properties through their
 * descriptors only. Cost is linear in `MAX_RELEASE_GRANT_KEYS` plus the
 * bounded values copied; accessors are never invoked, symbol keys and
 * non-enumerable data keys are refused, and a prototype-polluting key
 * (`__proto__`, `constructor`, `prototype`) is refused before any key-set
 * comparison so a polluting key can never masquerade as a field.
 */
function readReleaseGrantSnapshot(raw: object): ReleaseGrantSnapshot {
  let ownKeys: PropertyKey[];
  try {
    ownKeys = Reflect.ownKeys(raw);
  } catch {
    return { ok: false, code: 'release-grant-not-object' };
  }
  const keys: string[] = [];
  const values: Record<string, unknown> = {};
  let forbiddenCode: ReleaseGrantErrorCode | undefined;
  // A bounded prefix of `MAX_RELEASE_GRANT_KEYS + 1` keys is inspected, so the
  // cost never grows past the cap; a prototype-polluting key seen inside that
  // prefix is reported before any key-set comparison can mask it.
  for (let index = 0; index < ownKeys.length; index += 1) {
    if (index > MAX_RELEASE_GRANT_KEYS) {
      return { ok: false, code: forbiddenCode ?? 'release-grant-unexpected-key' };
    }
    const key = ownKeys[index];
    if (typeof key !== 'string' || key.length === 0) {
      return { ok: false, code: 'release-grant-unexpected-key' };
    }
    if ((RELEASE_GRANT_FORBIDDEN_KEYS as readonly string[]).includes(key)) {
      forbiddenCode = 'release-grant-forbidden-key';
      continue;
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(raw, key);
    } catch {
      return { ok: false, code: 'release-grant-accessor-forbidden' };
    }
    if (descriptor === undefined) {
      return { ok: false, code: 'release-grant-unexpected-key' };
    }
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      return { ok: false, code: 'release-grant-accessor-forbidden' };
    }
    if (descriptor.enumerable !== true) {
      return { ok: false, code: 'release-grant-unexpected-key' };
    }
    keys.push(key);
    values[key] = descriptor.value;
  }
  if (forbiddenCode !== undefined) {
    return { ok: false, code: forbiddenCode };
  }
  return { ok: true, keys, values };
}

/** A bounded non-empty string of at most 256 characters with no control character. */
function isBoundedTextField(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 256 &&
    !/[\p{C}]/u.test(value)
  );
}

/**
 * Read a release grant's coordinates from hostile runtime data and never
 * throw. Only own data-property descriptors are read (an accessor's getter
 * never runs, a Proxy with a `get` trap is never invoked by it), arrays are
 * refused before any indexing (so a sparse array of length 2**32 - 1 is
 * refused in O(1)), the key set is exactly
 * `['actionScope', 'projectId', 'expectedHeadSha', 'releaseRoot', 'nonce']`, and the
 * fields are bounded: the action scope is one of `RELEASE_ACTION_SCOPES`, the
 * project id and expected head are non-empty trimmed strings of at most 256
 * characters with no control character, and the release root passes
 * `isReleaseRootCoordinate` (at most `MAX_RELEASE_ROOT_LENGTH` characters).
 * Cost is linear in `MAX_RELEASE_GRANT_KEYS * 2 + MAX_RELEASE_ROOT_LENGTH`;
 * nothing else is read.
 */
export function parseReleaseGrantCoordinates(raw: unknown): ReleaseGrantCheck {
  const shape = isPlainReleaseGrantObject(raw);
  if (!shape.ok) {
    return shape;
  }
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, code: 'release-grant-not-object' };
  }
  const snapshot = readReleaseGrantSnapshot(raw);
  if (!snapshot.ok) {
    return snapshot;
  }
  if (
    snapshot.keys.length !== RELEASE_GRANT_KEYS.length ||
    !RELEASE_GRANT_KEYS.every((key) => snapshot.keys.includes(key))
  ) {
    return { ok: false, code: 'release-grant-unexpected-key' };
  }
  const { actionScope, projectId, expectedHeadSha, releaseRoot, nonce } = snapshot.values;
  if (typeof actionScope !== 'string' || !isReleaseActionScope(actionScope)) {
    return { ok: false, code: 'release-grant-invalid-scope' };
  }
  if (!isBoundedTextField(projectId)) {
    return { ok: false, code: 'release-grant-invalid-project' };
  }
  if (!isBoundedTextField(expectedHeadSha)) {
    return { ok: false, code: 'release-grant-invalid-head' };
  }
  if (!isReleaseRootCoordinate(releaseRoot)) {
    return { ok: false, code: 'release-grant-invalid-root' };
  }
  if (!isReleaseNonce(nonce)) {
    return { ok: false, code: 'release-grant-invalid-nonce' };
  }
  return {
    ok: true,
    value: Object.freeze({
      actionScope,
      projectId,
      expectedHeadSha,
      releaseRoot,
      nonce,
    }),
  };
}

/**
 * The canonical digest payload a release grant is bound by: the exact scope,
 * project, expected head, release root and per-request nonce (the CLI
 * generates the nonce for each request), in a frozen key order. The request
 * id carries its digest (computed by the injected dependency, never by this
 * module), so the owner's Ed25519 decision signature — which does not name
 * the release root — still covers it through the request id it approves.
 * Delegates to `parseReleaseGrantCoordinates`, so the cost bound (linear in
 * `MAX_RELEASE_GRANT_KEYS` and `MAX_RELEASE_ROOT_LENGTH`) and the
 * never-throw, never-run-accessors guarantees are the same.
 */
export function releaseGrantDigestPayload(
  raw: unknown,
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly code: ReleaseGrantErrorCode } {
  const parsed = parseReleaseGrantCoordinates(raw);
  if (!parsed.ok) {
    return parsed;
  }
  return {
    ok: true,
    value: JSON.stringify({
      scope: parsed.value.actionScope,
      projectId: parsed.value.projectId,
      expectedHeadSha: parsed.value.expectedHeadSha,
      releaseRoot: parsed.value.releaseRoot,
      nonce: parsed.value.nonce,
    }),
  };
}

/**
 * The exact scope of a standing shadow import grant (owner decision
 * 2026-11-18): the unattended shadow-intake timer authorizes
 * `fleet-v2 merge import --apply` with it. It is a standing owner grant:
 * bounded by the exact repository and a capped expiry, bound to its request
 * by a digest of its own coordinates, revocable and never consumable.
 */
export const SHADOW_IMPORT_ACTION_SCOPE = 'merge:import-shadow' as const;

/** The longest time a shadow import grant may live from its creation instant. */
export const SHADOW_IMPORT_GRANT_MAX_TTL_DAYS = 30 as const;

/** The prefix of the request id a shadow import grant is bound to (a digest of its coordinates). */
export const SHADOW_IMPORT_DIGEST_PREFIX = 'shadow-import-' as const;

/**
 * Bounded-input caps for shadow import grant parsing. Every parser is linear
 * in these caps and never traverses more than they allow: at most
 * `MAX_SHADOW_IMPORT_KEYS` own keys per object, at most
 * `MAX_REPOSITORY_SEGMENT_LENGTH` characters per repository segment and at
 * most `MAX_EXPIRES_AT_ISO_LENGTH` characters of expiry text.
 */
export const MAX_SHADOW_IMPORT_KEYS = 2 as const;
export const MAX_REPOSITORY_SEGMENT_LENGTH = 100 as const;
export const MAX_EXPIRES_AT_ISO_LENGTH = 64 as const;

/** Every typed way a shadow import grant read can fail closed. */
export type ShadowImportGrantErrorCode =
  | 'shadow-import-grant-not-object'
  | 'shadow-import-grant-unexpected-key'
  | 'shadow-import-grant-accessor-forbidden'
  | 'shadow-import-grant-forbidden-key'
  | 'shadow-import-grant-invalid-repository'
  | 'shadow-import-grant-invalid-expiry'
  | 'shadow-import-grant-invalid-input';

/** The outcome of one shadow import grant read: the normalized grant, or a named refusal code. */
export type ShadowImportGrantCheck =
  | { readonly ok: true; readonly value: ShadowImportGrantRecord }
  | { readonly ok: false; readonly code: ShadowImportGrantErrorCode };

/**
 * The standing coordinates of a shadow import grant: the exact repository it
 * serves and the instant it stops being valid. Never a credential or secret.
 */
export interface ShadowImportGrantRecord {
  readonly repository: MergeGrantRepositoryRef;
  readonly expiresAtIso: string;
}

/** True only for the exact shadow import scope; any other scope is not a shadow import. */
export function isShadowImportActionScope(actionScope: string): boolean {
  return actionScope === SHADOW_IMPORT_ACTION_SCOPE;
}

const SHADOW_IMPORT_FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'] as const;
const SHADOW_IMPORT_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const SHADOW_IMPORT_EXPIRES_AT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

/**
 * True only for a plain object (no array, no function, prototype
 * `Object.prototype` or null). Prototype and type checks never read the
 * object's own properties, so no accessor or trap can run here. A revoked
 * Proxy (whose target is gone) can make even `Array.isArray` or
 * `Object.getPrototypeOf` throw; every such throw is a typed refusal, never
 * an exception.
 */
function isPlainShadowImportObject(
  value: unknown,
): { readonly ok: true } | { readonly ok: false; readonly code: ShadowImportGrantErrorCode } {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, code: 'shadow-import-grant-not-object' };
  }
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    return { ok: false, code: 'shadow-import-grant-invalid-input' };
  }
  if (isArray) {
    return { ok: false, code: 'shadow-import-grant-not-object' };
  }
  let proto: unknown;
  try {
    proto = Object.getPrototypeOf(value);
  } catch {
    return { ok: false, code: 'shadow-import-grant-invalid-input' };
  }
  if (proto === Object.prototype || proto === null) {
    return { ok: true };
  }
  return { ok: false, code: 'shadow-import-grant-not-object' };
}

/** Every calendar month's day count; February is leap-corrected at call time. */
const CALENDAR_MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function daysInCalendarMonth(year: number, month: number): number {
  const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  if (month === 2 && isLeapYear) {
    return 29;
  }
  return CALENDAR_MONTH_DAYS[month - 1] ?? 0;
}

type ShadowImportSnapshot =
  | { readonly ok: true; readonly keys: string[]; readonly values: Record<string, unknown> }
  | { readonly ok: false; readonly code: ShadowImportGrantErrorCode };

/**
 * Snapshot a plain object's own enumerable data properties through their
 * descriptors only. Cost is linear in `MAX_SHADOW_IMPORT_KEYS` plus the
 * bounded values copied; accessors are never invoked, symbol keys and
 * non-enumerable data keys are refused, and a prototype-polluting key
 * (`__proto__`, `constructor`, `prototype`) is refused before any key-set
 * comparison so a polluting key can never masquerade as a field.
 */
function readShadowImportSnapshot(raw: object): ShadowImportSnapshot {
  let ownKeys: PropertyKey[];
  try {
    ownKeys = Reflect.ownKeys(raw);
  } catch {
    return { ok: false, code: 'shadow-import-grant-not-object' };
  }
  const keys: string[] = [];
  const values: Record<string, unknown> = {};
  let forbiddenCode: ShadowImportGrantErrorCode | undefined;
  // A bounded prefix of `MAX_SHADOW_IMPORT_KEYS + 1` keys is inspected, so the
  // cost never grows past the cap; a prototype-polluting key seen inside that
  // prefix is reported before any key-set comparison can mask it.
  // No capped own-keys helper exists in the repo (follow-up #4v); this loop
  // enumerates all own keys before the cap.
  // key enumeration precedes the cap: tracked as follow-up #4v
  for (let index = 0; index < ownKeys.length; index += 1) {
    if (index > MAX_SHADOW_IMPORT_KEYS) {
      return { ok: false, code: forbiddenCode ?? 'shadow-import-grant-unexpected-key' };
    }
    const key = ownKeys[index];
    if (typeof key !== 'string' || key.length === 0) {
      return { ok: false, code: 'shadow-import-grant-unexpected-key' };
    }
    if ((SHADOW_IMPORT_FORBIDDEN_KEYS as readonly string[]).includes(key)) {
      forbiddenCode = 'shadow-import-grant-forbidden-key';
      continue;
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(raw, key);
    } catch {
      return { ok: false, code: 'shadow-import-grant-accessor-forbidden' };
    }
    if (descriptor === undefined) {
      return { ok: false, code: 'shadow-import-grant-unexpected-key' };
    }
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      return { ok: false, code: 'shadow-import-grant-accessor-forbidden' };
    }
    if (descriptor.enumerable !== true) {
      return { ok: false, code: 'shadow-import-grant-unexpected-key' };
    }
    keys.push(key);
    values[key] = descriptor.value;
  }
  if (forbiddenCode !== undefined) {
    return { ok: false, code: forbiddenCode };
  }
  return { ok: true, keys, values };
}

/**
 * Read a shadow import grant from hostile runtime data and never throw. Only
 * own data-property descriptors are read (an accessor's getter never runs, a
 * Proxy with a `get` trap is never invoked by it), arrays are refused before
 * any indexing (so a sparse array of length 2**32 - 1 is refused in O(1)),
 * the key sets are exact, and the fields are bounded: a repository segment at
 * most `MAX_REPOSITORY_SEGMENT_LENGTH` characters and expiry text at most
 * `MAX_EXPIRES_AT_ISO_LENGTH` characters, ISO-8601 with an explicit `Z` or
 * `±HH:MM` offset and a finite parsed instant. Cost is linear in
 * `MAX_SHADOW_IMPORT_KEYS * 2 + MAX_REPOSITORY_SEGMENT_LENGTH * 2 +
 * MAX_EXPIRES_AT_ISO_LENGTH`; nothing else is read.
 */
/**
 * Validate the `repository` field of a shadow import grant: a plain
 * `{ owner, repo }` object read by own data descriptors, each segment matching
 * `SHADOW_IMPORT_REPOSITORY_PATTERN` and neither `.` nor `..`. Cost is linear
 * in `MAX_SHADOW_IMPORT_KEYS + MAX_REPOSITORY_SEGMENT_LENGTH * 2`; a getter
 * never runs and nothing throws.
 */
function parseShadowImportRepository(
  repositoryRaw: unknown,
): { readonly ok: true; readonly owner: string; readonly repo: string } | { readonly ok: false; readonly code: ShadowImportGrantErrorCode } {
  const repositoryShape = isPlainShadowImportObject(repositoryRaw);
  if (!repositoryShape.ok) {
    return {
      ok: false,
      code:
        repositoryShape.code === 'shadow-import-grant-invalid-input'
          ? 'shadow-import-grant-invalid-input'
          : 'shadow-import-grant-invalid-repository',
    };
  }
  if (typeof repositoryRaw !== 'object' || repositoryRaw === null) {
    return { ok: false, code: 'shadow-import-grant-invalid-repository' };
  }
  const repository = readShadowImportSnapshot(repositoryRaw);
  if (!repository.ok) {
    return repository;
  }
  const repositoryKeys = ['owner', 'repo'];
  if (
    repository.keys.length !== repositoryKeys.length ||
    !repositoryKeys.every((key) => repository.keys.includes(key))
  ) {
    return { ok: false, code: 'shadow-import-grant-invalid-repository' };
  }
  const owner = repository.values.owner;
  const repo = repository.values.repo;
  if (
    typeof owner !== 'string' ||
    !SHADOW_IMPORT_REPOSITORY_PATTERN.test(owner) ||
    owner === '.' ||
    owner === '..'
  ) {
    return { ok: false, code: 'shadow-import-grant-invalid-repository' };
  }
  if (
    typeof repo !== 'string' ||
    !SHADOW_IMPORT_REPOSITORY_PATTERN.test(repo) ||
    repo === '.' ||
    repo === '..'
  ) {
    return { ok: false, code: 'shadow-import-grant-invalid-repository' };
  }
  return { ok: true, owner, repo };
}

/**
 * Validate the `expiresAtIso` field of a shadow import grant: a bounded
 * ISO-8601 string with an explicit `Z` or `±HH:MM` offset, a finite parsed
 * instant, real calendar fields and a canonical re-serialization. Cost is
 * linear in `MAX_EXPIRES_AT_ISO_LENGTH`; nothing throws.
 */
function parseShadowImportExpiry(
  expiresAtIso: unknown,
): { readonly ok: true; readonly expiresAtIso: string } | { readonly ok: false; readonly code: ShadowImportGrantErrorCode } {
  if (
    typeof expiresAtIso !== 'string' ||
    expiresAtIso.length === 0 ||
    expiresAtIso.length > MAX_EXPIRES_AT_ISO_LENGTH
  ) {
    return { ok: false, code: 'shadow-import-grant-invalid-expiry' };
  }
  const expiryMatch = SHADOW_IMPORT_EXPIRES_AT_PATTERN.exec(expiresAtIso);
  if (expiryMatch === null || !Number.isFinite(Date.parse(expiresAtIso))) {
    return { ok: false, code: 'shadow-import-grant-invalid-expiry' };
  }
  // Calendar correctness: `Date.parse` normalizes impossible dates (Feb 30,
  // month 13, hour 24), so each field is range-checked against the real
  // calendar and the parsed instant must re-serialize (`toISOString`) to the
  // input's own canonical form; any mismatch is a refusal.
  const [, year, month, day, hour, minute, second, fraction, offset] = expiryMatch;
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  if (
    monthNumber < 1 ||
    monthNumber > 12 ||
    dayNumber < 1 ||
    dayNumber > daysInCalendarMonth(Number(year), monthNumber) ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  ) {
    return { ok: false, code: 'shadow-import-grant-invalid-expiry' };
  }
  const milliseconds = fraction === undefined ? 0 : Number(fraction.slice(0, 3).padEnd(3, '0'));
  const offsetMinutes =
    offset === 'Z'
      ? 0
      : (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6))) * (offset.startsWith('-') ? -1 : 1);
  const fieldsMs = Date.UTC(
    Number(year),
    monthNumber - 1,
    dayNumber,
    Number(hour),
    Number(minute),
    Number(second),
    milliseconds,
  );
  const instantMs = fieldsMs - offsetMinutes * 60_000;
  // A `Z` expiry is canonical in its own fields; a ±HH:MM expiry is
  // canonicalized to its UTC instant (the fields are already range-checked,
  // so no normalization can move them).
  const canonicalIso =
    offset === 'Z'
      ? `${year}-${month}-${day}T${hour}:${minute}:${second}.${String(milliseconds).padStart(3, '0')}Z`
      : new Date(instantMs).toISOString();
  if (
    !Number.isFinite(instantMs) ||
    instantMs !== Date.parse(expiresAtIso) ||
    new Date(Date.parse(expiresAtIso)).toISOString() !== canonicalIso
  ) {
    return { ok: false, code: 'shadow-import-grant-invalid-expiry' };
  }
  return { ok: true, expiresAtIso };
}

export function parseShadowImportGrant(raw: unknown): ShadowImportGrantCheck {
  const outerShape = isPlainShadowImportObject(raw);
  if (!outerShape.ok) {
    return { ok: false, code: outerShape.code };
  }
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, code: 'shadow-import-grant-not-object' };
  }
  const outer = readShadowImportSnapshot(raw);
  if (!outer.ok) {
    return outer;
  }
  const expectedKeys = ['repository', 'expiresAtIso'];
  if (outer.keys.length !== expectedKeys.length || !expectedKeys.every((key) => outer.keys.includes(key))) {
    return { ok: false, code: 'shadow-import-grant-unexpected-key' };
  }
  const repository = parseShadowImportRepository(outer.values.repository);
  if (!repository.ok) {
    return repository;
  }
  const expiry = parseShadowImportExpiry(outer.values.expiresAtIso);
  if (!expiry.ok) {
    return expiry;
  }
  return {
    ok: true,
    value: Object.freeze({
      repository: Object.freeze({ owner: repository.owner, repo: repository.repo }),
      expiresAtIso: expiry.expiresAtIso,
    }),
  };
}

/** The same bounded, non-throwing grant check under its validation name. */
export function validateShadowImportGrantCheck(raw: unknown): ShadowImportGrantCheck {
  return parseShadowImportGrant(raw);
}

/**
 * The canonical digest payload a shadow import grant is bound by: the exact
 * scope, repository and expiry. The request id carries its digest (computed
 * by the injected dependency, never by this module), so a grant's coordinates
 * are covered even though the signed decision itself does not name them.
 * Delegates to `parseShadowImportGrant`, so the cost bound and the
 * never-throw, never-run-accessors guarantees are the same.
 */
export function shadowImportDigestPayload(
  raw: unknown,
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly code: ShadowImportGrantErrorCode } {
  const parsed = parseShadowImportGrant(raw);
  if (!parsed.ok) {
    return parsed;
  }
  return {
    ok: true,
    value: JSON.stringify({
      scope: SHADOW_IMPORT_ACTION_SCOPE,
      owner: parsed.value.repository.owner,
      repo: parsed.value.repository.repo,
      expiresAtIso: parsed.value.expiresAtIso,
    }),
  };
}

/** Serializable snapshot of the CoordinationRequest aggregate. */
export interface CoordinationRequestRecord {
  readonly id: string;
  readonly projectId: string;
  readonly kind: CoordinationKindValue;
  readonly state: CoordinationStateValue;
  readonly actionScope: string;
  readonly expectedHeadSha: string | null;
  readonly proposalDigest: string;
  readonly policyRevision: string;
  readonly decisionRevision: string | null;
  readonly grantId: string | null;
  readonly consumptions: readonly AuthorizationConsumptionRecord[];
  readonly acknowledgements: readonly RelayAcknowledgementRecord[];
  readonly deliveryStatus: 'delivered' | 'pending' | 'delivery-gap';
  readonly deliveryGapReason: string | null;
  readonly revision: number;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
  /** Present only on a policy grant (A3); absent on every owner grant and every other request. */
  readonly policyGrant?: PolicyGrantRecord;
  /** Present only on an attempt-less merge grant (DT6b); absent everywhere else. */
  readonly mergeGrant?: MergeGrantRecord;
  /** `2` once the record can name the attempt its grant is bound to; absent on a legacy grant. */
  readonly grantRecordVersion?: typeof GRANT_RECORD_VERSION;
  /**
   * The attempt the grant is bound to (CO24e). Written with `grantRecordVersion: 2`: at issue
   * for a policy grant, at request time or first resolve for an owner grant. A version-2 record
   * without it authorizes nothing at consumption.
   */
  readonly grantAttemptId?: string;
  /**
   * The release root the grant is bound to (CO14 follow-up); only a release
   * grant carries one. A resolve or consumption naming another root is
   * refused, so a grant for one root never authorizes another.
   */
  readonly releaseRoot?: string;
  /**
   * The per-request nonce of a release grant (RR1 fix round): 32 lowercase hex
   * characters, digested into the request id so the same coordinates can be
   * requested again after a use, a rollback or a denial. Required on a release
   * record; a missing or malformed one fails the digest recompute closed.
   */
  readonly releaseNonce?: string;
  /**
   * The standing shadow import grant's coordinates (owner decision
   * 2026-11-18); only a `merge:import-shadow` request carries one, and it is
   * required there. Bound to the request id by a digest of its coordinates.
   */
  readonly shadowImportGrant?: ShadowImportGrantRecord;
}

/**
 * True when a record's authorization may only be exercised through a
 * re-verified signed owner decision. The two exemptions are closed by kind,
 * never by a prefix or by the mere presence of a grant field:
 *
 * 1. A policy grant whose `decisionRevision` parses as
 *    `policy:<source>@<12-hex>` and whose `actionScope` is a valid
 *    `forge:<kind>` for that grant kind with `POLICY_GRANT_SOURCE_FOR_KIND[kind]`
 *    equal to the parsed source.
 * 2. An attempt-less merge grant whose `decisionRevision` matches
 *    `policy:merge@<12-hex>` and whose `actionScope` is `forge:<kind>` for one
 *    of `MERGE_GRANT_FORGE_KINDS`.
 *
 * Every other record — `release:*`, `merge:import-shadow`, `owner-decision:*`
 * and any other owner-approved scoped grant, including a record carrying
 * `policyGrant` or `mergeGrant` on an unrelated scope — requires a signed
 * decision. Pure and total: never throws.
 */
export function isSignedDecisionRequired(record: CoordinationRequestRecord): boolean {
  if (record.policyGrant !== undefined) {
    const parsed = parsePolicyDecisionRevision(record.decisionRevision);
    const kind =
      typeof record.actionScope === 'string' ? policyGrantForgeKindOf(record.actionScope) : null;
    if (parsed === null || kind === null || POLICY_GRANT_SOURCE_FOR_KIND[kind] !== parsed.source) {
      return true;
    }
    return false;
  }
  if (record.mergeGrant !== undefined) {
    const MERGE_GRANT_REVISION_PATTERN = /^policy:merge@[0-9a-f]{12}$/;
    const matches =
      typeof record.decisionRevision === 'string' &&
      MERGE_GRANT_REVISION_PATTERN.test(record.decisionRevision) &&
      typeof record.actionScope === 'string' &&
      (MERGE_GRANT_FORGE_KINDS as readonly string[]).some((kind) => record.actionScope === `forge:${kind}`);
    return !matches;
  }
  return true;
}

/** Bounded-input cap for one bound decision field: at most 512 characters. */
export const MAX_DECISION_FIELD_LENGTH = 512 as const;

/** Bounded-input cap for one bound decision object: at most 32 own keys. */
export const MAX_DECISION_OBJECT_KEYS = 32 as const;

/** Every typed way a signed-decision binding read can fail closed. */
export type SignedDecisionBindingErrorCode =
  | 'decision-binding-invalid-input'
  | 'decision-binding-not-approved'
  | 'decision-binding-mismatch';

/** The outcome of one signed-decision binding check: bound, or a named refusal code. */
export type SignedDecisionBindingCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: SignedDecisionBindingErrorCode };

const DECISION_BINDING_FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'] as const;

type DecisionBindingSnapshot =
  | { readonly ok: true; readonly values: Record<string, unknown> }
  | { readonly ok: false };

/**
 * Snapshot one plain object's own data properties through their descriptors.
 * Cost is linear in `MAX_DECISION_OBJECT_KEYS` plus the bounded values copied
 * (`MAX_DECISION_FIELD_LENGTH` per compared field): accessors are never
 * invoked, arrays and sparse/array-like objects are refused, and a
 * prototype-polluting key is refused before any field comparison.
 */
function snapshotDecisionBindingObject(raw: unknown): DecisionBindingSnapshot {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false };
  }
  // Only plain objects are accepted: the prototype must be `Object.prototype`
  // or `null`. A custom-prototype record or answer (a class instance, a
  // `Proxy`-adjacent exotic object, or anything with a `get` trap) is refused
  // before any descriptor is read, so a getter on the prototype can never run.
  // Every reflective read, including `getPrototypeOf` (whose trap a revoked
  // `Proxy` makes throw), runs inside try/catch: a throwing trap yields the
  // same typed refusal as any other invalid input.
  let proto: unknown;
  try {
    proto = Object.getPrototypeOf(raw) as unknown;
  } catch {
    return { ok: false };
  }
  if (proto !== Object.prototype && proto !== null) {
    return { ok: false };
  }
  let isArray: boolean;
  try {
    isArray = Array.isArray(raw);
  } catch {
    return { ok: false };
  }
  if (isArray) {
    return { ok: false };
  }
  let ownKeys: PropertyKey[];
  try {
    ownKeys = Reflect.ownKeys(raw);
  } catch {
    return { ok: false };
  }
  if (ownKeys.length > MAX_DECISION_OBJECT_KEYS) {
    return { ok: false };
  }
  const values: Record<string, unknown> = {};
  for (const key of ownKeys) {
    if (typeof key !== 'string') {
      return { ok: false };
    }
    if ((DECISION_BINDING_FORBIDDEN_KEYS as readonly string[]).includes(key)) {
      return { ok: false };
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(raw, key);
    } catch {
      return { ok: false };
    }
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
      return { ok: false };
    }
    values[key] = descriptor.value;
  }
  return { ok: true, values };
}

/** A bounded non-empty string of at most MAX_DECISION_FIELD_LENGTH characters. */
function isBoundedDecisionField(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_DECISION_FIELD_LENGTH
  );
}

/**
 * Whether the snapshot carries the own key at all: every own data key present
 * on the hostile input is copied into the snapshot, so a key whose value is
 * `null` (or any other non-string) is PRESENT here, never absent. A present
 * identity field must be a bounded non-empty string; absence is the only
 * thing that permits omission.
 */
function snapshotHasOwnKey(values: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(values, key);
}

/**
 * Bind a stored coordination record to one signed owner answer (KEY0c2):
 * both inputs are read as hostile `unknown` data through their own
 * data-property descriptors only — a getter never runs, a `Proxy` `get` trap
 * is never invoked, arrays (including sparse and array-like ones) are refused
 * before any indexing, and a `__proto__`/`constructor`/`prototype` own key is
 * refused before any field comparison — and the function never throws.
 *
 * The binding holds only when the answer is `approved` and every bound field
 * is a bounded non-empty string equal on both sides: the record id against
 * the answer's `requestId` when the answer carries one, the `actionScope`
 * likewise, the `grantId` and the `decisionRevision` (required on both).
 *
 * Cost is linear in the capped input: at most `MAX_DECISION_OBJECT_KEYS * 2`
 * own descriptors plus at most `MAX_DECISION_FIELD_LENGTH` characters per
 * compared field; nothing else is read.
 */
export function verifySignedDecisionBinding(
  recordInput: unknown,
  answerInput: unknown,
): SignedDecisionBindingCheck {
  const record = snapshotDecisionBindingObject(recordInput);
  if (!record.ok) {
    return { ok: false, code: 'decision-binding-invalid-input' };
  }
  const answer = snapshotDecisionBindingObject(answerInput);
  if (!answer.ok) {
    return { ok: false, code: 'decision-binding-invalid-input' };
  }
  if (answer.values['state'] !== 'approved') {
    return { ok: false, code: 'decision-binding-not-approved' };
  }
  // The record id binds every answer; the answer's own requestId, when it
  // carries one, must name the same request. A present field whose value is
  // `null` or any other non-string is refused, never treated as absent.
  if (!isBoundedDecisionField(record.values['id'])) {
    return { ok: false, code: 'decision-binding-mismatch' };
  }
  if (snapshotHasOwnKey(answer.values, 'requestId')) {
    if (
      !isBoundedDecisionField(answer.values['requestId']) ||
      answer.values['requestId'] !== record.values['id']
    ) {
      return { ok: false, code: 'decision-binding-mismatch' };
    }
  }
  if (snapshotHasOwnKey(answer.values, 'actionScope')) {
    if (
      !isBoundedDecisionField(answer.values['actionScope']) ||
      !isBoundedDecisionField(record.values['actionScope']) ||
      answer.values['actionScope'] !== record.values['actionScope']
    ) {
      return { ok: false, code: 'decision-binding-mismatch' };
    }
  }
  if (
    !isBoundedDecisionField(answer.values['grantId']) ||
    !isBoundedDecisionField(record.values['grantId']) ||
    answer.values['grantId'] !== record.values['grantId']
  ) {
    return { ok: false, code: 'decision-binding-mismatch' };
  }
  if (
    !isBoundedDecisionField(answer.values['decisionRevision']) ||
    !isBoundedDecisionField(record.values['decisionRevision']) ||
    answer.values['decisionRevision'] !== record.values['decisionRevision']
  ) {
    return { ok: false, code: 'decision-binding-mismatch' };
  }
  return { ok: true };
}

/** Bounded attention and staleness summary; reading it rewrites nothing. */
export interface ProjectAttentionSummaryRecord {
  readonly projectId: string;
  readonly staleWorkOrderCount: number;
  readonly awaitingDecisionCount: number;
  readonly deliveryGapCount: number;
  readonly summaryText: string;
  readonly observedAtIso: string;
}
