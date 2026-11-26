/**
 * Pure merge-queue operations over validated record lists (plan §3.3, DT4):
 * enqueue, drop and retry decisions. Ids, digests and clocks enter as
 * parameters, never minted here. Every constructed record is validated with
 * `readMergeQueueEntryRecord`; a non-ok read refuses without writing.
 */

import { containsSecretShape } from '@fleet/shared';
import { DEFAULT_BASE_BRANCH, parseBaseBranch } from './base-branch.js';
import type { BaseBranchValue } from './base-branch.js';
import { isZonedIsoDateTime } from './conductor-halt.js';
import { REQUEST_ID_PATTERN } from './lane-run-keys.js';
import {
  MERGE_QUEUE_ENTRY_VERSION,
  MERGE_QUEUE_ENTRY_V2_VERSION,
  MERGE_QUEUE_ORDER_CAP,
  MERGE_QUEUE_TIERS,
  isMergeHex40,
  isMergeQueueEntryLive,
  orderMergeQueue,
  readMergeQueueEntryRecord,
  sameMergeQueueIdentity,
} from './merge-queue-records.js';
import type {
  MergeQueueEnqueuedBy,
  MergeQueueEntryRecord,
  MergeQueueRepositoryRef,
  MergeQueueTier,
} from './merge-queue-records.js';

export type MergeEnqueueRefusal =
  | 'invalid-head'
  | 'invalid-repository'
  | 'invalid-entry-id'
  | 'invalid-tier'
  | 'invalid-enqueued-at'
  | 'invalid-deadline'
  | 'invalid-base';

export interface MergeEnqueueInput {
  readonly repository: MergeQueueRepositoryRef;
  readonly pullRequest: number;
  readonly headOid: unknown;
  readonly tier: unknown;
  readonly enqueuedBy: MergeQueueEnqueuedBy;
  readonly runId: string | null;
  readonly entryId: unknown;
  readonly successorEntryId: unknown;
  readonly enqueuedAtIso: string;
  readonly repoDigest: string;
  readonly baseBranch?: unknown;
}

export type MergeEnqueueDecision =
  | {
      readonly outcome: 'duplicate';
      readonly entries: readonly MergeQueueEntryRecord[];
      readonly record: MergeQueueEntryRecord;
    }
  | {
      readonly outcome: 'created';
      readonly entries: readonly MergeQueueEntryRecord[];
      readonly record: MergeQueueEntryRecord;
    }
  | {
      readonly outcome: 'supersedes';
      readonly entries: readonly MergeQueueEntryRecord[];
      readonly record: MergeQueueEntryRecord;
      readonly supersededEntryId: string;
    }
  | { readonly outcome: 'refused'; readonly reason: MergeEnqueueRefusal };

export type MergeDropDecision =
  | {
      readonly outcome: 'dropped';
      readonly entries: readonly MergeQueueEntryRecord[];
      readonly record: MergeQueueEntryRecord;
    }
  | { readonly outcome: 'refused'; readonly reason: 'unknown-entry' | 'invalid-deadline' };

export type MergeRetryDecision =
  | {
      readonly outcome: 'retried';
      readonly entries: readonly MergeQueueEntryRecord[];
      readonly record: MergeQueueEntryRecord;
    }
  | {
      readonly outcome: 'duplicate';
      readonly entries: readonly MergeQueueEntryRecord[];
      readonly record: MergeQueueEntryRecord;
    }
  | {
      readonly outcome: 'refused';
      readonly reason: 'unknown-entry' | 'not-dropped' | 'invalid-deadline' | 'invalid-entry';
    };

function isMergeQueueTier(value: unknown): value is MergeQueueTier {
  return typeof value === 'number' && (MERGE_QUEUE_TIERS as readonly unknown[]).includes(value);
}

function isUlid(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

/** The entry-list guard: a non-array, a non-safe-integer length or an
 * over-cap list is refused before any element is read. */
function isQueueListValid(entries: readonly MergeQueueEntryRecord[]): boolean {
  return Array.isArray(entries) && Number.isSafeInteger(entries.length) && entries.length <= MERGE_QUEUE_ORDER_CAP;
}

/** Read the enqueue input's selected base without invoking any getter.
 * Absent reads as `main` (v1); a present accessor, secret-shaped value or
 * unparsable value returns undefined so the caller refuses `invalid-base`. */
function readInputBase(input: MergeEnqueueInput): BaseBranchValue | undefined {
  const descriptor = Reflect.getOwnPropertyDescriptor(input, 'baseBranch');
  if (descriptor === undefined) {
    return DEFAULT_BASE_BRANCH;
  }
  if ('get' in descriptor || 'set' in descriptor) {
    return undefined;
  }
  if (typeof descriptor.value === 'string' && containsSecretShape(descriptor.value)) {
    return undefined;
  }
  return parseBaseBranch(descriptor.value);
}

/** The fresh record shape a created or superseding enqueue writes. A v1
 * write (no supplied base) carries no `baseBranch` key; a supplied base
 * writes a v2 record with that base. */
function buildCreatedRecord(
  input: MergeEnqueueInput,
  supersedes: string | null,
  base: BaseBranchValue | undefined,
): MergeQueueEntryRecord {
  const common: MergeQueueEntryRecord = {
    version: base === undefined ? MERGE_QUEUE_ENTRY_VERSION : MERGE_QUEUE_ENTRY_V2_VERSION,
    entryId: input.entryId as string,
    repository: input.repository,
    repoDigest: input.repoDigest,
    pullRequest: input.pullRequest,
    headOid: input.headOid as string,
    state: 'queued',
    reason: null,
    attempt: 0,
    notBeforeIso: null,
    enqueuedAtIso: input.enqueuedAtIso,
    enqueuedBy: input.enqueuedBy,
    supersedes,
    runId: input.runId,
    attemptId: null,
    workOrderId: null,
    tier: input.tier as MergeQueueTier,
    verifiedHeadOid: null,
    verifiedBy: null,
    policyRevision: null,
    premergeReceiptHeadOid: null,
    veto: null,
    mergeCommitOid: null,
    mergedAtIso: null,
    revision: 1,
  };
  return base === undefined ? common : { ...common, baseBranch: base };
}

/** The successor of a superseded entry: inherits the predecessor's position,
 * version and base. */
function buildSuccessorRecord(predecessor: MergeQueueEntryRecord, input: MergeEnqueueInput): MergeQueueEntryRecord {
  const common: MergeQueueEntryRecord = {
    version: predecessor.version,
    entryId: input.successorEntryId as string,
    repository: predecessor.repository,
    repoDigest: predecessor.repoDigest,
    pullRequest: predecessor.pullRequest,
    headOid: input.headOid as string,
    state: 'queued',
    reason: null,
    attempt: 0,
    notBeforeIso: null,
    enqueuedAtIso: predecessor.enqueuedAtIso,
    enqueuedBy: input.enqueuedBy,
    supersedes: predecessor.entryId,
    runId: null,
    attemptId: null,
    workOrderId: null,
    tier: input.tier as MergeQueueTier,
    verifiedHeadOid: null,
    verifiedBy: null,
    policyRevision: null,
    premergeReceiptHeadOid: null,
    veto: null,
    mergeCommitOid: null,
    mergedAtIso: null,
    revision: 1,
  };
  return predecessor.version === MERGE_QUEUE_ENTRY_V2_VERSION
    ? { ...common, baseBranch: predecessor.baseBranch }
    : common;
}

function findDuplicateLiveEntry(
  ordered: readonly MergeQueueEntryRecord[],
  input: MergeEnqueueInput,
): MergeQueueEntryRecord | undefined {
  const targetIdentity = {
    repository: input.repository,
    pullRequest: input.pullRequest,
    headOid: input.headOid as string,
  };
  return ordered.find((entry) => sameMergeQueueIdentity(entry, targetIdentity));
}

export function isSupersedablePredecessor(
  predecessor: MergeQueueEntryRecord,
  input: Pick<MergeEnqueueInput, 'repository' | 'pullRequest' | 'headOid'>,
): boolean {
  try {
    if (predecessor.headOid === input.headOid) {
      return false;
    }
    if (predecessor.pullRequest !== input.pullRequest) {
      return false;
    }
    return (
      predecessor.repository.owner === input.repository.owner &&
      predecessor.repository.repo === input.repository.repo
    );
  } catch {
    return false;
  }
}

function trySupersedeEnqueue(
  entries: readonly MergeQueueEntryRecord[],
  ordered: readonly MergeQueueEntryRecord[],
  input: MergeEnqueueInput,
): MergeEnqueueDecision | null {
  const predecessor = ordered.find((candidate) => isSupersedablePredecessor(candidate, input));
  if (predecessor === undefined) {
    return null;
  }
  const successorRead = readMergeQueueEntryRecord(buildSuccessorRecord(predecessor, input));
  if (!successorRead.ok) {
    return { outcome: 'refused', reason: 'invalid-entry-id' };
  }
  const supersededRead = readMergeQueueEntryRecord({
    ...predecessor,
    state: 'superseded',
    reason: null,
    revision: predecessor.revision + 1,
  });
  if (!supersededRead.ok) {
    return { outcome: 'refused', reason: 'invalid-entry-id' };
  }
  const next = entries.map((entry) =>
    entry.entryId === predecessor.entryId ? supersededRead.record : entry,
  );
  next.push(successorRead.record);
  return {
    outcome: 'supersedes',
    entries: next,
    record: successorRead.record,
    supersededEntryId: predecessor.entryId,
  };
}

export function decideMergeEnqueue(
  entries: readonly MergeQueueEntryRecord[],
  input: MergeEnqueueInput,
): MergeEnqueueDecision {
  try {
    if (!isQueueListValid(entries)) {
      return { outcome: 'refused', reason: 'invalid-entry-id' };
    }
    if (!isMergeHex40(input.headOid)) {
      return { outcome: 'refused', reason: 'invalid-head' };
    }
    if (!isUlid(input.entryId) || !isUlid(input.successorEntryId)) {
      return { outcome: 'refused', reason: 'invalid-entry-id' };
    }
    if (!isMergeQueueTier(input.tier)) {
      return { outcome: 'refused', reason: 'invalid-tier' };
    }
    if (!isZonedIsoDateTime(input.enqueuedAtIso)) {
      return { outcome: 'refused', reason: 'invalid-enqueued-at' };
    }
    const selectedBase = readInputBase(input);
    if (selectedBase === undefined) {
      return { outcome: 'refused', reason: 'invalid-base' };
    }

    // Duplicate and supersede matching is partitioned by the selected base;
    // `orderMergeQueue` already filters live entries.
    const ordered = orderMergeQueue(entries, undefined, selectedBase);

    const duplicate = findDuplicateLiveEntry(ordered, input);
    if (duplicate !== undefined) {
      return { outcome: 'duplicate', entries, record: duplicate };
    }

    const supersedeResult = trySupersedeEnqueue(entries, ordered, input);
    if (supersedeResult !== null) {
      return supersedeResult;
    }

    const createdRead = readMergeQueueEntryRecord(
      buildCreatedRecord(input, null, selectedBase === DEFAULT_BASE_BRANCH && !Object.hasOwn(input, 'baseBranch') ? undefined : selectedBase),
    );
    if (!createdRead.ok) {
      return { outcome: 'refused', reason: 'invalid-entry-id' };
    }
    return { outcome: 'created', entries: [...entries, createdRead.record], record: createdRead.record };
  } catch {
    return { outcome: 'refused', reason: 'invalid-entry-id' };
  }
}

export function decideMergeDrop(
  entries: readonly MergeQueueEntryRecord[],
  entryId: unknown,
): MergeDropDecision {
  try {
    if (!isQueueListValid(entries)) {
      return { outcome: 'refused', reason: 'unknown-entry' };
    }
    // A bounded scan over every live entry so chain-based entries are found
    // regardless of their base.
    for (const element of entries) {
      const read = readMergeQueueEntryRecord(element);
      if (!read.ok || !isMergeQueueEntryLive(read.record) || read.record.entryId !== entryId) {
        continue;
      }
      const entry = read.record;
      const droppedRead = readMergeQueueEntryRecord({
        ...entry,
        state: 'dropped',
        reason: 'operator-dropped',
        revision: entry.revision + 1,
      });
      if (!droppedRead.ok) {
        return { outcome: 'refused', reason: 'unknown-entry' };
      }
      const next = entries.map((candidate) =>
        candidate.entryId === entry.entryId ? droppedRead.record : candidate,
      );
      return { outcome: 'dropped', entries: next, record: droppedRead.record };
    }
    return { outcome: 'refused', reason: 'unknown-entry' };
  } catch {
    return { outcome: 'refused', reason: 'unknown-entry' };
  }
}

export function decideMergeRetry(
  entries: readonly MergeQueueEntryRecord[],
  entryId: unknown,
  retry: { readonly entryId: unknown; readonly enqueuedAtIso: string },
): MergeRetryDecision {
  try {
    if (!isQueueListValid(entries)) {
      return { outcome: 'refused', reason: 'unknown-entry' };
    }
    let target: MergeQueueEntryRecord | undefined = undefined;
    for (const element of entries) {
      const read = readMergeQueueEntryRecord(element);
      if (!read.ok) {
        // A malformed record whose entry id matches the request is not
        // silently skipped or rebuilt: retry refuses it.
        if (element.entryId === entryId) {
          return { outcome: 'refused', reason: 'invalid-entry' };
        }
        continue;
      }
      if (read.record.entryId === entryId) {
        target = read.record;
        break;
      }
    }
    if (target === undefined) {
      return { outcome: 'refused', reason: 'unknown-entry' };
    }
    if (target.state !== 'dropped') {
      return { outcome: 'refused', reason: 'not-dropped' };
    }
    // Duplicate detection is partitioned by the target's effective base: a
    // live main entry must not block retrying a dropped chain entry, and a
    // live chain entry must not block retrying a dropped main entry. Only
    // validated records participate in the duplicate scan.
    const targetBase =
      target.version === MERGE_QUEUE_ENTRY_V2_VERSION ? target.baseBranch : DEFAULT_BASE_BRANCH;
    for (const element of entries) {
      const read = readMergeQueueEntryRecord(element);
      if (!read.ok || !isMergeQueueEntryLive(read.record)) {
        continue;
      }
      const entry = read.record;
      const entryBase =
        entry.version === MERGE_QUEUE_ENTRY_V2_VERSION ? entry.baseBranch : DEFAULT_BASE_BRANCH;
      if (entryBase !== targetBase || !sameMergeQueueIdentity(entry, target)) {
        continue;
      }
      return { outcome: 'duplicate', entries, record: entry };
    }
    // A v1 target retries as v1 with no base; a v2 target keeps its base.
    const retryBase: { baseBranch?: BaseBranchValue } =
      target.version === MERGE_QUEUE_ENTRY_V2_VERSION ? { baseBranch: target.baseBranch } : {};
    const record: MergeQueueEntryRecord = {
      ...retryBase,
      version: target.version,
      entryId: retry.entryId as string,
      repository: target.repository,
      repoDigest: target.repoDigest,
      pullRequest: target.pullRequest,
      headOid: target.headOid,
      state: 'queued',
      reason: null,
      attempt: target.attempt + 1,
      notBeforeIso: null,
      enqueuedAtIso: retry.enqueuedAtIso,
      enqueuedBy: 'cli',
      supersedes: null,
      runId: null,
      attemptId: null,
      workOrderId: null,
      tier: target.tier,
      verifiedHeadOid: null,
      verifiedBy: null,
      policyRevision: null,
      premergeReceiptHeadOid: null,
      veto: null,
      mergeCommitOid: null,
      mergedAtIso: null,
      revision: 1,
    };
    const read = readMergeQueueEntryRecord(record);
    if (!read.ok) {
      return { outcome: 'refused', reason: 'invalid-entry' };
    }
    return { outcome: 'retried', entries: [...entries, read.record], record: read.record };
  } catch {
    return { outcome: 'refused', reason: 'invalid-entry' };
  }
}
