/**
 * Pure merge-queue operations over validated record lists (plan §3.3, DT4):
 * enqueue, drop and retry decisions. Ids, digests and clocks enter as
 * parameters, never minted here. Every constructed record is validated with
 * `readMergeQueueEntryRecord`; a non-ok read refuses without writing.
 */

import { containsSecretShape } from '@fleet/shared';
import { isZonedIsoDateTime } from './conductor-halt.js';
import { parseBaseBranch } from './base-branch.js';
import type { BaseBranchValue } from './base-branch.js';
import { REQUEST_ID_PATTERN } from './lane-run-keys.js';
import {
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
  /** Optional own base; absent means the default base and a version-1 record. */
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

/** The fresh record shape a created or superseding enqueue writes. */
function buildCreatedRecord(
  input: MergeEnqueueInput,
  supersedes: string | null,
  baseBranch?: BaseBranchValue,
): MergeQueueEntryRecord {
  return {
    ...(baseBranch === undefined
      ? { version: 1 as const }
      : { version: MERGE_QUEUE_ENTRY_V2_VERSION, baseBranch }),
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
}

/** The successor of a superseded entry: inherits the predecessor's position. */
function buildSuccessorRecord(predecessor: MergeQueueEntryRecord, input: MergeEnqueueInput): MergeQueueEntryRecord {
  return {
    ...(predecessor.version === MERGE_QUEUE_ENTRY_V2_VERSION
      ? { version: MERGE_QUEUE_ENTRY_V2_VERSION, baseBranch: predecessor.baseBranch }
      : { version: 1 as const }),
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

function isSupersedablePredecessor(
  predecessor: MergeQueueEntryRecord,
  input: MergeEnqueueInput,
): boolean {
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
    if (!Array.isArray(entries) || entries.length > MERGE_QUEUE_ORDER_CAP) {
      return { outcome: 'refused', reason: 'invalid-entry-id' };
    }

    // Own `baseBranch` only: an inherited key is not a supplied base.
    const baseDescriptor = Reflect.getOwnPropertyDescriptor(input, 'baseBranch');
    let baseBranch: BaseBranchValue | undefined;
    if (baseDescriptor !== undefined) {
      const rawBase = baseDescriptor.value;
      if (typeof rawBase === 'string' && containsSecretShape(rawBase)) {
        return { outcome: 'refused', reason: 'invalid-base' };
      }
      const parsedBase = parseBaseBranch(rawBase);
      if (parsedBase === undefined) {
        return { outcome: 'refused', reason: 'invalid-base' };
      }
      baseBranch = parsedBase;
    }

    const ordered = orderMergeQueue(entries.filter(isMergeQueueEntryLive), undefined, baseBranch);

    const duplicate = findDuplicateLiveEntry(ordered, input);
    if (duplicate !== undefined) {
      return { outcome: 'duplicate', entries, record: duplicate };
    }

    const supersedeResult = trySupersedeEnqueue(entries, ordered, input);
    if (supersedeResult !== null) {
      return supersedeResult;
    }

    const createdRead = readMergeQueueEntryRecord(buildCreatedRecord(input, null, baseBranch));
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
    if (!Array.isArray(entries) || entries.length > MERGE_QUEUE_ORDER_CAP) {
      return { outcome: 'refused', reason: 'unknown-entry' };
    }
    // Lookup runs on the bounded live list, not on a base-filtered order, so
    // an entry on any base can be dropped.
    const live = entries.filter(isMergeQueueEntryLive);
    for (const entry of live) {
      if (entry.entryId === entryId) {
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
    if (!Array.isArray(entries) || entries.length > MERGE_QUEUE_ORDER_CAP) {
      return { outcome: 'refused', reason: 'unknown-entry' };
    }
    const target = entries.find((entry) => entry.entryId === entryId);
    if (target === undefined) {
      return { outcome: 'refused', reason: 'unknown-entry' };
    }
    if (target.state !== 'dropped') {
      return { outcome: 'refused', reason: 'not-dropped' };
    }
    const duplicate = entries.find(
      (entry) => isMergeQueueEntryLive(entry) && sameMergeQueueIdentity(entry, target),
    );
    if (duplicate !== undefined) {
      return { outcome: 'duplicate', entries, record: duplicate };
    }
    const record: MergeQueueEntryRecord = {
      ...(target.version === MERGE_QUEUE_ENTRY_V2_VERSION
        ? { version: MERGE_QUEUE_ENTRY_V2_VERSION, baseBranch: target.baseBranch }
        : { version: 1 as const }),
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
