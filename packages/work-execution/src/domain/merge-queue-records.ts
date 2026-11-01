/**
 * Pure records and queue invariants for the daemon merge pass (plan §3.3,
 * §3.5, §3.6, §6). No clock, hashing, or id minting.
 */

import { containsSecretShape } from '@fleet/shared';
import { isZonedIsoDateTime } from './conductor-halt.js';
import { LANE_RUN_JOURNAL_REASON_CODE_PATTERN } from './lane-run-journal.js';
import { REQUEST_ID_PATTERN } from './lane-run-keys.js';
import { LANE_RUN_ID_PATTERN } from './lane-run-records.js';
import { readExactPlainRecord } from './plain-record-reads.js';

export const MERGE_QUEUE_ENTRY_VERSION = 1 as const;

export const MERGE_QUEUE_TIERS = [0, 1, 2] as const;
export type MergeQueueTier = (typeof MERGE_QUEUE_TIERS)[number];

/** The 11 states; verifying precedes vetoing (the decision table runs macOS verify before the veto). */
export const MERGE_QUEUE_ENTRY_STATES = [
  'queued', 'updating', 'awaiting-checks', 'ready', 'verifying', 'vetoing', 'merging',
  'merged', 'parked', 'dropped', 'superseded',
] as const;
export type MergeQueueEntryState = (typeof MERGE_QUEUE_ENTRY_STATES)[number];

export const MERGE_QUEUE_TERMINAL_STATES = ['merged', 'dropped', 'superseded'] as const;
export type MergeQueueTerminalState = (typeof MERGE_QUEUE_TERMINAL_STATES)[number];

export const MERGE_QUEUE_ENQUEUED_BY = ['conductor', 'cli', 'update'] as const;
export type MergeQueueEnqueuedBy = (typeof MERGE_QUEUE_ENQUEUED_BY)[number];

export const MERGE_VERIFIED_BY = ['contexts', 'procedure'] as const;
export type MergeVerifiedBy = (typeof MERGE_VERIFIED_BY)[number];

export const MERGE_VETO_OUTCOMES = ['merge-safe', 'hold-for-human', 'unknown'] as const;
export type MergeVetoOutcome = (typeof MERGE_VETO_OUTCOMES)[number];

/** Policy mode (DT1b); never stored on an entry. */
export const MERGE_VETO_MODES = ['off', 'shadow', 'live'] as const;
export type MergeVetoMode = (typeof MERGE_VETO_MODES)[number];

/** A stored veto is never `off`. */
export const MERGE_RECORDED_VETO_MODES = ['shadow', 'live'] as const;
export type MergeRecordedVetoMode = (typeof MERGE_RECORDED_VETO_MODES)[number];

export const MERGE_PARK_REASONS = [
  'conflict', 'checks', 'threads', 'premerge', 'macos', 'forge-error', 'update-refused',
  'update-churn', 'disjointness', 'veto-hold', 'owner-merge', 'policy-unreadable',
] as const;
export type MergeParkReason = (typeof MERGE_PARK_REASONS)[number];

export const MERGE_DROP_REASONS = [
  'conflict', 'checks', 'macos', 'forge-error-exhausted', 'closed', 'operator-dropped',
] as const;
export type MergeDropReason = (typeof MERGE_DROP_REASONS)[number];

export const MERGE_SHADOW_REASONS = ['would-update-branch', 'would-post-status', 'would-merge'] as const;
export type MergeShadowReason = (typeof MERGE_SHADOW_REASONS)[number];

export interface MergeQueueRepositoryRef {
  readonly owner: string;
  readonly repo: string;
}

export interface MergeQueueVetoRecord {
  readonly outcome: MergeVetoOutcome;
  readonly confidence: number | null;
  readonly mode: MergeRecordedVetoMode;
  readonly decisionReceiptId: string | null;
}

export interface MergeQueueEntryRecord {
  readonly version: typeof MERGE_QUEUE_ENTRY_VERSION;
  readonly entryId: string;
  readonly repository: MergeQueueRepositoryRef;
  readonly repoDigest: string;
  readonly pullRequest: number;
  readonly headOid: string;
  readonly state: MergeQueueEntryState;
  readonly reason: string | null;
  readonly attempt: number;
  readonly notBeforeIso: string | null;
  readonly enqueuedAtIso: string;
  readonly enqueuedBy: MergeQueueEnqueuedBy;
  readonly supersedes: string | null;
  readonly runId: string | null;
  readonly attemptId: string | null;
  readonly workOrderId: string | null;
  readonly tier: MergeQueueTier;
  readonly verifiedHeadOid: string | null;
  readonly verifiedBy: MergeVerifiedBy | null;
  readonly policyRevision: string | null;
  readonly premergeReceiptHeadOid: string | null;
  readonly veto: MergeQueueVetoRecord | null;
  readonly mergeCommitOid: string | null;
  readonly mergedAtIso: string | null;
  readonly revision: number;
}

export type MergeQueueEntryRead =
  | { readonly ok: true; readonly record: MergeQueueEntryRecord }
  | { readonly ok: false; readonly reason: 'unknown-version' | 'malformed'; readonly error: string };

export interface UpdateSuccessorInput {
  readonly entryId: string;
  readonly headOid: string;
  readonly premergeReceiptHeadOid?: string | null;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const HEX40_PATTERN = /^[0-9a-f]{40}$/;
const HEX12_PATTERN = /^[0-9a-f]{12}$/;

export function isMergeHex40(value: unknown): value is string {
  return typeof value === 'string' && HEX40_PATTERN.test(value);
}

export function isMergeHex12(value: unknown): value is string {
  return typeof value === 'string' && HEX12_PATTERN.test(value);
}

const ID_MAX_BYTES = 256;

export function isMergeSafeId(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  if (value.trim().length === 0) {
    return false;
  }
  if (new TextEncoder().encode(value).byteLength > ID_MAX_BYTES) {
    return false;
  }
  return !containsSecretShape(value);
}

const VETO_KEYS: readonly string[] = ['outcome', 'confidence', 'mode', 'decisionReceiptId'];

type MergeQueueVetoRead =
  | { readonly ok: true; readonly veto: MergeQueueVetoRecord | null }
  | { readonly ok: false };

export function readMergeVetoRecord(raw: unknown): MergeQueueVetoRead {
  try {
    if (raw === null) {
      return { ok: true, veto: null };
    }
    const snapshot = readExactPlainRecord(raw, VETO_KEYS);
    if (snapshot === null) {
      return { ok: false };
    }
    if (!MERGE_VETO_OUTCOMES.includes(snapshot.outcome as MergeVetoOutcome)) {
      return { ok: false };
    }
    const confidence = snapshot.confidence;
    if (
      confidence !== null &&
      (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)
    ) {
      return { ok: false };
    }
    if (!MERGE_RECORDED_VETO_MODES.includes(snapshot.mode as MergeRecordedVetoMode)) {
      return { ok: false };
    }
    if (snapshot.decisionReceiptId !== null && !isMergeSafeId(snapshot.decisionReceiptId)) {
      return { ok: false };
    }
    const veto: MergeQueueVetoRecord = Object.freeze({
      outcome: snapshot.outcome as MergeVetoOutcome,
      confidence: confidence as number | null,
      mode: snapshot.mode as MergeRecordedVetoMode,
      decisionReceiptId: snapshot.decisionReceiptId as string | null,
    });
    return { ok: true, veto };
  } catch {
    return { ok: false };
  }
}

const ENTRY_KEYS: readonly string[] = [
  'version', 'entryId', 'repository', 'repoDigest', 'pullRequest', 'headOid', 'state', 'reason',
  'attempt', 'notBeforeIso', 'enqueuedAtIso', 'enqueuedBy', 'supersedes', 'runId', 'attemptId',
  'workOrderId', 'tier', 'verifiedHeadOid', 'verifiedBy', 'policyRevision', 'premergeReceiptHeadOid',
  'veto', 'mergeCommitOid', 'mergedAtIso', 'revision',
];

const LEGACY_ENTRY_KEYS: readonly string[] = ENTRY_KEYS.filter((key) => key !== 'version');

const REPOSITORY_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const ATTEMPT_CAP = 32;

function refusal(reason: 'unknown-version' | 'malformed', error: string): MergeQueueEntryRead {
  return { ok: false, reason, error };
}

export function readMergeQueueEntryRecord(input: unknown): MergeQueueEntryRead {
  try {
    if (!isPlainObject(input)) {
      return refusal('malformed', 'MergeQueueEntry must be a plain record');
    }
    const versionDescriptor = Reflect.getOwnPropertyDescriptor(input, 'version');
    let snapshot: Record<string, unknown> | null;
    if (versionDescriptor !== undefined) {
      if (!versionDescriptor.enumerable) {
        return refusal('malformed', 'MergeQueueEntry version must be enumerable');
      }
      if (versionDescriptor.value !== MERGE_QUEUE_ENTRY_VERSION) {
        return refusal('unknown-version', 'MergeQueueEntry version must be 1');
      }
      snapshot = readExactPlainRecord(input, ENTRY_KEYS);
      if (snapshot === null) {
        return refusal('malformed', 'MergeQueueEntry must have exactly the v1 entry keys');
      }
    } else {
      snapshot = readExactPlainRecord(input, LEGACY_ENTRY_KEYS);
      if (snapshot === null) {
        return refusal('malformed', 'MergeQueueEntry must have exactly the v1 entry keys');
      }
      snapshot = { ...snapshot, version: MERGE_QUEUE_ENTRY_VERSION };
    }
    return readValidatedSnapshot(snapshot);
  } catch {
    return refusal('malformed', 'MergeQueueEntry input could not be read');
  }
}

type RepositoryRead =
  | { readonly ok: true; readonly ref: MergeQueueRepositoryRef }
  | { readonly ok: false };

function isRepositorySegment(value: unknown): boolean {
  if (typeof value !== 'string' || !REPOSITORY_SEGMENT_PATTERN.test(value)) {
    return false;
  }
  if (value === '.' || value === '..') {
    return false;
  }
  return !containsSecretShape(value);
}

function readRepository(repository: unknown): RepositoryRead {
  const snapshot = readExactPlainRecord(repository, ['owner', 'repo']);
  if (snapshot === null || !isRepositorySegment(snapshot.owner) || !isRepositorySegment(snapshot.repo)) {
    return { ok: false };
  }
  return {
    ok: true,
    ref: Object.freeze({ owner: snapshot.owner as string, repo: snapshot.repo as string }),
  };
}

function readValidatedSnapshot(snapshot: Record<string, unknown>): MergeQueueEntryRead {
  const repository = readRepository(snapshot.repository);
  if (!repository.ok) {
    return refusal('malformed', 'MergeQueueEntry repository must have valid owner and repo');
  }

  let veto: MergeQueueVetoRecord | null = null;
  if (snapshot.veto !== null) {
    const vetoRead = readMergeVetoRecord(snapshot.veto);
    if (!vetoRead.ok) {
      return refusal('malformed', 'MergeQueueEntry veto must be null or a valid veto record');
    }
    veto = vetoRead.veto;
  }

  const errors = [
    identityError(snapshot),
    lifecycleError(snapshot),
    linksError(snapshot),
    auditError(snapshot),
    couplingError(snapshot),
    pairsError(snapshot),
  ];
  for (const error of errors) {
    if (error !== null) {
      return refusal('malformed', error);
    }
  }

  const record: MergeQueueEntryRecord = Object.freeze({
    version: MERGE_QUEUE_ENTRY_VERSION,
    entryId: snapshot.entryId as string,
    repository: repository.ref,
    repoDigest: snapshot.repoDigest as string,
    pullRequest: snapshot.pullRequest as number,
    headOid: snapshot.headOid as string,
    state: snapshot.state as MergeQueueEntryState,
    reason: snapshot.reason as string | null,
    attempt: snapshot.attempt as number,
    notBeforeIso: normalizeInstant(snapshot.notBeforeIso),
    enqueuedAtIso: new Date(snapshot.enqueuedAtIso as string).toISOString(),
    enqueuedBy: snapshot.enqueuedBy as MergeQueueEnqueuedBy,
    supersedes: snapshot.supersedes as string | null,
    runId: snapshot.runId as string | null,
    attemptId: snapshot.attemptId as string | null,
    workOrderId: snapshot.workOrderId as string | null,
    tier: snapshot.tier as MergeQueueTier,
    verifiedHeadOid: snapshot.verifiedHeadOid as string | null,
    verifiedBy: snapshot.verifiedBy as MergeVerifiedBy | null,
    policyRevision: snapshot.policyRevision as string | null,
    premergeReceiptHeadOid: snapshot.premergeReceiptHeadOid as string | null,
    veto,
    mergeCommitOid: snapshot.mergeCommitOid as string | null,
    mergedAtIso: normalizeInstant(snapshot.mergedAtIso),
    revision: snapshot.revision as number,
  });
  return { ok: true, record };
}

function normalizeInstant(value: unknown): string | null {
  return value === null ? null : new Date(value as string).toISOString();
}

function identityError(snapshot: Record<string, unknown>): string | null {
  if (typeof snapshot.entryId !== 'string' || !REQUEST_ID_PATTERN.test(snapshot.entryId)) {
    return 'MergeQueueEntry entryId must be a ULID';
  }
  if (!isMergeHex12(snapshot.repoDigest)) {
    return 'MergeQueueEntry repoDigest must be 12 lowercase hex characters';
  }
  if (!Number.isSafeInteger(snapshot.pullRequest) || (snapshot.pullRequest as number) < 1) {
    return 'MergeQueueEntry pullRequest must be a positive integer';
  }
  if (!isMergeHex40(snapshot.headOid)) {
    return 'MergeQueueEntry headOid must be 40 lowercase hex characters';
  }
  if (typeof snapshot.tier !== 'number' || !MERGE_QUEUE_TIERS.includes(snapshot.tier as MergeQueueTier)) {
    return 'MergeQueueEntry tier must be 0, 1 or 2';
  }
  return null;
}

function lifecycleError(snapshot: Record<string, unknown>): string | null {
  if (!MERGE_QUEUE_ENTRY_STATES.includes(snapshot.state as MergeQueueEntryState)) {
    return 'MergeQueueEntry state is not a known queue state';
  }
  if (
    snapshot.reason !== null &&
    (typeof snapshot.reason !== 'string' || !LANE_RUN_JOURNAL_REASON_CODE_PATTERN.test(snapshot.reason))
  ) {
    return 'MergeQueueEntry reason must be null or a lowercase reason token';
  }
  if (
    !Number.isSafeInteger(snapshot.attempt) ||
    (snapshot.attempt as number) < 0 ||
    (snapshot.attempt as number) > ATTEMPT_CAP
  ) {
    return 'MergeQueueEntry attempt must be a non-negative integer within cap';
  }
  if (
    (snapshot.notBeforeIso !== null && !isZonedIsoDateTime(snapshot.notBeforeIso)) ||
    !isZonedIsoDateTime(snapshot.enqueuedAtIso)
  ) {
    return 'MergeQueueEntry timestamps must be zoned ISO-8601 instants';
  }
  if (!MERGE_QUEUE_ENQUEUED_BY.includes(snapshot.enqueuedBy as MergeQueueEnqueuedBy)) {
    return 'MergeQueueEntry enqueuedBy must be conductor, cli or update';
  }
  if (!Number.isSafeInteger(snapshot.revision) || (snapshot.revision as number) < 1) {
    return 'MergeQueueEntry revision must be a positive integer';
  }
  return null;
}

function linksError(snapshot: Record<string, unknown>): string | null {
  if (
    snapshot.supersedes !== null &&
    (typeof snapshot.supersedes !== 'string' || !REQUEST_ID_PATTERN.test(snapshot.supersedes))
  ) {
    return 'MergeQueueEntry supersedes must be null or a ULID';
  }
  if (snapshot.runId !== null && (typeof snapshot.runId !== 'string' || !LANE_RUN_ID_PATTERN.test(snapshot.runId))) {
    return 'MergeQueueEntry runId must be null or run- followed by a ULID';
  }
  if (snapshot.attemptId !== null && !isMergeSafeId(snapshot.attemptId)) {
    return 'MergeQueueEntry attemptId and workOrderId must be null or safe ids';
  }
  if (snapshot.workOrderId !== null && !isMergeSafeId(snapshot.workOrderId)) {
    return 'MergeQueueEntry attemptId and workOrderId must be null or safe ids';
  }
  return null;
}

function auditError(snapshot: Record<string, unknown>): string | null {
  if (snapshot.verifiedHeadOid !== null && !isMergeHex40(snapshot.verifiedHeadOid)) {
    return 'MergeQueueEntry verifiedHeadOid must be null or 40 lowercase hex characters';
  }
  if (snapshot.verifiedBy !== null && !MERGE_VERIFIED_BY.includes(snapshot.verifiedBy as MergeVerifiedBy)) {
    return 'MergeQueueEntry verifiedBy must be null, contexts or procedure';
  }
  if (snapshot.policyRevision !== null && !isMergeSafeId(snapshot.policyRevision)) {
    return 'MergeQueueEntry policyRevision must be null or a safe id';
  }
  if (snapshot.premergeReceiptHeadOid !== null && !isMergeHex40(snapshot.premergeReceiptHeadOid)) {
    return 'MergeQueueEntry receipt and merge oids must be null or 40 lowercase hex characters';
  }
  if (snapshot.mergeCommitOid !== null && !isMergeHex40(snapshot.mergeCommitOid)) {
    return 'MergeQueueEntry receipt and merge oids must be null or 40 lowercase hex characters';
  }
  if (snapshot.mergedAtIso !== null && !isZonedIsoDateTime(snapshot.mergedAtIso)) {
    return 'MergeQueueEntry mergedAtIso must be null or a zoned ISO-8601 instant';
  }
  return null;
}

function couplingError(snapshot: Record<string, unknown>): string | null {
  if (snapshot.enqueuedBy === 'update' && snapshot.supersedes === null) {
    return 'MergeQueueEntry update entry must name supersedes';
  }
  if (snapshot.supersedes === snapshot.entryId) {
    return 'MergeQueueEntry cannot supersede itself';
  }
  if (snapshot.state === 'parked' && !MERGE_PARK_REASONS.includes(snapshot.reason as MergeParkReason)) {
    return 'MergeQueueEntry parked entry must carry a MergeParkReason';
  }
  if (snapshot.state === 'dropped' && !MERGE_DROP_REASONS.includes(snapshot.reason as MergeDropReason)) {
    return 'MergeQueueEntry dropped entry must carry a MergeDropReason';
  }
  return null;
}

function pairsError(snapshot: Record<string, unknown>): string | null {
  if ((snapshot.verifiedHeadOid === null) !== (snapshot.verifiedBy === null)) {
    return 'MergeQueueEntry verifiedHeadOid and verifiedBy must both be null or both be set';
  }
  const mergeCommitSet = snapshot.mergeCommitOid !== null;
  const mergedAtSet = snapshot.mergedAtIso !== null;
  if (mergeCommitSet !== mergedAtSet || mergeCommitSet !== (snapshot.state === 'merged')) {
    return 'MergeQueueEntry mergeCommitOid and mergedAtIso must be set iff state is merged';
  }
  return null;
}

export function isMergeQueueEntryLive(entry: Pick<MergeQueueEntryRecord, 'state'>): boolean {
  try {
    return !MERGE_QUEUE_TERMINAL_STATES.includes(entry.state as MergeQueueTerminalState);
  } catch {
    return false;
  }
}

export function sameMergeQueueIdentity(
  left: Pick<MergeQueueEntryRecord, 'repository' | 'pullRequest' | 'headOid'>,
  right: Pick<MergeQueueEntryRecord, 'repository' | 'pullRequest' | 'headOid'>,
): boolean {
  try {
    return (
      left.repository.owner === right.repository.owner &&
      left.repository.repo === right.repository.repo &&
      left.pullRequest === right.pullRequest &&
      left.headOid === right.headOid
    );
  } catch {
    return false;
  }
}

export function compareMergeQueueEntries(
  left: Pick<MergeQueueEntryRecord, 'enqueuedAtIso' | 'entryId'>,
  right: Pick<MergeQueueEntryRecord, 'enqueuedAtIso' | 'entryId'>,
): number {
  const leftMs = Date.parse(left.enqueuedAtIso);
  const rightMs = Date.parse(right.enqueuedAtIso);
  if (!Number.isNaN(leftMs) && !Number.isNaN(rightMs) && leftMs !== rightMs) {
    return leftMs - rightMs;
  }
  if (left.enqueuedAtIso !== right.enqueuedAtIso) {
    return left.enqueuedAtIso < right.enqueuedAtIso ? -1 : 1;
  }
  if (left.entryId < right.entryId) {
    return -1;
  }
  if (left.entryId > right.entryId) {
    return 1;
  }
  return 0;
}

export function orderMergeQueue(
  entries: readonly MergeQueueEntryRecord[],
  repoDigest?: string,
): readonly MergeQueueEntryRecord[] {
  try {
    if (!Array.isArray(entries)) {
      return [];
    }
    if (repoDigest !== undefined && !isMergeHex12(repoDigest)) {
      return [];
    }
    const ordered: MergeQueueEntryRecord[] = [];
    for (const element of entries) {
      const read = readMergeQueueEntryRecord(element);
      if (!read.ok || !isMergeQueueEntryLive(read.record)) {
        continue;
      }
      if (repoDigest !== undefined && read.record.repoDigest !== repoDigest) {
        continue;
      }
      ordered.push(read.record);
    }
    ordered.sort(compareMergeQueueEntries);
    return ordered;
  } catch {
    return [];
  }
}

export function findMergeQueueHead(
  entries: readonly MergeQueueEntryRecord[],
  repoDigest?: string,
): MergeQueueEntryRecord | null {
  try {
    const ordered = orderMergeQueue(entries, repoDigest);
    if (repoDigest === undefined) {
      let digest: string | null = null;
      for (const entry of ordered) {
        if (digest === null) {
          digest = entry.repoDigest;
        } else if (entry.repoDigest !== digest) {
          return null;
        }
      }
    }
    for (const entry of ordered) {
      if (entry.state !== 'parked') {
        return entry;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function readField(input: Record<string, unknown>, key: string): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(input, key);
  return descriptor?.value;
}

export function createUpdateSuccessorEntry(
  predecessor: unknown,
  input: UpdateSuccessorInput,
): MergeQueueEntryRead {
  try {
    const previousRead = readMergeQueueEntryRecord(predecessor);
    if (!previousRead.ok) {
      return refusal('malformed', 'MergeQueueEntry successor requires a valid predecessor and input');
    }
    const previous = previousRead.record;
    if (!isPlainObject(input)) {
      return refusal('malformed', 'MergeQueueEntry successor requires a valid predecessor and input');
    }
    const inputHeadOid = readField(input, 'headOid');
    if (!isMergeHex40(inputHeadOid) || inputHeadOid === previous.headOid) {
      return refusal('malformed', 'MergeQueueEntry successor requires a new 40-hex headOid');
    }
    const inputEntryId = readField(input, 'entryId');
    const inputReceipt = readField(input, 'premergeReceiptHeadOid');
    const receipt: string | null = inputReceipt === undefined ? previous.premergeReceiptHeadOid : (inputReceipt as string | null);
    const next: MergeQueueEntryRecord = {
      version: MERGE_QUEUE_ENTRY_VERSION,
      entryId: inputEntryId as string,
      repository: previous.repository,
      repoDigest: previous.repoDigest,
      pullRequest: previous.pullRequest,
      headOid: inputHeadOid,
      state: 'awaiting-checks',
      reason: null,
      attempt: 0,
      notBeforeIso: null,
      enqueuedAtIso: previous.enqueuedAtIso,
      enqueuedBy: 'update',
      supersedes: previous.entryId,
      runId: previous.runId,
      attemptId: previous.attemptId,
      workOrderId: previous.workOrderId,
      tier: previous.tier,
      verifiedHeadOid: null,
      verifiedBy: null,
      policyRevision: null,
      premergeReceiptHeadOid: receipt,
      veto: null,
      mergeCommitOid: null,
      mergedAtIso: null,
      revision: 1,
    };
    return readMergeQueueEntryRecord(next);
  } catch {
    return refusal('malformed', 'MergeQueueEntry successor could not be constructed');
  }
}

export function effectiveVerifiedHeadOid(
  entry: Pick<MergeQueueEntryRecord, 'headOid' | 'verifiedHeadOid' | 'verifiedBy'>,
  options: { readonly requiresProcedure: boolean },
): string | null {
  try {
    if (!isPlainObject(entry) || !isPlainObject(options)) {
      return null;
    }
    if (typeof options.requiresProcedure !== 'boolean') {
      return null;
    }
    if (!isMergeHex40(entry.headOid) || entry.verifiedHeadOid !== entry.headOid) {
      return null;
    }
    if (options.requiresProcedure) {
      return entry.verifiedBy === 'procedure' ? entry.verifiedHeadOid : null;
    }
    return entry.verifiedBy === 'contexts' || entry.verifiedBy === 'procedure' ? entry.verifiedHeadOid : null;
  } catch {
    return null;
  }
}
