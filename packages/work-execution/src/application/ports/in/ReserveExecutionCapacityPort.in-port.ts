// @generated inbound contract scaffold — refined for migration step 1.
/**
 * ReserveExecutionCapacityPort: reserve a configured slot for one attempt
 * under the host's shared budget. A busy worktree blocks the reservation; a
 * refusal is distinguished from "no free slot".
 */

import type { CapacityReservationRecord } from '../../../domain/execution-records.js';

export interface ReserveExecutionCapacityRequest {
  readonly reservationId: string;
  readonly attemptId: string;
  readonly workOrderId: string;
  readonly hostId: string;
  readonly worktreePath: string;
  readonly maxSlots: number;
  readonly nowIso?: string;
}

export type ReserveExecutionCapacityResult =
  | { readonly outcome: 'reserved'; readonly reservation: CapacityReservationRecord }
  | { readonly outcome: 'no-free-slot'; readonly heldCount: number; readonly maxSlots: number }
  | { readonly outcome: 'busy-worktree'; readonly blockingAttemptId: string }
  | { readonly outcome: 'refused'; readonly reason: string };

export interface ReserveExecutionCapacityPort {
  /** Reserve one slot or report why the reservation was not made. */
  reserveExecutionCapacity(
    request: ReserveExecutionCapacityRequest,
  ): Promise<ReserveExecutionCapacityResult>;
}
