// @generated outbound contract scaffold — refined for lane SR3.
/**
 * SeatTicketRepositoryPort is the outbound contract for persisting one seat
 * rotation counter per `(projectId, role)` (plan §3.5.3, D3). A `ticket` only
 * ever increases; `revision` carries optimistic concurrency (compare-and-swap).
 * Known absence is `null`; an unreadable store is an error, never silence.
 */

import type { SeatTicketRecord, SeatTicketRole } from '../../../domain/execution-records.js';

export type SaveSeatTicketOutcome = 'saved' | 'conflict';

export interface SeatTicketRepositoryPort {
  /** The ticket for `(projectId, role)`, or null when none is stored yet. */
  findSeatTicket(projectId: string, role: SeatTicketRole): Promise<SeatTicketRecord | null>;
  /** Every stored ticket, optionally narrowed to one project. */
  listSeatTickets(projectId?: string): Promise<readonly SeatTicketRecord[]>;
  /**
   * Compare-and-swap: the stored record for `(projectId, role)` must be absent
   * or carry a lower `revision`, and the incoming `ticket` may not be lower
   * than the stored one. `'conflict'` means another writer won and the caller
   * re-reads and retries.
   */
  saveSeatTicket(record: SeatTicketRecord): Promise<SaveSeatTicketOutcome>;
}
