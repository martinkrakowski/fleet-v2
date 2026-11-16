// @generated use-case scaffold — refined for OG22a.
/**
 * ReapOrphanReservationsUseCase: on the operator's explicit request, classify
 * every held capacity reservation through the pure domain classifier and
 * release only `terminal-run` orphans — a reservation every listing run holds
 * in a terminal state and whose attempt is in a capacity-release state. A
 * reservation no run lists is never released: past the grace, with the
 * attempt absent or `intent-recorded`, it is reported (`no-run-unstarted`)
 * only; inside the grace it is neither reported nor released. Every release
 * is fenced (`releaseCapacityReservationIfUnchanged`, never the unfenced
 * `releaseCapacityReservation`) and keyed with intent before action; a dry
 * run writes nothing and calls no release.
 */

import { isCanonicalIso } from '../../domain/lane-activity-records.js';
import { classifyOrphanReservations, MAX_ORPHAN_RESERVATION_SCAN, MAX_RUN_SCAN } from '../../domain/orphan-reservations.js';
import {
  LANE_RUN_JOURNAL_ENTRY_VERSION,
  laneRunJournalState,
  type LaneRunJournalEntryRecord,
  type LaneRunJournalOutcome,
} from '../../domain/lane-run-journal.js';
import { reaperRepairKey } from '../../domain/lane-run-keys.js';
import { snapshotPlainDataRecord } from '../../domain/plain-record-reads.js';
import { CRASHED_START_GRACE_MINUTES } from '../ports/in/InspectLaneRunsPort.in-port.js';
import type {
  ReapOrphanReservationEntry,
  ReapOrphanReservationFailedEntry,
  ReapOrphanReservationJournalFailureEntry,
  ReapOrphanReservationReportOnlyEntry,
  ReapOrphanReservationSkippedEntry,
  ReapOrphanReservationUnknownEntry,
  ReapOrphanReservationsPort,
  ReapOrphanReservationsRequest,
  ReapOrphanReservationsResult,
} from '../ports/in/ReapOrphanReservationsPort.in-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../ports/out/ExecutionJournalPort.out-port.js';
import type { LaneRunJournalPort } from '../ports/out/LaneRunJournalPort.out-port.js';
import type { LaneRunRepositoryPort } from '../ports/out/LaneRunRepositoryPort.out-port.js';

/** The reads and writes the reap needs; narrowed so composition supplies only what it has. */
export interface ReapOrphanReservationsDependencies {
  /** Never calls the unfenced `releaseCapacityReservation`. */
  readonly executionJournal: Pick<ExecutionJournalPort, 'listActiveReservations' | 'releaseCapacityReservationIfUnchanged'>;
  readonly runRepo: Pick<LaneRunRepositoryPort, 'list'>;
  readonly runJournal: Pick<LaneRunJournalPort, 'append' | 'listForRun'>;
  readonly attemptRepo: Pick<AttemptRepositoryPort, 'findAttemptById'>;
  readonly newUlid: () => string;
  /** The deadline of one outbound store call. Default 15 s. */
  readonly storeCallTimeoutMs?: number;
  /** The largest number of fenced releases one pass attempts. Default 64. */
  readonly maxReleasesPerPass?: number;
}

/** The default deadline of one outbound call. */
const DEFAULT_STORE_CALL_TIMEOUT_MS = 15_000;

/** The default budget of fenced releases per pass. */
const DEFAULT_MAX_RELEASES_PER_PASS = 64;

/** The forbidden own keys of a request; a request carrying any is refused. */
const FORBIDDEN_REQUEST_KEYS = ['__proto__', 'constructor', 'prototype'] as const;

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The deadline guard: the call's own answer, or a throw when it runs past `timeoutMs`. */
class StoreCallTimeoutError extends Error {}

async function withBudget<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StoreCallTimeoutError('store call exceeded its budget')), timeoutMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** One guarded store call's outcome: the value, or a failure (throw or timeout). */
type StoreCallResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

async function callStore<T>(call: () => Promise<T>, timeoutMs: number): Promise<StoreCallResult<T>> {
  try {
    return { ok: true, value: await withBudget(call(), timeoutMs) };
  } catch {
    return { ok: false };
  }
}

/** `Array.isArray` behind a guard: a revoked Proxy throws instead of answering. */
function safeIsArray(value: unknown): boolean {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

/** A store array whose `.length` read throws (a hostile Proxy) is unreadable, not empty. */
function hasReadableLength(value: unknown): boolean {
  try {
    void (value as { readonly length?: unknown }).length;
    return true;
  } catch {
    return false;
  }
}

/** `.length` read once and clamped: a lying or hostile length cannot unbound a loop. */
function safeLength(value: unknown, max: number): number {
  try {
    const raw = (value as { readonly length?: unknown }).length;
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), max) : 0;
  } catch {
    return 0;
  }
}

/** One element read behind a guard; a throwing Proxy get trap reads as absent. */
function safeElementAt(
  list: readonly unknown[],
  index: number,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: list[index] };
  } catch {
    return { ok: false };
  }
}

/**
 * The request read through its own property descriptors: a plain object with
 * a boolean `dryRun` and a canonical `nowIso`, no forbidden own key and no
 * getter. Anything else — null, an array, a non-plain object, a Proxy with
 * throwing traps, a forbidden key, a throwing getter, a non-boolean
 * `dryRun`, a non-canonical `nowIso` — is invalid.
 */
function validateRequest(request: unknown): { readonly dryRun: boolean; readonly nowIso: string } | null {
  let isRequestArray = false;
  try {
    isRequestArray = Array.isArray(request);
  } catch {
    // A revoked Proxy throws on the internal slots `Array.isArray` reads.
    return null;
  }
  if (typeof request !== 'object' || request === null || isRequestArray) {
    return null;
  }
  let snap: Record<string, unknown> | null;
  try {
    snap = snapshotPlainDataRecord(request);
  } catch {
    return null;
  }
  if (snap === null) {
    return null;
  }
  for (const forbidden of FORBIDDEN_REQUEST_KEYS) {
    if (Object.prototype.hasOwnProperty.call(snap, forbidden)) {
      return null;
    }
  }
  if (typeof snap['dryRun'] !== 'boolean' || !isCanonicalIso(snap['nowIso'])) {
    return null;
  }
  return { dryRun: snap['dryRun'], nowIso: snap['nowIso'] };
}

/** The journal entry the pass records before one release. */
function intentEntry(key: string, releaseId: string, nowIso: string, entryId: string): LaneRunJournalEntryRecord {
  return {
    version: LANE_RUN_JOURNAL_ENTRY_VERSION,
    entryId,
    kind: 'intent',
    key,
    runId: null,
    recordedAtIso: nowIso,
    mode: null,
    expectedRevision: null,
    mintedId: releaseId,
    outcome: null,
    reasonCode: null,
    detail: null,
    grantId: null,
    state: null,
  };
}

/** The journal entry the pass records after one release attempt. */
function resultEntry(key: string, nowIso: string, entryId: string, outcome: LaneRunJournalOutcome, reasonCode: string | null): LaneRunJournalEntryRecord {
  return {
    version: LANE_RUN_JOURNAL_ENTRY_VERSION,
    entryId,
    kind: 'result',
    key,
    runId: null,
    recordedAtIso: nowIso,
    mode: null,
    expectedRevision: null,
    mintedId: null,
    outcome,
    reasonCode,
    detail: null,
    grantId: null,
    state: null,
  };
}

/**
 * The journal outcome and failed-entry reason one non-`released` fenced
 * release outcome maps to; a `released` outcome is handled before this is
 * called and never becomes a failure.
 */
function releaseOutcomeMapping(outcome: 'not-held' | 'changed' | 'refused' | 'unknown'): { readonly journal: LaneRunJournalOutcome; readonly failedReason: ReapOrphanReservationFailedEntry['reason'] } {
  switch (outcome) {
    case 'not-held':
      return { journal: 'not-started', failedReason: 'not-held' };
    case 'changed':
      return { journal: 'refused', failedReason: 'changed' };
    case 'refused':
      return { journal: 'refused', failedReason: 'refused' };
    case 'unknown':
      return { journal: 'ambiguous', failedReason: 'ambiguous' };
  }
}

const asEntry = (
  classified: { readonly reservationId: string; readonly attemptId: string; readonly workOrderId: string | null; readonly hostName: string | null; readonly slotIndex: number | null; readonly reservedAtIso: string | null },
): ReapOrphanReservationEntry => ({
  reservationId: classified.reservationId,
  attemptId: classified.attemptId,
  reason: 'terminal-run',
  workOrderId: classified.workOrderId,
  hostName: classified.hostName,
  slotIndex: classified.slotIndex,
  reservedAtIso: classified.reservedAtIso ?? '',
});

/** The attempt ids of the held reservations; unreadable or not-held elements are skipped. */
function readHeldAttemptIds(reservations: readonly unknown[]): Set<string> {
  const held = new Set<string>();
  const count = safeLength(reservations, MAX_ORPHAN_RESERVATION_SCAN);
  for (let index = 0; index < count; index += 1) {
    const element = safeElementAt(reservations, index);
    const attemptId = element.ok ? heldAttemptIdOf(element.value) : null;
    if (attemptId !== null) {
      held.add(attemptId);
    }
  }
  return held;
}

function heldAttemptIdOf(value: unknown): string | null {
  let snap: Record<string, unknown> | null;
  try {
    snap = snapshotPlainDataRecord(value);
  } catch {
    return null;
  }
  if (snap === null || snap['held'] !== true) {
    return null;
  }
  const attemptId = snap['attemptId'];
  return typeof attemptId === 'string' && attemptId.length > 0 ? attemptId : null;
}

/** True when the run's `attemptIds` names a held attempt; every read is guarded. */
function listsHeldAttempt(attemptIds: unknown, held: ReadonlySet<string>): boolean {
  if (!safeIsArray(attemptIds)) {
    return false;
  }
  const count = safeLength(attemptIds, MAX_ORPHAN_RESERVATION_SCAN);
  for (let index = 0; index < count; index += 1) {
    const element = safeElementAt(attemptIds as readonly unknown[], index);
    if (element.ok && typeof element.value === 'string' && held.has(element.value)) {
      return true;
    }
  }
  return false;
}

/** The run id of a run that lists a held attempt, or null. */
function runIdListingHeld(runElement: unknown, held: ReadonlySet<string>): string | null {
  let runSnap: Record<string, unknown> | null;
  try {
    runSnap = snapshotPlainDataRecord(runElement);
  } catch {
    return null;
  }
  if (runSnap === null || typeof runSnap['runId'] !== 'string' || runSnap['runId'].length === 0) {
    return null;
  }
  return listsHeldAttempt(runSnap['attemptIds'], held) ? runSnap['runId'] : null;
}

/** Orphan entries are mapped to the port's four entry lists. */
function entriesOf(classified: ReturnType<typeof classifyOrphanReservations>): {
  readonly orphans: ReapOrphanReservationEntry[];
  readonly reportOnly: ReapOrphanReservationReportOnlyEntry[];
  readonly skipped: ReapOrphanReservationSkippedEntry[];
  readonly unknown: ReapOrphanReservationUnknownEntry[];
} {
  return {
    orphans: classified.orphans.map(asEntry),
    reportOnly: classified.reportOnly.map((entry) => ({
      reservationId: entry.reservationId,
      attemptId: entry.attemptId,
      reason: 'no-run-unstarted',
      reservedAtIso: entry.reservedAtIso ?? '',
    })),
    skipped: classified.skipped.map((entry) => ({
      reservationId: entry.reservationId,
      attemptId: entry.attemptId,
      reason: entry.reason as ReapOrphanReservationSkippedEntry['reason'],
    })),
    unknown: classified.unknown.map((entry) => ({
      reservationId: entry.reservationId,
      attemptId: entry.attemptId,
      reason: entry.reason as ReapOrphanReservationUnknownEntry['reason'],
    })),
  };
}

/** The journal outcome and failed reason of one release call. */
function releaseVerdict(release: StoreCallResult<{ readonly outcome: 'released' | 'not-held' | 'changed' | 'refused' | 'unknown' }>): {
  readonly journalOutcome: LaneRunJournalOutcome;
  readonly failedReason: ReapOrphanReservationFailedEntry['reason'] | null;
} {
  if (!release.ok || release.value.outcome === 'unknown') {
    return { journalOutcome: 'ambiguous', failedReason: 'ambiguous' };
  }
  if (release.value.outcome === 'released') {
    return { journalOutcome: 'completed', failedReason: null };
  }
  const mapping = releaseOutcomeMapping(release.value.outcome);
  return { journalOutcome: mapping.journal, failedReason: mapping.failedReason };
}

/**
 * The revision a re-read attempt reads as: an absent attempt and an absent
 * revision on a present attempt read as 0; a wrong-typed or negative
 * revision is unreadable (null).
 */
function revisionOf(attempt: { readonly revision?: unknown } | null | undefined): number | null {
  if (attempt === null) {
    return 0;
  }
  if (attempt === undefined) {
    return null;
  }
  const revision = attempt.revision;
  if (revision === undefined) {
    return 0;
  }
  return typeof revision === 'number' && Number.isInteger(revision) && revision >= 0 ? revision : null;
}

/**
 * The reservations list copied behind guards with `.length` read exactly once,
 * so a hostile list cannot answer differently on a later read. A list that is
 * not an array, whose length read throws, or that is longer than the scan cap
 * is never partially classified: it answers null and the whole pass fails
 * closed as unknown with nothing released. An unreadable element copies as
 * `undefined`, which the classifier already skips.
 */
function snapshotReservations(value: unknown): unknown[] | null {
  if (!safeIsArray(value)) {
    return null;
  }
  let rawLength: unknown;
  try {
    rawLength = (value as { readonly length?: unknown }).length;
  } catch {
    return null;
  }
  if (typeof rawLength === 'number' && rawLength > MAX_ORPHAN_RESERVATION_SCAN) {
    return null;
  }
  const count = typeof rawLength === 'number' && Number.isFinite(rawLength) && rawLength > 0 ? Math.floor(rawLength) : 0;
  const copy: unknown[] = [];
  for (let index = 0; index < count; index += 1) {
    const element = safeElementAt(value as readonly unknown[], index);
    copy.push(element.ok ? element.value : undefined);
  }
  return copy;
}

const sortByReservationId = <T extends { readonly reservationId: string }>(list: T[]): T[] =>
  list.sort((left, right) => byCodeUnit(left.reservationId, right.reservationId));

export class ReapOrphanReservationsUseCase implements ReapOrphanReservationsPort {
  constructor(private readonly deps: ReapOrphanReservationsDependencies) {}

  async reapOrphanReservations(request: ReapOrphanReservationsRequest): Promise<ReapOrphanReservationsResult> {
    const validated = validateRequest(request as unknown);
    if (validated === null) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
    const { dryRun, nowIso } = validated;
    const timeoutMs = this.deps.storeCallTimeoutMs ?? DEFAULT_STORE_CALL_TIMEOUT_MS;

    // Top-level reads are deadline-guarded and fail closed: an unreadable
    // store refuses the whole pass as unknown before anything is released.
    const reservationsRead = await callStore(() => this.deps.executionJournal.listActiveReservations(), timeoutMs);
    const reservations = reservationsRead.ok ? snapshotReservations(reservationsRead.value) : null;
    if (reservations === null) {
      return { outcome: 'unknown', reason: 'reservations-unreadable' };
    }
    const runsRead = await callStore(() => this.deps.runRepo.list(), timeoutMs);
    if (!runsRead.ok || !safeIsArray(runsRead.value) || !hasReadableLength(runsRead.value)) {
      return { outcome: 'unknown', reason: 'runs-unreadable' };
    }
    const runs: readonly unknown[] = runsRead.value;

    const heldAttemptIds = readHeldAttemptIds(reservations);
    const runStates = await this.readRunStates(runs, heldAttemptIds, timeoutMs);
    const attemptsById = await this.readAttempts(heldAttemptIds, timeoutMs);

    const classified = classifyOrphanReservations({
      reservations,
      runs,
      runStates,
      attemptsById,
      nowIso,
      graceMs: CRASHED_START_GRACE_MINUTES * 60_000,
    });
    const { orphans, reportOnly, skipped, unknown } = entriesOf(classified);

    if (dryRun) {
      return { outcome: 'reaped', dryRun: true, orphans, reportOnly, released: [], skipped, failed: [], journalFailed: [], unknown };
    }

    const released: ReapOrphanReservationEntry[] = [];
    const failed: ReapOrphanReservationFailedEntry[] = [];
    const journalFailed: ReapOrphanReservationJournalFailureEntry[] = [];

    // Fail closed before any intent append: without the fenced method the
    // unfenced `releaseCapacityReservation` is never called.
    if (this.deps.executionJournal.releaseCapacityReservationIfUnchanged === undefined) {
      for (const orphan of orphans) {
        failed.push({ reservationId: orphan.reservationId, attemptId: orphan.attemptId, reason: 'unfenced' });
      }
      return { outcome: 'reaped', dryRun: false, orphans, reportOnly, released, skipped, failed, journalFailed, unknown };
    }

    const maxReleasesPerPass = this.deps.maxReleasesPerPass ?? DEFAULT_MAX_RELEASES_PER_PASS;
    let attemptedReleases = 0;
    for (const orphan of orphans) {
      if (attemptedReleases >= maxReleasesPerPass) {
        failed.push({ reservationId: orphan.reservationId, attemptId: orphan.attemptId, reason: 'budget-exhausted' });
        continue;
      }
      attemptedReleases += 1;
      await this.releaseOne(orphan, attemptsById, nowIso, timeoutMs, { released, failed, journalFailed });
    }

    for (const list of [orphans, reportOnly, skipped, unknown, released, failed, journalFailed]) {
      sortByReservationId(list as { readonly reservationId: string }[]);
    }
    return { outcome: 'reaped', dryRun: false, orphans, reportOnly, released, skipped, failed, journalFailed, unknown };
  }

  /**
   * The run state per run that lists a held reservation's attempt, read from
   * the run journal; an unreadable journal is 'unreadable' and the classifier
   * refuses to release on it.
   */
  private async readRunStates(
    runs: readonly unknown[],
    heldAttemptIds: ReadonlySet<string>,
    timeoutMs: number,
  ): Promise<Map<string, ReturnType<typeof laneRunJournalState> | 'unreadable'>> {
    const runStates = new Map<string, ReturnType<typeof laneRunJournalState> | 'unreadable'>();
    const runCount = safeLength(runs, MAX_RUN_SCAN);
    for (let index = 0; index < runCount; index += 1) {
      const runElement = safeElementAt(runs, index);
      const runId = runElement.ok ? runIdListingHeld(runElement.value, heldAttemptIds) : null;
      if (runId === null) {
        continue;
      }
      const journalRead = await callStore(() => this.deps.runJournal.listForRun(runId), timeoutMs);
      if (!journalRead.ok || !safeIsArray(journalRead.value)) {
        runStates.set(runId, 'unreadable');
        continue;
      }
      try {
        runStates.set(runId, laneRunJournalState(journalRead.value, runId));
      } catch {
        runStates.set(runId, 'unreadable');
      }
    }
    return runStates;
  }

  /** The attempt per held attempt id: known absence is null, a failed or timed-out read is 'unreadable'. */
  private async readAttempts(
    heldAttemptIds: ReadonlySet<string>,
    timeoutMs: number,
  ): Promise<Map<string, Awaited<ReturnType<AttemptRepositoryPort['findAttemptById']>> | 'unreadable'>> {
    const attemptsById = new Map<string, Awaited<ReturnType<AttemptRepositoryPort['findAttemptById']>> | 'unreadable'>();
    for (const attemptId of heldAttemptIds) {
      const attemptRead = await callStore(() => this.deps.attemptRepo.findAttemptById(attemptId), timeoutMs);
      attemptsById.set(attemptId, attemptRead.ok ? attemptRead.value : 'unreadable');
    }
    return attemptsById;
  }

  /** One fenced release with intent before action and a result entry after; outcomes go into `sinks`. */
  private async releaseOne(
    orphan: ReapOrphanReservationEntry,
    attemptsById: ReadonlyMap<string, unknown>,
    nowIso: string,
    timeoutMs: number,
    sinks: {
      readonly released: ReapOrphanReservationEntry[];
      readonly failed: ReapOrphanReservationFailedEntry[];
      readonly journalFailed: ReapOrphanReservationJournalFailureEntry[];
    },
  ): Promise<void> {
    const releaseId = this.deps.newUlid();
    const keyResult = reaperRepairKey(orphan.reservationId, 'leaked-slot', releaseId);
    if (!keyResult.ok) {
      sinks.failed.push({ reservationId: orphan.reservationId, attemptId: orphan.attemptId, reason: 'invalid-key' });
      return;
    }

    // Intent before action: a failed intent append never releases.
    const intentAppend = await callStore(
      () => this.deps.runJournal.append(intentEntry(keyResult.key, releaseId, nowIso, this.deps.newUlid())),
      timeoutMs,
    );
    if (!intentAppend.ok || intentAppend.value.outcome !== 'appended') {
      sinks.failed.push({ reservationId: orphan.reservationId, attemptId: orphan.attemptId, reason: 'intent-failed' });
      return;
    }

    const attemptRead = attemptsById.get(orphan.attemptId);
    const attempt = typeof attemptRead === 'object' && attemptRead !== null ? (attemptRead as { readonly revision?: number }) : null;
    const release = await callStore(
      () =>
        this.deps.executionJournal.releaseCapacityReservationIfUnchanged!({
          attemptId: orphan.attemptId,
          reservationId: orphan.reservationId,
          attemptRevision: attempt?.revision ?? 0,
          releasedAtIso: nowIso,
          readAttemptRevision: async () => {
            try {
              const fresh = await withBudget(this.deps.attemptRepo.findAttemptById(orphan.attemptId), timeoutMs);
              return revisionOf(fresh);
            } catch {
              return null;
            }
          },
        }),
      timeoutMs,
    );

    const { journalOutcome, failedReason } = releaseVerdict(release);
    if (journalOutcome === 'completed') {
      sinks.released.push(orphan);
    } else {
      sinks.failed.push({ reservationId: orphan.reservationId, attemptId: orphan.attemptId, reason: failedReason ?? 'ambiguous' });
    }

    const resultAppend = await callStore(
      () => this.deps.runJournal.append(resultEntry(keyResult.key, nowIso, this.deps.newUlid(), journalOutcome, failedReason)),
      timeoutMs,
    );
    if (!resultAppend.ok || resultAppend.value.outcome !== 'appended') {
      sinks.journalFailed.push({ reservationId: orphan.reservationId, attemptId: orphan.attemptId, reason: 'result-append-failed' });
    }
  }
}
