// @generated inbound contract scaffold — refined for OG22a.
/**
 * ReapOrphanReservationsPort: on the operator's explicit request, classify
 * every held capacity reservation and release only `terminal-run` orphans
 * through the fenced release with intent before action. A reservation no run
 * lists is never released: past the grace, with the attempt absent or
 * `intent-recorded`, it is listed in `reportOnly` (`no-run-unstarted`) only;
 * inside the grace it is neither reported nor released. A dry run releases
 * nothing and writes nothing.
 */

import type { LaneRunJournalOutcome } from '../../../domain/lane-run-journal.js';

export interface ReapOrphanReservationsRequest {
  /** Dry run: classify exactly like a real run, but write nothing and call no release. */
  readonly dryRun: boolean;
  /** The moment the pass is recorded; canonical ISO-8601 with a zone. */
  readonly nowIso: string;
}

/** One released orphan: a held reservation whose every listing run is terminal and whose attempt is finished. */
export interface ReapOrphanReservationEntry {
  readonly reservationId: string;
  readonly attemptId: string;
  readonly reason: 'terminal-run';
  readonly workOrderId: string | null;
  readonly hostName: string | null;
  readonly slotIndex: number | null;
  readonly reservedAtIso: string;
}

/** A reservation no run lists, past the grace, with the attempt absent or `intent-recorded`: reported, never released. */
export interface ReapOrphanReservationReportOnlyEntry {
  readonly reservationId: string;
  readonly attemptId: string;
  readonly reason: 'no-run-unstarted';
  readonly reservedAtIso: string;
}

/** Why a release was not attempted or did not confirm. */
export type ReapOrphanReservationFailedReason =
  | 'unfenced'
  | 'invalid-key'
  | 'intent-failed'
  | 'not-held'
  | 'changed'
  | 'refused'
  | 'ambiguous'
  | 'budget-exhausted';

/** A release that was not attempted or did not confirm, with the typed reason. */
export interface ReapOrphanReservationFailedEntry {
  readonly reservationId: string;
  readonly attemptId: string;
  readonly reason: ReapOrphanReservationFailedReason;
}

/** A result journal entry that could not be appended after a release attempt. */
export interface ReapOrphanReservationJournalFailureEntry {
  readonly reservationId: string;
  readonly attemptId: string;
  readonly reason: 'result-append-failed';
}

/** A reservation that is not a candidate, with why. */
export interface ReapOrphanReservationSkippedEntry {
  readonly reservationId: string;
  readonly attemptId: string;
  readonly reason: 'live-run' | 'within-grace' | 'attempt-live';
}

/** A reservation the pass could not classify; reported, never released. */
export interface ReapOrphanReservationUnknownEntry {
  readonly reservationId: string;
  readonly attemptId: string;
  readonly reason: 'run-state-unknown' | 'attempt-unreadable' | 'malformed-reservation';
}

/** The journal outcome a release attempt is recorded with. */
export type ReapOrphanReservationJournalOutcome = LaneRunJournalOutcome;

export type ReapOrphanReservationsResult =
  | {
      readonly outcome: 'reaped';
      readonly dryRun: boolean;
      readonly orphans: readonly ReapOrphanReservationEntry[];
      readonly reportOnly: readonly ReapOrphanReservationReportOnlyEntry[];
      readonly released: readonly ReapOrphanReservationEntry[];
      readonly skipped: readonly ReapOrphanReservationSkippedEntry[];
      readonly failed: readonly ReapOrphanReservationFailedEntry[];
      readonly journalFailed: readonly ReapOrphanReservationJournalFailureEntry[];
      readonly unknown: readonly ReapOrphanReservationUnknownEntry[];
    }
  | { readonly outcome: 'refused'; readonly reason: 'invalid-request' | 'invalid-max-releases-per-pass' }
  | { readonly outcome: 'unknown'; readonly reason: 'reservations-unreadable' | 'runs-unreadable' };

export interface ReapOrphanReservationsPort {
  reapOrphanReservations(request: ReapOrphanReservationsRequest): Promise<ReapOrphanReservationsResult>;
}
