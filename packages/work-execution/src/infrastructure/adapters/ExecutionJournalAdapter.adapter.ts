// @generated adapter stub — refined for migration step 1 (no behaviour).
/**
 * ExecutionJournalAdapter implements ExecutionJournalPort
 * (local-transactional-journal-and-capacity-arbitration). The journal makes
 * recovery safe; implementation lands in wave 2. Every method refuses until
 * then.
 */

import type {
  ActionJournalEntryRecord,
  CapacityReservationRecord,
} from '../../domain/execution-records.js';
import type { ExecutionJournalPort } from '../../application/ports/out/ExecutionJournalPort.out-port.js';

export class ExecutionJournalAdapter implements ExecutionJournalPort {
  async appendJournalEntry(_entry: ActionJournalEntryRecord): Promise<void> {
    throw new Error('Not implemented: ExecutionJournalAdapter.appendJournalEntry');
  }

  async listJournalEntriesForAttempt(_attemptId: string): Promise<readonly ActionJournalEntryRecord[]> {
    throw new Error('Not implemented: ExecutionJournalAdapter.listJournalEntriesForAttempt');
  }

  async saveCapacityReservation(_reservation: CapacityReservationRecord): Promise<void> {
    throw new Error('Not implemented: ExecutionJournalAdapter.saveCapacityReservation');
  }

  async listActiveReservations(_hostId?: string): Promise<readonly CapacityReservationRecord[]> {
    throw new Error('Not implemented: ExecutionJournalAdapter.listActiveReservations');
  }

  async releaseCapacityReservation(_attemptId: string, _releasedAtIso: string): Promise<boolean> {
    throw new Error('Not implemented: ExecutionJournalAdapter.releaseCapacityReservation');
  }
}
