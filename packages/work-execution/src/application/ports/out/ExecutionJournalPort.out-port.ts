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

export interface ExecutionJournalPort {
  /** Append one journal entry; the journal is append-only evidence. */
  appendJournalEntry(entry: ActionJournalEntryRecord): Promise<void>;

  /** List the journal entries for one attempt in recorded order. */
  listJournalEntriesForAttempt(attemptId: string): Promise<readonly ActionJournalEntryRecord[]>;

  /** Persist one capacity reservation or its release. */
  saveCapacityReservation(reservation: CapacityReservationRecord): Promise<void>;

  /** List held reservations, optionally narrowed to one host. */
  listActiveReservations(hostId?: string): Promise<readonly CapacityReservationRecord[]>;

  /** Release the held reservation for one attempt; false when none was held. */
  releaseCapacityReservation(attemptId: string, releasedAtIso: string): Promise<boolean>;
}
