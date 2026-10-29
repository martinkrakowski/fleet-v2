// Implemented for lane K7-5b (owner decision K7-D7, "Start reserves first").
/**
 * LaneRunStartCapacityPort: reserve capacity for a new run's first attempt
 * after the global cap and package-busy checks (K7-D5); the reserve chooses
 * host and worktree path, and the reservation is the single authority for
 * the run's worktree path. Later attempts of a run are admitted through
 * `LaneRunAdmissionPort.admit` instead, pinned to the run's own host and
 * worktree; `LaneRunAdmissionAdapter` implements both ports.
 */

import type { RunnerKind } from '../../../domain/execution-records.js';

export interface LaneRunFirstReservationRequest {
  readonly attemptId: string;
  readonly workOrderId: string;
  readonly seatTool: RunnerKind;
  readonly nowIso: string;
}

export type LaneRunFirstReservationResult =
  | {
      readonly outcome: 'reserved';
      readonly hostName: string;
      readonly hostKind: RunnerKind;
      readonly worktreePath: string;
      /** The reservation record's transport; a legacy record derives it from the alias. */
      readonly transport: 'local' | 'ssh';
      readonly sshAlias: string | null;
      readonly port: number | null;
    }
  | { readonly outcome: 'no-capacity' }
  | {
      readonly outcome: 'refused';
      readonly reason:
        | 'no-host'
        | 'no-review-route'
        | 'reserve-refused'
        | 'reservation-incomplete';
    };

/** The first attempt of a new run: global cap and package-busy, then the reserve chooses host and worktree path (K7-D7). */
export interface LaneRunStartCapacityPort {
  reserveFirst(request: LaneRunFirstReservationRequest): Promise<LaneRunFirstReservationResult>;
}
