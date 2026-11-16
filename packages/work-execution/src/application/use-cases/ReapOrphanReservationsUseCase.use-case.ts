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

/**
 * The request read through its own property descriptors: a plain object with
 * a boolean `dryRun` and a canonical `nowIso`, no forbidden own key and no
 * getter. Anything else — null, an array, a non-plain object, a Proxy with
 * throwing traps, a forbidden key, a throwing getter, a non-boolean
 * `dryRun`, a non-canonical `nowIso` — is invalid.
 */
function validateRequest(request: unknown): { readonly dryRun: boolean; readonly nowIso: string } | null {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
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

export class ReapOrphanReservationsUseCase implements ReapOrphanReservationsPort {
  constructor(private readonly deps: ReapOrphanReservationsDependencies) {}

  async reapOrphanReservations(request: ReapOrphanReservationsRequest): Promise<ReapOrphanReservationsResult> {
    const validated = validateRequest(request as unknown);
    if (validated === null) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
    const { dryRun, nowIso } = validated;
    const timeoutMs = this.deps.storeCallTimeoutMs ?? DEFAULT_STORE_CALL_TIMEOUT_MS;
    const maxReleasesPerPass = this.deps.maxReleasesPerPass ?? DEFAULT_MAX_RELEASES_PER_PASS;

    // Top-level reads are deadline-guarded and fail closed: an unreadable
    // store refuses the whole pass as unknown before anything is released.
    const reservationsRead = await callStore(() => this.deps.executionJournal.listActiveReservations(), timeoutMs);
    if (!reservationsRead.ok || !Array.isArray(reservationsRead.value)) {
      return { outcome: 'unknown', reason: 'reservations-unreadable' };
    }
    const runsRead = await callStore(() => this.deps.runRepo.list(), timeoutMs);
    if (!runsRead.ok || !Array.isArray(runsRead.value)) {
      return { outcome: 'unknown', reason: 'runs-unreadable' };
    }
    const reservations: readonly unknown[] = reservationsRead.value;
    const runs: readonly unknown[] = runsRead.value;

    // The attempt ids of the held reservations; each run naming one is read.
    const heldAttemptIds = new Set<string>();
    const reservationCount = Math.min(reservations.length, MAX_ORPHAN_RESERVATION_SCAN);
    for (let index = 0; index < reservationCount; index += 1) {
      const snap = snapshotPlainDataRecord(reservations[index]);
      if (snap === null || snap['held'] !== true || typeof snap['attemptId'] !== 'string' || (snap['attemptId'] as string).length === 0) {
        continue;
      }
      heldAttemptIds.add(snap['attemptId'] as string);
    }

    // The run state per run that lists a held reservation's attempt: read
    // from the run journal; an unreadable journal is 'unreadable' and the
    // classifier refuses to release on it.
    const runStates = new Map<string, ReturnType<typeof laneRunJournalState> | 'unreadable'>();
    const runCount = Math.min(runs.length, MAX_RUN_SCAN);
    for (let index = 0; index < runCount; index += 1) {
      const runSnap = snapshotPlainDataRecord(runs[index]);
      if (runSnap === null || typeof runSnap['runId'] !== 'string' || (runSnap['runId'] as string).length === 0) {
        continue;
      }
      const runId = runSnap['runId'] as string;
      let lists = false;
      const attemptIds = runSnap['attemptIds'];
      if (Array.isArray(attemptIds)) {
        const count = Math.min(attemptIds.length, MAX_ORPHAN_RESERVATION_SCAN);
        for (let attemptIndex = 0; attemptIndex < count; attemptIndex += 1) {
          const attemptId = attemptIds[attemptIndex];
          if (typeof attemptId === 'string' && heldAttemptIds.has(attemptId)) {
            lists = true;
            break;
          }
        }
      }
      if (!lists) {
        continue;
      }
      const journalRead = await callStore(() => this.deps.runJournal.listForRun(runId), timeoutMs);
      if (!journalRead.ok || !Array.isArray(journalRead.value)) {
        runStates.set(runId, 'unreadable');
        continue;
      }
      runStates.set(runId, laneRunJournalState(journalRead.value, runId));
    }

    // The attempt per held reservation's attempt id: known absence is null,
    // a failed or timed-out read is the 'unreadable' sentinel.
    const attemptsById = new Map<string, Awaited<ReturnType<typeof this.deps.attemptRepo.findAttemptById>> | 'unreadable'>();
    for (const attemptId of heldAttemptIds) {
      const attemptRead = await callStore(() => this.deps.attemptRepo.findAttemptById(attemptId), timeoutMs);
      attemptsById.set(attemptId, attemptRead.ok ? attemptRead.value : 'unreadable');
    }

    const classified = classifyOrphanReservations({
      reservations,
      runs,
      runStates,
      attemptsById,
      nowIso,
      graceMs: CRASHED_START_GRACE_MINUTES * 60_000,
    });

    const orphans: ReapOrphanReservationEntry[] = classified.orphans.map(asEntry);
    const reportOnly: ReapOrphanReservationReportOnlyEntry[] = classified.reportOnly.map((entry) => ({
      reservationId: entry.reservationId,
      attemptId: entry.attemptId,
      reason: 'no-run-unstarted',
      reservedAtIso: entry.reservedAtIso ?? '',
    }));
    const skipped: ReapOrphanReservationSkippedEntry[] = classified.skipped.map((entry) => ({
      reservationId: entry.reservationId,
      attemptId: entry.attemptId,
      reason: entry.reason as ReapOrphanReservationSkippedEntry['reason'],
    }));
    const unknown: ReapOrphanReservationUnknownEntry[] = classified.unknown.map((entry) => ({
      reservationId: entry.reservationId,
      attemptId: entry.attemptId,
      reason: entry.reason as ReapOrphanReservationUnknownEntry['reason'],
    }));

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

    let attemptedReleases = 0;
    for (const orphan of orphans) {
      if (attemptedReleases >= maxReleasesPerPass) {
        failed.push({ reservationId: orphan.reservationId, attemptId: orphan.attemptId, reason: 'budget-exhausted' });
        continue;
      }
      attemptedReleases += 1;

      const releaseId = this.deps.newUlid();
      const keyResult = reaperRepairKey(orphan.reservationId, 'leaked-slot', releaseId);
      if (!keyResult.ok) {
        failed.push({ reservationId: orphan.reservationId, attemptId: orphan.attemptId, reason: 'invalid-key' });
        continue;
      }

      // Intent before action: a failed intent append never releases.
      const intentAppend = await callStore(
        () => this.deps.runJournal.append(intentEntry(keyResult.key, releaseId, nowIso, this.deps.newUlid())),
        timeoutMs,
      );
      if (!intentAppend.ok || intentAppend.value.outcome !== 'appended') {
        failed.push({ reservationId: orphan.reservationId, attemptId: orphan.attemptId, reason: 'intent-failed' });
        continue;
      }

      const attemptRead = attemptsById.get(orphan.attemptId);
      const attempt = typeof attemptRead === 'object' && attemptRead !== null ? attemptRead : null;
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
                return fresh?.revision ?? (fresh === null ? 0 : null);
              } catch {
                return null;
              }
            },
          }),
        timeoutMs,
      );

      let journalOutcome: LaneRunJournalOutcome;
      let failedReason: ReapOrphanReservationFailedEntry['reason'] | null = null;
      if (!release.ok) {
        journalOutcome = 'ambiguous';
        failedReason = 'ambiguous';
      } else if (release.value.outcome === 'released') {
        journalOutcome = 'completed';
      } else if (release.value.outcome === 'unknown') {
        journalOutcome = 'ambiguous';
        failedReason = 'ambiguous';
      } else {
        const mapping = releaseOutcomeMapping(release.value.outcome);
        journalOutcome = mapping.journal;
        failedReason = mapping.failedReason;
      }

      if (journalOutcome === 'completed') {
        released.push(orphan);
      } else {
        failed.push({ reservationId: orphan.reservationId, attemptId: orphan.attemptId, reason: failedReason ?? 'ambiguous' });
      }

      const resultAppend = await callStore(
        () => this.deps.runJournal.append(resultEntry(keyResult.key, nowIso, this.deps.newUlid(), journalOutcome, failedReason)),
        timeoutMs,
      );
      if (!resultAppend.ok || resultAppend.value.outcome !== 'appended') {
        journalFailed.push({ reservationId: orphan.reservationId, attemptId: orphan.attemptId, reason: 'result-append-failed' });
      }
    }

    const byReservationId = <T extends { readonly reservationId: string }>(list: T[]): T[] =>
      list.sort((left, right) => byCodeUnit(left.reservationId, right.reservationId));
    orphans.sort((left, right) => byCodeUnit(left.reservationId, right.reservationId));
    reportOnly.sort((left, right) => byCodeUnit(left.reservationId, right.reservationId));
    skipped.sort((left, right) => byCodeUnit(left.reservationId, right.reservationId));
    unknown.sort((left, right) => byCodeUnit(left.reservationId, right.reservationId));
    byReservationId(released);
    byReservationId(failed);
    byReservationId(journalFailed);

    return { outcome: 'reaped', dryRun: false, orphans, reportOnly, released, skipped, failed, journalFailed, unknown };
  }
}
