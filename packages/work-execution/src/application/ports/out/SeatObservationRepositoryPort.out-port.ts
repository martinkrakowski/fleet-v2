// @generated outbound contract scaffold — refined for lane SR3.
/**
 * SeatObservationRepositoryPort is the outbound contract for the append-only
 * store of observations recorded outside fleet's runner (plan §3.5.5). A
 * stored observation is never rewritten or removed; every observation reads
 * back in append order.
 */

import type { SeatObservationRecord } from '../../../domain/execution-records.js';

export type AppendSeatObservationOutcome = 'appended' | 'duplicate';

export interface SeatObservationRepositoryPort {
  /**
   * Append one observation. `'duplicate'` means an observation with the same
   * `observationId` is already stored and nothing was written.
   */
  appendSeatObservation(record: SeatObservationRecord): Promise<AppendSeatObservationOutcome>;
  /** Every stored observation in append order, optionally narrowed to one seat. */
  listSeatObservations(seatId?: string): Promise<readonly SeatObservationRecord[]>;
}
