// @generated inbound contract scaffold — refined for this lane.
/**
 * ListAttemptsPort: list recorded attempts with their work order and held
 * capacity reservation. Read-only: never contacts the runner; recorded
 * state, not a runner observation.
 */

import type { AttemptRecord } from '../../../domain/execution-records.js';

export interface ListAttemptsRequest {
  readonly projectId?: string;
  readonly limit?: number;
}

export interface ListedAttemptWorkOrder {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly laneId: string;
}

export interface ListedAttemptReservation {
  readonly hostId: string;
  readonly hostName: string | null;
  readonly slotIndex: number;
}

export interface ListedAttempt {
  readonly attempt: AttemptRecord;
  /** null when the attempt's work order record is missing; never invented. */
  readonly workOrder: ListedAttemptWorkOrder | null;
  /** The attempt's active (held) capacity reservation, or null when it holds none. */
  readonly reservation: ListedAttemptReservation | null;
}

export type ListAttemptsResult =
  | { readonly outcome: 'listed'; readonly attempts: readonly ListedAttempt[]; readonly total: number; readonly truncated: boolean }
  | { readonly outcome: 'rejected'; readonly reason: string };

export interface ListAttemptsPort {
  listAttempts(request: ListAttemptsRequest): Promise<ListAttemptsResult>;
}
