// @generated outbound contract scaffold — refined for migration step 1.
/**
 * ExecutionJournalPort: atomically record intent, capacity and action
 * receipts. Intent is durable before the subprocess runs; a host has one
 * designated dispatcher until shared arbitration is implemented.
 */

import type {
  ActionJournalEntryRecord,
  CapacityReservationRecord,
} from '../../../domain/execution-records.js';

/** A capacity reservation before a physical slot index is assigned under the lock. */
export type CapacityReservationClaim = Omit<CapacityReservationRecord, 'slotIndex'>;

/** One attempt's claim on one slot under its host's shared budget. */
export interface ReserveCapacityAtomicallyRequest {
  /** The attempt claiming the slot; it must hold no active reservation. */
  readonly attemptId: string;
  /** The claiming host's shared slot budget. */
  readonly maxSlots: number;
  /** The reservation appended when the claim is granted; `slotIndex` is assigned under the lock. */
  readonly record: CapacityReservationClaim;
  /**
   * Busy-worktree arbitration, run under the reservations lock after the held
   * reservations are re-read (Opus note on #58). It receives the freshly read
   * held reservations and decides whether the claim's worktree is already
   * busy; a busy verdict refuses the claim without writing. Keeping the check
   * inside the lock means a conflicting reservation that lands while the
   * claim is in flight is still seen.
   */
  readonly checkBusyWorktree?: (
    held: readonly CapacityReservationRecord[],
  ) => Promise<BusyWorktreeCheck>;
}

/** The busy-worktree verdict of a claim, decided under the lock. */
export type BusyWorktreeCheck =
  | { readonly outcome: 'ok' }
  | { readonly outcome: 'busy-worktree'; readonly blockingAttemptId: string };

export type ReserveCapacityAtomicallyResult =
  | { readonly outcome: 'reserved'; readonly reservation: CapacityReservationRecord }
  | {
      readonly outcome: 'duplicate-attempt';
      readonly attemptId: string;
      readonly existingReservationId: string;
    }
  | {
      readonly outcome: 'busy-worktree';
      readonly blockingAttemptId: string;
    }
  | {
      readonly outcome: 'no-free-slot';
      readonly heldCount: number;
      readonly maxSlots: number;
    };

export interface ExecutionJournalPort {
  /** Append one journal entry; the journal is append-only evidence. */
  appendJournalEntry(entry: ActionJournalEntryRecord): Promise<void>;

  /** List the journal entries for one attempt in recorded order. */
  listJournalEntriesForAttempt(attemptId: string): Promise<readonly ActionJournalEntryRecord[]>;

  /**
   * Persist one capacity reservation or its release. A held claim never
   * supersedes another reservation for the same attempt; that refusal is an
   * error, never a silent replacement.
   */
  saveCapacityReservation(reservation: CapacityReservationRecord): Promise<void>;

  /** List held reservations, optionally narrowed to one host. */
  listActiveReservations(hostId?: string): Promise<readonly CapacityReservationRecord[]>;

  /** Release the held reservation for one attempt; false when none was held. */
  releaseCapacityReservation(attemptId: string, releasedAtIso: string): Promise<boolean>;

  /**
   * Reserve one slot for one attempt in a single locked read-modify-write.
   * The held reservations are re-read under the reservations lock; a claim by
   * an attempt that already holds one, a claim over a busy worktree (decided
   * by the request's `checkBusyWorktree`, run under the same lock) and a claim
   * over a full budget are refused without writing, and only a passing claim
   * is appended with the lowest free slot index. A reservation is never
   * superseded.
   */
  reserveCapacityAtomically(
    request: ReserveCapacityAtomicallyRequest,
  ): Promise<ReserveCapacityAtomicallyResult>;
}
