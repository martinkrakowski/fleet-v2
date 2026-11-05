/**
 * Pure record transitions for the merge pass (plan §3.3, §3.6; lane DT9c):
 * the builders that turn a decider decision into the next entry record, the
 * durable audit fields, the successor entry, the notification vocabulary and
 * the compare-and-set decision the queue store applies. No clock, id minting,
 * I/O or throwing: every builder validates its record with
 * `readMergeQueueEntryRecord` and answers a typed refusal otherwise.
 */

import {
  MERGE_DROP_REASONS,
  MERGE_PARK_REASONS,
  createUpdateSuccessorEntry,
  isMergeHex40,
  isMergeQueueEntryLive,
  isMergeSafeId,
  readMergeQueueEntryRecord,
  sameMergeQueueIdentity,
} from './merge-queue-records.js';
import type {
  MergeDropReason,
  MergeParkReason,
  MergeQueueEntryRecord,
  MergeQueueVetoRecord,
  MergeVerifiedBy,
} from './merge-queue-records.js';
import { isZonedIsoDateTime } from './conductor-halt.js';

export type MergeEntryBuild =
  | { readonly ok: true; readonly record: MergeQueueEntryRecord }
  | { readonly ok: false; readonly reason: 'invalid-entry' | 'invalid-input' | 'terminal-entry' | 'audit-incomplete' };

export type MergeSupersessionBuild =
  | {
      readonly ok: true;
      readonly predecessor: MergeQueueEntryRecord;
      readonly successor: MergeQueueEntryRecord;
    }
  | { readonly ok: false; readonly reason: 'invalid-entry' | 'invalid-input' | 'terminal-entry' };

/** The notification events of the merge pass (plan §3.4: ids and codes only). */
export const MERGE_NOTIFICATION_EVENTS = [
  'merged', 'dropped', 'parked', 'forge-error-exhausted', 'veto-hold', 'paused', 'halted',
] as const;
export type MergeNotificationEvent = (typeof MERGE_NOTIFICATION_EVENTS)[number];

/** The idempotence key of one notification: one per (event, id). */
export function mergeNotificationKey(event: MergeNotificationEvent, id: string): string {
  return `${event}:${id}`;
}

export function isMergeNotificationEvent(value: unknown): value is MergeNotificationEvent {
  return typeof value === 'string' && (MERGE_NOTIFICATION_EVENTS as readonly string[]).includes(value);
}

/** The event a drop raises: `forge-error-exhausted` has its own line. */
export function dropNotificationEvent(reason: MergeDropReason): MergeNotificationEvent {
  return reason === 'forge-error-exhausted' ? 'forge-error-exhausted' : 'dropped';
}

/** The event a park raises: a veto hold has its own line. */
export function parkNotificationEvent(reason: MergeParkReason): MergeNotificationEvent {
  return reason === 'veto-hold' ? 'veto-hold' : 'parked';
}

function terminal(entry: MergeQueueEntryRecord): boolean {
  return !isMergeQueueEntryLive(entry);
}

function validated(entry: unknown): MergeQueueEntryRecord | null {
  const read = readMergeQueueEntryRecord(entry);
  return read.ok ? read.record : null;
}

function next(entry: MergeQueueEntryRecord, changes: Partial<MergeQueueEntryRecord>): MergeEntryBuild {
  const read = readMergeQueueEntryRecord({ ...entry, ...changes, revision: entry.revision + 1 });
  return read.ok ? { ok: true, record: read.record } : { ok: false, reason: 'invalid-entry' };
}

/** Whether two records carry the same content apart from the revision. */
export function sameMergeEntryContent(left: MergeQueueEntryRecord, right: MergeQueueEntryRecord): boolean {
  try {
    return JSON.stringify({ ...left, revision: 0 }) === JSON.stringify({ ...right, revision: 0 });
  } catch {
    return false;
  }
}

export interface ReadyAuditInput {
  readonly verifiedHeadOid: string;
  readonly verifiedBy: MergeVerifiedBy;
  readonly policyRevision: string;
  /** The head the poster's `premerge` status was read at; null keeps what the entry has. */
  readonly premergeReceiptHeadOid: string | null;
}

/** `ready` plus the verification audit fields (§3.3 effective verified head). */
export function buildReadyEntry(entry: unknown, input: ReadyAuditInput): MergeEntryBuild {
  try {
    const current = validated(entry);
    if (current === null) {
      return { ok: false, reason: 'invalid-entry' };
    }
    if (terminal(current)) {
      return { ok: false, reason: 'terminal-entry' };
    }
    if (
      !isMergeHex40(input.verifiedHeadOid) ||
      (input.verifiedBy !== 'contexts' && input.verifiedBy !== 'procedure') ||
      !isMergeSafeId(input.policyRevision) ||
      (input.premergeReceiptHeadOid !== null && !isMergeHex40(input.premergeReceiptHeadOid))
    ) {
      return { ok: false, reason: 'invalid-input' };
    }
    return next(current, {
      state: 'ready',
      reason: null,
      verifiedHeadOid: input.verifiedHeadOid,
      verifiedBy: input.verifiedBy,
      policyRevision: input.policyRevision,
      premergeReceiptHeadOid: input.premergeReceiptHeadOid ?? current.premergeReceiptHeadOid,
    });
  } catch {
    return { ok: false, reason: 'invalid-entry' };
  }
}

export interface ParkInput {
  readonly reason: MergeParkReason;
  readonly nextAttempt: number;
  readonly notBeforeIso: string | null;
}

export function buildParkedEntry(entry: unknown, input: ParkInput): MergeEntryBuild {
  try {
    const current = validated(entry);
    if (current === null) {
      return { ok: false, reason: 'invalid-entry' };
    }
    if (terminal(current)) {
      return { ok: false, reason: 'terminal-entry' };
    }
    if (
      !(MERGE_PARK_REASONS as readonly unknown[]).includes(input.reason) ||
      !Number.isSafeInteger(input.nextAttempt) ||
      (input.notBeforeIso !== null && !isZonedIsoDateTime(input.notBeforeIso))
    ) {
      return { ok: false, reason: 'invalid-input' };
    }
    return next(current, {
      state: 'parked',
      reason: input.reason,
      attempt: input.nextAttempt,
      notBeforeIso: input.notBeforeIso,
    });
  } catch {
    return { ok: false, reason: 'invalid-entry' };
  }
}

export function buildDroppedEntry(entry: unknown, reason: MergeDropReason): MergeEntryBuild {
  try {
    const current = validated(entry);
    if (current === null) {
      return { ok: false, reason: 'invalid-entry' };
    }
    if (terminal(current)) {
      return { ok: false, reason: 'terminal-entry' };
    }
    if (!(MERGE_DROP_REASONS as readonly unknown[]).includes(reason)) {
      return { ok: false, reason: 'invalid-input' };
    }
    return next(current, { state: 'dropped', reason });
  } catch {
    return { ok: false, reason: 'invalid-entry' };
  }
}

/**
 * The predecessor ends `superseded`; the successor takes the live head,
 * inherits the predecessor's position (`enqueuedAtIso`) and run links, and is
 * `enqueuedBy: 'update'` (§3.3). Ids enter as a parameter, never minted here.
 */
export function buildSupersession(
  entry: unknown,
  liveHeadOid: unknown,
  successorEntryId: unknown,
): MergeSupersessionBuild {
  try {
    const current = validated(entry);
    if (current === null) {
      return { ok: false, reason: 'invalid-entry' };
    }
    if (terminal(current)) {
      return { ok: false, reason: 'terminal-entry' };
    }
    if (!isMergeHex40(liveHeadOid) || liveHeadOid === current.headOid) {
      return { ok: false, reason: 'invalid-input' };
    }
    const successor = createUpdateSuccessorEntry(current, { entryId: successorEntryId as string, headOid: liveHeadOid });
    if (!successor.ok) {
      return { ok: false, reason: 'invalid-input' };
    }
    const predecessor = next(current, { state: 'superseded', reason: null });
    if (!predecessor.ok) {
      return { ok: false, reason: 'invalid-entry' };
    }
    return { ok: true, predecessor: predecessor.record, successor: successor.record };
  } catch {
    return { ok: false, reason: 'invalid-entry' };
  }
}

/** Record the Jev veto answer with its decision receipt id (§3.3); never invents one. */
export function buildVetoEntry(entry: unknown, veto: MergeQueueVetoRecord): MergeEntryBuild {
  try {
    const current = validated(entry);
    if (current === null) {
      return { ok: false, reason: 'invalid-entry' };
    }
    if (terminal(current)) {
      return { ok: false, reason: 'terminal-entry' };
    }
    return next(current, { veto });
  } catch {
    return { ok: false, reason: 'invalid-entry' };
  }
}

export interface MergedInput {
  readonly mergeCommitOid: string;
  readonly mergedAtIso: string;
}

/**
 * The merged entry (§3.6 audit trail). Refused unless the entry already holds
 * the verification audit (`policyRevision`, `verifiedHeadOid`, `verifiedBy`)
 * and the verified head is the entry's own head, so a merge can never be
 * recorded without its audit; the premerge receipt head and the veto stay as
 * recorded (null when the tier or the policy did not need them).
 */
export function buildMergedEntry(entry: unknown, input: MergedInput): MergeEntryBuild {
  try {
    const current = validated(entry);
    if (current === null) {
      return { ok: false, reason: 'invalid-entry' };
    }
    if (terminal(current)) {
      return { ok: false, reason: 'terminal-entry' };
    }
    if (!isMergeHex40(input.mergeCommitOid) || !isZonedIsoDateTime(input.mergedAtIso)) {
      return { ok: false, reason: 'invalid-input' };
    }
    if (
      current.policyRevision === null ||
      current.verifiedBy === null ||
      current.verifiedHeadOid !== current.headOid
    ) {
      return { ok: false, reason: 'audit-incomplete' };
    }
    return next(current, {
      state: 'merged',
      reason: null,
      mergeCommitOid: input.mergeCommitOid,
      mergedAtIso: input.mergedAtIso,
    });
  } catch {
    return { ok: false, reason: 'invalid-entry' };
  }
}

export interface MergeTransition {
  readonly entryId: string;
  readonly expectedRevision: number;
  readonly next: MergeQueueEntryRecord;
  /** Appended with the transition when the next state is `superseded`. */
  readonly successor: MergeQueueEntryRecord | null;
}

export type MergeTransitionRefusal =
  | 'unknown-entry'
  | 'revision-conflict'
  | 'terminal-entry'
  | 'invalid-record'
  | 'invalid-successor';

export type MergeTransitionDecision =
  | {
      readonly outcome: 'applied';
      readonly entries: readonly MergeQueueEntryRecord[];
      readonly record: MergeQueueEntryRecord;
      readonly successor: MergeQueueEntryRecord | null;
    }
  | { readonly outcome: 'refused'; readonly reason: MergeTransitionRefusal | 'invalid-deadline' };

const IMMUTABLE_KEYS = [
  'version', 'entryId', 'repoDigest', 'pullRequest', 'headOid', 'enqueuedAtIso', 'enqueuedBy',
  'supersedes', 'runId', 'attemptId', 'workOrderId', 'tier',
] as const;

/**
 * Compare-and-set one entry. The write applies only when the stored revision
 * is the expected one, the next record is valid, differs by exactly one
 * revision and keeps the entry's identity, and a terminal entry never moves.
 * A successor whose identity is already live is not appended twice (the crash
 * between intent and result recovers by replay).
 */
export function decideMergeTransition(
  entries: readonly MergeQueueEntryRecord[],
  transition: MergeTransition,
): MergeTransitionDecision {
  try {
    const target = entries.find((candidate) => candidate.entryId === transition.entryId);
    if (target === undefined) {
      return { outcome: 'refused', reason: 'unknown-entry' };
    }
    if (target.revision !== transition.expectedRevision) {
      return { outcome: 'refused', reason: 'revision-conflict' };
    }
    if (terminal(target)) {
      return { outcome: 'refused', reason: 'terminal-entry' };
    }
    const nextRead = readMergeQueueEntryRecord(transition.next);
    if (!nextRead.ok || nextRead.record.revision !== target.revision + 1) {
      return { outcome: 'refused', reason: 'invalid-record' };
    }
    const record = nextRead.record;
    for (const key of IMMUTABLE_KEYS) {
      if (record[key] !== target[key]) {
        return { outcome: 'refused', reason: 'invalid-record' };
      }
    }
    if (
      record.repository.owner !== target.repository.owner ||
      record.repository.repo !== target.repository.repo
    ) {
      return { outcome: 'refused', reason: 'invalid-record' };
    }

    let successor: MergeQueueEntryRecord | null = null;
    let append: MergeQueueEntryRecord | null = null;
    if (transition.successor !== null) {
      const successorRead = readMergeQueueEntryRecord(transition.successor);
      if (
        record.state !== 'superseded' ||
        !successorRead.ok ||
        successorRead.record.supersedes !== target.entryId ||
        successorRead.record.revision !== 1 ||
        successorRead.record.pullRequest !== target.pullRequest ||
        successorRead.record.repoDigest !== target.repoDigest ||
        successorRead.record.repository.owner !== target.repository.owner ||
        successorRead.record.repository.repo !== target.repository.repo ||
        successorRead.record.headOid === target.headOid
      ) {
        return { outcome: 'refused', reason: 'invalid-successor' };
      }
      const candidate = successorRead.record;
      if (entries.some((other) => other.entryId === candidate.entryId)) {
        return { outcome: 'refused', reason: 'invalid-successor' };
      }
      const existing = entries.find(
        (other) => isMergeQueueEntryLive(other) && sameMergeQueueIdentity(other, candidate),
      );
      successor = existing ?? candidate;
      append = existing === undefined ? candidate : null;
    } else if (record.state === 'superseded') {
      return { outcome: 'refused', reason: 'invalid-successor' };
    }

    const nextEntries = entries.map((other) => (other.entryId === target.entryId ? record : other));
    if (append !== null) {
      nextEntries.push(append);
    }
    return { outcome: 'applied', entries: nextEntries, record, successor };
  } catch {
    return { outcome: 'refused', reason: 'invalid-record' };
  }
}

