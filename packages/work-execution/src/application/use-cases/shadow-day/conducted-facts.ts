/**
 * SH18a: the application-layer reader of the conducted-run conformance facts
 * S6' (SH12a/SH12b) evaluates. `readShadowConformanceRuns` is read-only and
 * fail-closed: any unreadable source, missing attempt, missing journal map
 * entry or over-cap input makes the whole answer `unknown` with a code —
 * never a shorter list, never a partial `ok`. Requests and every nested
 * object are read through their own property descriptors (no getter runs,
 * no Proxy `get` trap runs); no path, error message or free text is echoed.
 */

import type {
  LaneRunRepositoryPort,
} from '../../ports/out/LaneRunRepositoryPort.out-port.js';
import type {
  LaneRunJournalPort,
} from '../../ports/out/LaneRunJournalPort.out-port.js';
import type {
  AttemptRepositoryPort,
} from '../../ports/out/AttemptRepositoryPort.out-port.js';
import type {
  AcceptanceReceiptReadPort,
  ReviewReceiptProjection,
  ReadReceiptsForHeadResult,
} from '../../ports/out/AcceptanceReceiptReadPort.out-port.js';
import type { AttemptRecord } from '../../../domain/execution-records.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type {
  LaneRunJournalEntryRecord,
} from '../../../domain/lane-run-journal.js';
import type {
  ShadowConformanceRun,
  ShadowConformanceJournalEntry,
} from '../../../domain/shadow-day-conformance.js';
import {
  SHADOW_CONFORMANCE_MAX_RUNS,
  SHADOW_CONFORMANCE_MAX_ENTRIES_PER_RUN,
} from '../../../domain/shadow-day-conformance.js';
import { isZonedIsoDateTime } from '../../../domain/conductor-halt.js';
import { readExactPlainRecord } from '../../../domain/plain-record-reads.js';

/**
 * Cap on the request's merged pull-request list. An over-cap list is refused
 * before any element is read.
 */
export const SHADOW_FACTS_MAX_MERGED_PULL_REQUESTS = 10_000;

/** The read-only dependencies the conducted-run facts need. */
export interface ShadowConformanceRunsDependencies {
  readonly runs: Pick<LaneRunRepositoryPort, 'list'>;
  readonly journal: Pick<LaneRunJournalPort, 'listForRun' | 'listForRuns'>;
  readonly attempts: Pick<AttemptRepositoryPort, 'findAttemptById'>;
  readonly receipts: Pick<AcceptanceReceiptReadPort, 'readReceiptsForHead'>;
  readonly nowIso: () => string;
}

/** Why the whole conducted-run answer is `unknown`. */
export type ShadowConformanceRunsUnknown =
  | 'invalid-request'
  | 'runs-unreadable'
  | 'journal-unreadable'
  | 'attempt-unreadable'
  | 'head-unresolved'
  | 'receipts-unavailable'
  | 'too-many-runs'
  | 'too-many-journal-entries'
  | 'deadline-exceeded';

export type ShadowConformanceRunsRead =
  | { readonly status: 'ok'; readonly runs: readonly ShadowConformanceRun[] }
  | { readonly status: 'unknown'; readonly reason: ShadowConformanceRunsUnknown };

const REQUEST_KEYS: readonly string[] = ['mergedPullRequests', 'deadlineIso'];

/** A 40-hex commit id; anything else never resolves a run's head. */
const HEAD_HEX_40_PATTERN = /^[0-9a-f]{40}$/;

const MAX_ARRAY_LENGTH = 2 ** 32 - 1;

const refused = (reason: ShadowConformanceRunsUnknown): ShadowConformanceRunsRead => ({
  status: 'unknown',
  reason,
});

/**
 * The deadline check: a `nowIso` that throws, is not a zoned ISO time, or is
 * at or past `deadlineIso` (instant comparison, never string comparison)
 * reads as past the deadline. Cost: O(1).
 */
function isPastDeadline(nowIso: () => string, deadlineIso: string): boolean {
  let now: string;
  try {
    now = nowIso();
  } catch {
    return true;
  }
  if (!isZonedIsoDateTime(now)) {
    return true;
  }
  return Date.parse(now) >= Date.parse(deadlineIso);
}

/**
 * One merged pull-request id read through its own data-property descriptor.
 * Cost: O(1). A missing slot, an accessor, or anything that is not a safe
 * integer of at least 1 is refused.
 */
function readPullRequestId(items: readonly unknown[], index: number): number | null {
  const descriptor = Object.getOwnPropertyDescriptor(items, index);
  if (descriptor === undefined || descriptor.get !== undefined) {
    return null;
  }
  const value = descriptor.value;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    return null;
  }
  return value;
}

/**
 * Every own key is `length` or a canonical index inside `length`; anything
 * else — a symbol, a named key, an index beyond `length` — is refused.
 * Cost: linear in the array's own-key count (capped by the caller).
 */
function ownKeysAreIndices(value: readonly unknown[], length: number): boolean {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') {
      return false;
    }
    if (key === 'length') {
      continue;
    }
    if (!/^\d+$/.test(key) || Number(key) >= length) {
      return false;
    }
  }
  return true;
}

/**
 * The merged pull-request id set. Cost: linear in the capped list; the caps
 * (`SHADOW_FACTS_MAX_MERGED_PULL_REQUESTS`, `MAX_ARRAY_LENGTH`) are named
 * constants. A real, dense array is required: a wrong primitive, a
 * non-iterable object, an array-like, a hole, an accessor, an over-cap
 * length or a foreign own key is refused before any traversal.
 */
function readMergedPullRequestIds(value: unknown): ReadonlySet<number> | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined ||
    lengthDescriptor.get !== undefined ||
    typeof lengthDescriptor.value !== 'number'
  ) {
    return null;
  }
  const length = lengthDescriptor.value;
  if (length >= MAX_ARRAY_LENGTH || length > SHADOW_FACTS_MAX_MERGED_PULL_REQUESTS) {
    return null;
  }
  if (!ownKeysAreIndices(value, length)) {
    return null;
  }
  const ids = new Set<number>();
  for (let index = 0; index < length; index += 1) {
    const id = readPullRequestId(value, index);
    if (id === null) {
      return null;
    }
    ids.add(id);
  }
  return ids;
}

/** The candidate runs: every run whose `prNumber` is in the merged set. Cost: O(runs). */
function selectCandidateRuns(
  runRecords: readonly LaneRunRecord[],
  mergedPullRequests: ReadonlySet<number>,
): readonly LaneRunRecord[] {
  return runRecords.filter(
    (run) => typeof run.prNumber === 'number' && mergedPullRequests.has(run.prNumber),
  );
}

type JournalListsRead =
  | { readonly ok: true; readonly byRunId: ReadonlyMap<string, readonly LaneRunJournalEntryRecord[]> }
  | { readonly ok: false; readonly reason: ShadowConformanceRunsUnknown };

/**
 * The candidates' journals. With `listForRuns`, one grouped read whose map
 * must contain every requested run id mapped to an array; otherwise one
 * `listForRun` per candidate. Any throw, non-`Map`, missing key, non-array
 * value or past deadline refuses the whole answer. Cost: linear in the
 * capped candidates; the caps are named constants.
 */
async function readJournalLists(
  journal: Pick<LaneRunJournalPort, 'listForRun' | 'listForRuns'>,
  runIds: readonly string[],
  isPast: () => boolean,
): Promise<JournalListsRead> {
  const listForRuns = journal.listForRuns;
  if (listForRuns !== undefined) {
    let grouped: ReadonlyMap<string, readonly LaneRunJournalEntryRecord[]>;
    try {
      grouped = await listForRuns.call(journal, runIds);
    } catch {
      return { ok: false, reason: 'journal-unreadable' };
    }
    if (!(grouped instanceof Map)) {
      return { ok: false, reason: 'journal-unreadable' };
    }
    for (const runId of runIds) {
      const entries = grouped.get(runId);
      if (!grouped.has(runId) || !Array.isArray(entries)) {
        return { ok: false, reason: 'journal-unreadable' };
      }
    }
    return { ok: true, byRunId: grouped };
  }
  const byRunId = new Map<string, readonly LaneRunJournalEntryRecord[]>();
  for (const runId of runIds) {
    if (isPast()) {
      return { ok: false, reason: 'deadline-exceeded' };
    }
    let entries: readonly LaneRunJournalEntryRecord[];
    try {
      entries = await journal.listForRun(runId);
    } catch {
      return { ok: false, reason: 'journal-unreadable' };
    }
    if (!Array.isArray(entries)) {
      return { ok: false, reason: 'journal-unreadable' };
    }
    byRunId.set(runId, entries);
  }
  return { ok: true, byRunId };
}

type HeadResolutionRead =
  | { readonly ok: true; readonly attemptId: string; readonly headOid: string }
  | { readonly ok: false; readonly reason: ShadowConformanceRunsUnknown };

/**
 * Walk `run.attemptIds` newest first; every id is read (a throw or `null`
 * refuses — never an older-head fallback) and the first attempt with
 * collected artifacts and a 40-hex `headCommit` wins. No collected head on
 * any attempt is `head-unresolved`. Cost: linear in the capped run.
 */
async function resolveLatestCollectedHead(
  attempts: Pick<AttemptRepositoryPort, 'findAttemptById'>,
  run: LaneRunRecord,
  isPast: () => boolean,
): Promise<HeadResolutionRead> {
  for (let index = run.attemptIds.length - 1; index >= 0; index -= 1) {
    if (isPast()) {
      return { ok: false, reason: 'deadline-exceeded' };
    }
    const attemptId = run.attemptIds[index]!;
    let attempt: AttemptRecord | null;
    try {
      attempt = await attempts.findAttemptById(attemptId);
    } catch {
      return { ok: false, reason: 'attempt-unreadable' };
    }
    if (attempt === null) {
      return { ok: false, reason: 'attempt-unreadable' };
    }
    const headCommit = attempt.artifacts?.headCommit;
    if (attempt.artifacts !== null && typeof headCommit === 'string' && HEAD_HEX_40_PATTERN.test(headCommit)) {
      return { ok: true, attemptId, headOid: headCommit };
    }
  }
  return { ok: false, reason: 'head-unresolved' };
}

type ReceiptsRead =
  | { readonly ok: true; readonly reviews: readonly ReviewReceiptProjection[] }
  | { readonly ok: false; readonly reason: ShadowConformanceRunsUnknown };

/** The receipt read of one attempt at one head. Cost: O(1). */
async function readHeadReceipts(
  receipts: Pick<AcceptanceReceiptReadPort, 'readReceiptsForHead'>,
  attemptId: string,
  headOid: string,
): Promise<ReceiptsRead> {
  let read: ReadReceiptsForHeadResult;
  try {
    read = await receipts.readReceiptsForHead(attemptId, headOid);
  } catch {
    return { ok: false, reason: 'receipts-unavailable' };
  }
  if (read.outcome === 'found') {
    return { ok: true, reviews: read.review };
  }
  if (read.outcome === 'none') {
    return { ok: true, reviews: [] };
  }
  return { ok: false, reason: 'receipts-unavailable' };
}

/** One journal entry as the evaluator reads it; append order is the caller's. */
function toConformanceJournalEntry(entry: LaneRunJournalEntryRecord): ShadowConformanceJournalEntry {
  return {
    kind: entry.kind,
    key: entry.key,
    recordedAtIso: entry.recordedAtIso,
    outcome: entry.outcome,
    reasonCode: entry.reasonCode,
    state: entry.state,
  };
}

/** One review receipt as the evaluator reads it. */
function toConformanceReviewReceipt(receipt: ReviewReceiptProjection) {
  return { kind: receipt.kind, result: receipt.result };
}

/**
 * Read the conducted-run conformance facts for the runs whose pull requests
 * the shell merged in the window: each run's latest collected head, the
 * review receipts of that attempt at that head, and the run's journal.
 * Cost: linear in the capped input; the caps
 * (`SHADOW_CONFORMANCE_MAX_RUNS`, `SHADOW_CONFORMANCE_MAX_ENTRIES_PER_RUN`,
 * `SHADOW_FACTS_MAX_MERGED_PULL_REQUESTS`) are named constants.
 */
export async function readShadowConformanceRuns(
  deps: ShadowConformanceRunsDependencies,
  request: unknown,
): Promise<ShadowConformanceRunsRead> {
  const snapshot = readExactPlainRecord(request, REQUEST_KEYS);
  if (snapshot === null) {
    return refused('invalid-request');
  }
  const mergedPullRequests = readMergedPullRequestIds(snapshot.mergedPullRequests);
  if (mergedPullRequests === null) {
    return refused('invalid-request');
  }
  if (typeof snapshot.deadlineIso !== 'string' || !isZonedIsoDateTime(snapshot.deadlineIso)) {
    return refused('invalid-request');
  }
  const deadlineIso = snapshot.deadlineIso;
  const isPast = (): boolean => isPastDeadline(deps.nowIso, deadlineIso);
  if (isPast()) {
    return refused('deadline-exceeded');
  }

  let runRecords: readonly LaneRunRecord[];
  try {
    runRecords = await deps.runs.list();
  } catch {
    return refused('runs-unreadable');
  }
  if (!Array.isArray(runRecords)) {
    return refused('runs-unreadable');
  }
  const candidates = selectCandidateRuns(runRecords, mergedPullRequests);
  if (candidates.length > SHADOW_CONFORMANCE_MAX_RUNS) {
    return refused('too-many-runs');
  }
  if (isPast()) {
    return refused('deadline-exceeded');
  }

  const runIds = candidates.map((run) => run.runId);
  const journals = await readJournalLists(deps.journal, runIds, isPast);
  if (!journals.ok) {
    return refused(journals.reason);
  }
  for (const run of candidates) {
    const entries = journals.byRunId.get(run.runId);
    if (entries === undefined || entries.length > SHADOW_CONFORMANCE_MAX_ENTRIES_PER_RUN) {
      return refused('too-many-journal-entries');
    }
  }

  const runs: ShadowConformanceRun[] = [];
  for (const run of candidates) {
    const head = await resolveLatestCollectedHead(deps.attempts, run, isPast);
    if (!head.ok) {
      return refused(head.reason);
    }
    if (isPast()) {
      return refused('deadline-exceeded');
    }
    const receipts = await readHeadReceipts(deps.receipts, head.attemptId, head.headOid);
    if (!receipts.ok) {
      return refused(receipts.reason);
    }
    const entries = journals.byRunId.get(run.runId) ?? [];
    runs.push({
      runId: run.runId,
      tier: run.tier,
      pullRequest: run.prNumber!,
      headOid: head.headOid,
      reviewReceipts: receipts.reviews.map(toConformanceReviewReceipt),
      journal: entries.map(toConformanceJournalEntry),
    });
  }
  runs.sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
  return { status: 'ok', runs };
}
