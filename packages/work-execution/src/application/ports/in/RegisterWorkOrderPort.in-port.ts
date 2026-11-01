// @generated inbound contract scaffold — refined for migration step 1.
/**
 * RegisterWorkOrderPort: record an approved bounded work unit, base commit,
 * owned paths, policy revision, risk label and prerequisite work; reject
 * invalid or conflicting ownership. Recording is registration, not dispatch.
 */

import type { WorkOrderRecord, WorkOrderRisk } from '../../../domain/execution-records.js';

export interface RegisterWorkOrderRequest {
  readonly workOrderId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly laneId: string;
  readonly repository: string;
  readonly baseCommit: string;
  readonly ownedPaths: readonly string[];
  readonly policyRevision: string;
  readonly prerequisiteWorkOrderIds?: readonly string[];
  /** `standard` or `high`; absent registers `high` (plan A5). Frozen once registered. */
  readonly risk?: WorkOrderRisk;
  /**
   * Optional terminal work order this one supersedes. When present it is
   * refused unless it is a non-empty string, not the new work order itself,
   * an existing work order in the same project, terminal (stopped or merged),
   * and not already superseded by another work order.
   */
  readonly supersedesWorkOrderId?: string;
  /**
   * Optional base branch (`main`, or a `chain/<lowercase-dashes>` name; CB1).
   * Absent stores `main`; anything else must parse or registration is
   * rejected with reason `invalid-base-branch`.
   */
  readonly baseBranch?: string;
  readonly nowIso?: string;
}

export type RegisterWorkOrderResult =
  | { readonly outcome: 'registered'; readonly workOrder: WorkOrderRecord }
  | { readonly outcome: 'rejected'; readonly reason: string };

export interface RegisterWorkOrderPort {
  /** Register one approved work unit. No dispatch is authorized by this call. */
  registerWorkOrder(request: RegisterWorkOrderRequest): Promise<RegisterWorkOrderResult>;
}
