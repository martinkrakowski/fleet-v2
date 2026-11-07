// @generated outbound contract scaffold — refined for lane K4-4a.
/**
 * LaneRunAdmissionPort: reserve capacity for a run's prepared attempt
 * (§3.6 "Admission"), and refuse (`no-capacity`) while the owned-file
 * overlap has another active run or the global cap is reached; K7 composes
 * both checks inside this port. No capacity is a wait, never a park. A
 * consumer-side call is a record-only reservation; K4-4b's decider calls it
 * once on a `wait admission`.
 */

import type { RunnerKind } from '../../../domain/execution-records.js';

export interface LaneRunAdmissionRequest {
  readonly attemptId: string;
  readonly workOrderId: string;
  readonly seatTool: RunnerKind;
  readonly worktreePath: string;
  readonly nowIso: string;
}

/** Which runs and in-flight reservations made an admission check fail (KS5). */
export interface LaneRunAdmissionBlockers {
  /** Non-terminal runs that made the check fail, sorted, deduped. */
  readonly runIds: readonly string[];
  /** In-flight reservations (no run) that did, sorted, deduped. */
  readonly attemptIds: readonly string[];
}

export type LaneRunAdmissionResult =
  | { readonly outcome: 'admitted' }
  | { readonly outcome: 'no-capacity'; readonly blockedBy?: LaneRunAdmissionBlockers }
  | { readonly outcome: 'refused'; readonly reason: string };

/**
 * Reserve capacity for a prepared attempt of a run (§3.6 "Admission"), and refuse (`no-capacity`) while the
 * owned-file overlap has another active run or the global cap is reached; K7 composes both checks inside this port.
 */
export interface LaneRunAdmissionPort {
  admit(request: LaneRunAdmissionRequest): Promise<LaneRunAdmissionResult>;
}
