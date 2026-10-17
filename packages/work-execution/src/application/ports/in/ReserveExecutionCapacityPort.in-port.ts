// @generated inbound contract scaffold — refined for migration step 1.
/**
 * ReserveExecutionCapacityPort: reserve a configured slot for one attempt
 * under the host's shared budget. A busy worktree blocks the reservation; a
 * refusal is distinguished from "no free slot".
 */

import type { CapacityReservationRecord, RunnerKind } from '../../../domain/execution-records.js';

/**
 * The lane-runner host a reservation is made on (H9a1). It is optional for
 * now: no caller passes it yet (H9a2 wires host selection into the reserve),
 * and an absent `host` leaves the reservation's behaviour unchanged.
 */
export interface ReserveExecutionCapacityHost {
  readonly hostName: string;
  readonly hostKind: RunnerKind;
  readonly transport: 'local' | 'ssh';
  readonly sshAlias: string | null;
  readonly port: number | null;
}

export interface ReserveExecutionCapacityRequest {
  readonly reservationId: string;
  readonly attemptId: string;
  readonly workOrderId: string;
  readonly hostId: string;
  readonly worktreePath: string;
  readonly maxSlots: number;
  /**
   * The seat tool the lane will run, from the request's chain seat. Required
   * and never defaulted: a blank or unknown tool is a refusal, not an
   * opencode seat.
   */
  readonly seatTool: RunnerKind;
  /**
   * The lane-runner host to record on the reservation (H9a1). When given it
   * is validated and recorded; when absent the reservation records a `null`
   * host on every field.
   */
  readonly host?: ReserveExecutionCapacityHost | null;
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
