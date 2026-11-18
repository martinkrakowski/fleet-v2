/**
 * Coordination records are the pure domain facts shared by more than one
 * contract: the persisted profile, the aggregate's request snapshot and its
 * child receipts, and the bounded attention summary. They are plain
 * serializable data with no behaviour, so they live here rather than in any
 * single port module and never carry credentials, tokens or client content.
 */

import type { CoordinationKindValue } from './value-objects/CoordinationKind.vo.js';
import type { CoordinationStateValue } from './value-objects/CoordinationState.vo.js';

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
  | 'shadow-import-grant-invalid-expiry';

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
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * True only for a plain object (no array, no function, prototype
 * `Object.prototype` or null). Prototype and type checks never read the
 * object's own properties, so no accessor or trap can run here.
 */
function isPlainShadowImportObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  let proto: unknown;
  try {
    proto = Object.getPrototypeOf(value);
  } catch {
    return false;
  }
  return proto === Object.prototype || proto === null;
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
export function parseShadowImportGrant(raw: unknown): ShadowImportGrantCheck {
  if (!isPlainShadowImportObject(raw)) {
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
  const repositoryRaw = outer.values.repository;
  if (!isPlainShadowImportObject(repositoryRaw)) {
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
  const expiresAtIso = outer.values.expiresAtIso;
  if (
    typeof expiresAtIso !== 'string' ||
    expiresAtIso.length === 0 ||
    expiresAtIso.length > MAX_EXPIRES_AT_ISO_LENGTH ||
    !SHADOW_IMPORT_EXPIRES_AT_PATTERN.test(expiresAtIso) ||
    !Number.isFinite(Date.parse(expiresAtIso))
  ) {
    return { ok: false, code: 'shadow-import-grant-invalid-expiry' };
  }
  return {
    ok: true,
    value: Object.freeze({
      repository: Object.freeze({ owner, repo }),
      expiresAtIso,
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
   * The standing shadow import grant's coordinates (owner decision
   * 2026-11-18); only a `merge:import-shadow` request carries one, and it is
   * required there. Bound to the request id by a digest of its coordinates.
   */
  readonly shadowImportGrant?: ShadowImportGrantRecord;
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
