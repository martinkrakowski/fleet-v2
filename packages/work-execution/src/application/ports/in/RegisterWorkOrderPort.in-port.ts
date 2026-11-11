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
  /**
   * Optional pull-request title given at registration (`--pull-request-title`).
   * Absent stores no title; a present value must be a trimmed, non-secret
   * string of 1..256 code units or registration is refused
   * `invalid-pull-request-title`.
   */
  readonly pullRequestTitle?: string;
  /** Optional plan link (`--plan`/`--lane`, CLI in WB7a). The stored planRef's
   *  projectId is always the work order's own projectId; `planProjectId`, when
   *  the caller supplies it, must equal it or registration is rejected
   *  `plan-project-mismatch`. */
  readonly planId?: string;
  readonly planLaneId?: string;
  readonly planProjectId?: string;
  readonly nowIso?: string;
  /**
   * Optional reference to the brief request this registration came from: an id
   * or digest token only (never a path). Kept with a held registration.
   */
  readonly briefRequestRef?: string;
  /**
   * Optional id of the hold intent, for replaying one registration; absent
   * derives it from the request digest. Replaying it with a changed request is
   * refused `intent-digest-mismatch`.
   */
  readonly intentId?: string;
}

/**
 * A registration that overlaps an active work order or an open pull request is
 * refused with the blocker's id (a work order id or a pull request number) and
 * the code of the first overlapping owned path (`path-<12 hex>`), never a path.
 * `held` says whether the refused registration was kept (`work-order held`).
 */
export type RegisterWorkOrderResult =
  | { readonly outcome: 'registered'; readonly workOrder: WorkOrderRecord }
  | {
      readonly outcome: 'refused';
      readonly reason: 'active-work-order-overlap';
      readonly blockerKind: 'active-work-order';
      readonly blockerId: string;
      readonly pathCode: string;
      readonly held: boolean;
      readonly requestDigest: string;
    }
  | {
      readonly outcome: 'refused';
      readonly reason: 'open-pr-overlap';
      readonly pullRequestNumber: number;
      readonly blockerKind: 'open-pr';
      readonly blockerId: string;
      readonly pathCode: string;
      readonly held: boolean;
      readonly requestDigest: string;
    }
  | {
      readonly outcome: 'refused';
      readonly reason:
        | 'overlap-unknown'
        | 'invalid-request'
        | 'invalid-pull-request-title'
        | 'held-request-mismatch'
        | 'intent-digest-mismatch'
        | 'store-unavailable';
    }
  | { readonly outcome: 'rejected'; readonly reason: string };

export interface RegisterWorkOrderPort {
  /** Register one approved work unit. No dispatch is authorized by this call. */
  registerWorkOrder(request: RegisterWorkOrderRequest): Promise<RegisterWorkOrderResult>;
}
