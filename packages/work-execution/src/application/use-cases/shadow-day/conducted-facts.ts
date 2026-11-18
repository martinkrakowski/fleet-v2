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

/**
 * Cap on every stored run a shadow-day reader will read. This is the
 * candidates cap of `readShadowConformanceRuns` (the domain's
 * `SHADOW_CONFORMANCE_MAX_RUNS`), named here so SH18b's head reader applies
 * the same bound. An over-cap list is refused before any element is read.
 */
export const SHADOW_FACTS_MAX_RUNS = SHADOW_CONFORMANCE_MAX_RUNS;

/**
 * RC1 (owner decision 2026-11-18): the early-warning threshold of
 * `cutover shadow record-day`. The lane-run store holding more than this many
 * runs prints a warning to `stderr`; the hard cap (`SHADOW_FACTS_MAX_RUNS`)
 * is deferred and this warning never changes the command's result.
 */
export const SHADOW_FACTS_WARN_RUNS = 1500;

/**
 * RC1: the scan cap of `checkLaneRunWarnCount`. Cost is bounded linearly in
 * the input; a length past this cap is refused before any traversal.
 */
export const SHADOW_FACTS_WARN_MAX_SCAN = 100_000;

/**
 * Cap on one run's `attemptIds` walk. An over-cap list is refused before any
 * attempt is read.
 */
export const SHADOW_FACTS_MAX_ATTEMPTS_PER_RUN = 100;

/**
 * Cap on one head's review-receipts list. An over-cap list is refused before
 * any receipt is read.
 */
export const SHADOW_FACTS_MAX_RECEIPTS_PER_HEAD = SHADOW_CONFORMANCE_MAX_ENTRIES_PER_RUN;

/** The read-only dependencies the conducted-run facts need. */
export interface ShadowConformanceRunsDependencies {
  readonly runs: Pick<LaneRunRepositoryPort, 'list'>;
  readonly journal: Pick<LaneRunJournalPort, 'listForRun' | 'listForRuns'>;
  readonly attempts: Pick<AttemptRepositoryPort, 'findAttemptById'>;
  readonly receipts: Pick<AcceptanceReceiptReadPort, 'readReceiptsForHead'>;
  readonly nowIso: () => string;
}

/**
 * Why a shadow-day facts read is `unknown`. The common union every
 * shadow-day reader (SH18a's runs reader, SH18b's head reader) refuses
 * with; a reader narrows it by only producing its own codes.
 */
export type ShadowConductedFactsUnknown =
  | 'invalid-request'
  | 'runs-unreadable'
  | 'journal-unreadable'
  | 'attempt-unreadable'
  | 'head-unresolved'
  | 'receipts-unavailable'
  | 'too-many-runs'
  | 'too-many-journal-entries'
  | 'too-many-attempts'
  | 'too-many-receipts'
  | 'too-many-heads'
  | 'forge-read-missing'
  | 'forge-unavailable'
  | 'deadline-exceeded';

/** Why the whole conducted-run answer is `unknown`. */
export type ShadowConformanceRunsUnknown = ShadowConductedFactsUnknown;

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
 * The interior refusal: any read of caller-supplied structure (the request,
 * a value copied out of it, a run or journal record, a repository ref) that
 * throws is turned into this fixed, message-free refusal; the reader's outer
 * catch turns it into the typed `unknown` result, so the reader never rejects
 * on hostile input. Generic over the refusing reader's reason union.
 */
export class FactsRefusal<R extends ShadowConductedFactsUnknown = ShadowConductedFactsUnknown> extends Error {
  constructor(readonly reason: R) {
    super('shadow-conformance-facts-refusal');
  }
}

/** Refuse with `reason`; always throws, so the caller's flow stops here. */
function refusal<R extends ShadowConductedFactsUnknown>(reason: R): never {
  throw new FactsRefusal(reason);
}

/**
 * Read caller-supplied structure through `read`; any throw becomes the
 * refusal for `reason` (an interior refusal keeps its own reason). Cost:
 * the cost of `read`.
 */
export function readOrRefuse<T, R extends ShadowConductedFactsUnknown>(
  reason: R,
  read: () => T,
): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof FactsRefusal) {
      throw error;
    }
    throw new FactsRefusal(reason);
  }
}

/**
 * The deadline check: a `nowIso` that throws, is not a zoned ISO time, or is
 * at or past `deadlineIso` (instant comparison, never string comparison)
 * reads as past the deadline. Cost: O(1).
 */
export function isPastDeadline(nowIso: () => string, deadlineIso: string): boolean {
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
 * Every own key is `length` or a canonical array index inside `length`: the
 * key's `String(Number(k))` form, a safe integer, below `length`. Anything
 * else — a symbol, a named key, a non-canonical digit string such as `"01"`,
 * an index beyond `length` — is refused.
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
    const asNumber = Number(key);
    if (!Number.isSafeInteger(asNumber) || String(asNumber) !== key || asNumber >= length) {
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
 * length or a foreign own key is refused before any traversal. `null` reads
 * as "not a merged pull-request list" — the caller refuses the request.
 */
export function readMergedPullRequestIds(value: unknown): ReadonlySet<number> | null {
  // A hostile container (e.g. a Proxy whose `ownKeys` or `getOwnPropertyDescriptor`
  // trap throws) must produce the typed refusal `null`, never a propagated throw —
  // the caller refuses the request, so any throw reads as "not a merged
  // pull-request list".
  try {
    return readMergedPullRequestIdsOrThrow(value);
  } catch {
    return null;
  }
}

function readMergedPullRequestIdsOrThrow(value: unknown): ReadonlySet<number> | null {
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

/** The typed outcome of `checkLaneRunWarnCount`. */
export type LaneRunWarnCountRead =
  | { readonly status: 'ok'; readonly count: number; readonly warn: boolean }
  | { readonly status: 'unknown'; readonly reason: 'runs-unreadable' };

/**
 * RC1: the pure early-warning count read behind `cutover shadow record-day`.
 * It validates the raw lane-run array as a real, dense data array — a wrong
 * primitive, a non-iterable object, an array-like, a hole, an accessor, a
 * foreign own key (including prototype-polluting names), an over-cap length
 * or a hostile container is refused — and reports the store's run count with
 * the early-warning verdict.
 *
 * Cost: linear in the capped input; the caps (`SHADOW_FACTS_WARN_MAX_SCAN`,
 * `MAX_ARRAY_LENGTH`) are named constants. Every failure path is fail-closed:
 * the typed `{ status: 'unknown', reason: 'runs-unreadable' }` refusal, never
 * a throw — a throwing `Proxy` trap reads as an unreadable source. Getters
 * are never invoked: descriptors are inspected, not evaluated.
 */
export function checkLaneRunWarnCount(value: unknown): LaneRunWarnCountRead {
  try {
    return checkLaneRunWarnCountOrThrow(value);
  } catch {
    return { status: 'unknown', reason: 'runs-unreadable' };
  }
}

function checkLaneRunWarnCountOrThrow(value: unknown): LaneRunWarnCountRead {
  if (!Array.isArray(value)) {
    return { status: 'unknown', reason: 'runs-unreadable' };
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined ||
    lengthDescriptor.get !== undefined ||
    typeof lengthDescriptor.value !== 'number'
  ) {
    return { status: 'unknown', reason: 'runs-unreadable' };
  }
  const length = lengthDescriptor.value;
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length >= MAX_ARRAY_LENGTH ||
    length > SHADOW_FACTS_WARN_MAX_SCAN
  ) {
    return { status: 'unknown', reason: 'runs-unreadable' };
  }
  if (!ownKeysAreIndices(value, length)) {
    return { status: 'unknown', reason: 'runs-unreadable' };
  }
  // Descriptors are read, never invoked: a hole (no descriptor) or an
  // accessor — a getter or a setter-only slot, which has no `get` — is
  // refused without evaluating any element. A data descriptor (`value`, no
  // accessor pair) is required.
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      return { status: 'unknown', reason: 'runs-unreadable' };
    }
  }
  return { status: 'ok', count: length, warn: length > SHADOW_FACTS_WARN_RUNS };
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
  const listForRuns = readOrRefuse('journal-unreadable', () => journal.listForRuns);
  if (listForRuns !== undefined) {
    if (isPast()) {
      return { ok: false, reason: 'deadline-exceeded' };
    }
    let grouped: ReadonlyMap<string, readonly LaneRunJournalEntryRecord[]>;
    try {
      grouped = await listForRuns.call(journal, runIds);
    } catch {
      return { ok: false, reason: 'journal-unreadable' };
    }
    if (!(grouped instanceof Map)) {
      return { ok: false, reason: 'journal-unreadable' };
    }
    readOrRefuse('journal-unreadable', () => {
      for (const runId of runIds) {
        if (!grouped.has(runId)) {
          refusal('journal-unreadable');
        }
      }
      // Every mapped value is validated, not only the requested ids: a
      // grouped map carrying a malformed extra entry is an unreadable
      // journal, not a shorter answer.
      for (const entries of grouped.values()) {
        if (!Array.isArray(entries)) {
          refusal('journal-unreadable');
        }
      }
    });
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
  const attemptIds = readOrRefuse('runs-unreadable', () => run.attemptIds);
  const attemptCount = readOrRefuse('runs-unreadable', () => attemptIds.length);
  if (attemptCount > SHADOW_FACTS_MAX_ATTEMPTS_PER_RUN) {
    return { ok: false, reason: 'too-many-attempts' };
  }
  for (let index = attemptCount - 1; index >= 0; index -= 1) {
    if (isPast()) {
      return { ok: false, reason: 'deadline-exceeded' };
    }
    const attemptId = readOrRefuse('attempt-unreadable', () => attemptIds[index]!);
    let attempt: AttemptRecord | null;
    try {
      attempt = await attempts.findAttemptById(attemptId);
    } catch {
      return { ok: false, reason: 'attempt-unreadable' };
    }
    if (attempt === null) {
      return { ok: false, reason: 'attempt-unreadable' };
    }
    const headCommit = readOrRefuse('attempt-unreadable', () => (attempt.artifacts === null ? null : attempt.artifacts.headCommit));
    if (headCommit !== null && typeof headCommit === 'string' && HEAD_HEX_40_PATTERN.test(headCommit)) {
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
  const found = readOrRefuse('receipts-unavailable', (): { readonly found: true; readonly reviews: readonly ReviewReceiptProjection[] } | null => {
    if (read.outcome === 'found') {
      return { found: true, reviews: read.review };
    }
    return null;
  });
  if (found !== null) {
    if (found.reviews.length > SHADOW_FACTS_MAX_RECEIPTS_PER_HEAD) {
      return { ok: false, reason: 'too-many-receipts' };
    }
    return { ok: true, reviews: found.reviews };
  }
  const outcome = readOrRefuse('receipts-unavailable', () => read.outcome);
  if (outcome === 'none') {
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
 * The whole read runs inside the outer refusal catch, so any throw from the
 * request, from a value copied out of it, from a run or journal record, or
 * from a repository ref becomes the typed `unknown` result — never a
 * rejection. Cost: linear in the capped input; the caps
 * (`SHADOW_CONFORMANCE_MAX_RUNS`, `SHADOW_CONFORMANCE_MAX_ENTRIES_PER_RUN`,
 * `SHADOW_FACTS_MAX_MERGED_PULL_REQUESTS`, `SHADOW_FACTS_MAX_ATTEMPTS_PER_RUN`,
 * `SHADOW_FACTS_MAX_RECEIPTS_PER_HEAD`) are named constants.
 */
export async function readShadowConformanceRuns(
  deps: ShadowConformanceRunsDependencies,
  request: unknown,
): Promise<ShadowConformanceRunsRead> {
  try {
    return await readConformanceRunsOrRefuse(deps, request);
  } catch (error) {
    if (error instanceof FactsRefusal) {
      return refused(error.reason);
    }
    // Every unexpected error — e.g. a revoked Proxy from `runs.list()` or from
    // the fallback `listForRun()` whose `Array.isArray` throws — becomes the
    // documented typed `unknown` result, never a rejection. The code names an
    // unreadable source: `runs-unreadable`.
    return refused('runs-unreadable');
  }
}

/** The interior read: every `unknown` outcome is a `FactsRefusal`. */
async function readConformanceRunsOrRefuse(
  deps: ShadowConformanceRunsDependencies,
  request: unknown,
): Promise<ShadowConformanceRunsRead> {
  const snapshot = readOrRefuse('invalid-request', () => readExactPlainRecord(request, REQUEST_KEYS));
  if (snapshot === null) {
    return refusal('invalid-request');
  }
  const mergedPullRequests = readOrRefuse('invalid-request', () => readMergedPullRequestIds(snapshot.mergedPullRequests));
  if (mergedPullRequests === null) {
    return refusal('invalid-request');
  }
  if (typeof snapshot.deadlineIso !== 'string' || !isZonedIsoDateTime(snapshot.deadlineIso)) {
    return refusal('invalid-request');
  }
  const deadlineIso = snapshot.deadlineIso;
  const isPast = (): boolean => isPastDeadline(readOrRefuse('deadline-exceeded', () => deps.nowIso), deadlineIso);
  if (isPast()) {
    return refusal('deadline-exceeded');
  }

  let runRecords: readonly LaneRunRecord[];
  try {
    runRecords = await deps.runs.list();
  } catch {
    return refusal('runs-unreadable');
  }
  if (!Array.isArray(runRecords)) {
    return refusal('runs-unreadable');
  }
  const candidates = readOrRefuse('runs-unreadable', () => selectCandidateRuns(runRecords, mergedPullRequests));
  if (candidates.length > SHADOW_CONFORMANCE_MAX_RUNS) {
    return refusal('too-many-runs');
  }
  if (isPast()) {
    return refusal('deadline-exceeded');
  }

  // `runId` is read off each candidate exactly once, here, and reused
  // everywhere below.
  const candidateRuns = readOrRefuse('runs-unreadable', () =>
    candidates.map((run) => ({ run, runId: run.runId })),
  );
  const runIds = candidateRuns.map((candidate) => candidate.runId);
  const journals = await readJournalLists(readOrRefuse('journal-unreadable', () => deps.journal), runIds, isPast);
  if (!journals.ok) {
    return refusal(journals.reason);
  }
  const cappedEntries = new Map<string, readonly LaneRunJournalEntryRecord[]>();
  for (const candidate of candidateRuns) {
    const entries = readOrRefuse('journal-unreadable', () => journals.byRunId.get(candidate.runId));
    // A missing map entry is an unreadable journal, not an entry-count
    // problem — and never defaulted to empty.
    if (entries === undefined) {
      return refusal('journal-unreadable');
    }
    const entryCount = readOrRefuse('journal-unreadable', () => entries.length);
    if (entryCount > SHADOW_CONFORMANCE_MAX_ENTRIES_PER_RUN) {
      return refusal('too-many-journal-entries');
    }
    cappedEntries.set(candidate.runId, entries);
  }

  const runs: ShadowConformanceRun[] = [];
  for (const candidate of candidateRuns) {
    const head = await resolveLatestCollectedHead(readOrRefuse('attempt-unreadable', () => deps.attempts), candidate.run, isPast);
    if (!head.ok) {
      return refusal(head.reason);
    }
    if (isPast()) {
      return refusal('deadline-exceeded');
    }
    const receipts = await readHeadReceipts(
      readOrRefuse('receipts-unavailable', () => deps.receipts),
      head.attemptId,
      head.headOid,
    );
    if (!receipts.ok) {
      return refusal(receipts.reason);
    }
    const entryRecords = readOrRefuse('journal-unreadable', () => cappedEntries.get(candidate.runId));
    if (entryRecords === undefined) {
      return refusal('journal-unreadable');
    }
    const journal = readOrRefuse('journal-unreadable', () => entryRecords.map(toConformanceJournalEntry));
    const reviewReceipts = readOrRefuse('receipts-unavailable', () => receipts.reviews.map(toConformanceReviewReceipt));
    const tier = readOrRefuse('runs-unreadable', () => candidate.run.tier);
    const pullRequest = readOrRefuse('runs-unreadable', () => candidate.run.prNumber!);
    runs.push({
      runId: candidate.runId,
      tier,
      pullRequest,
      headOid: head.headOid,
      reviewReceipts,
      journal,
    });
  }
  runs.sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
  return { status: 'ok', runs };
}
