// @generated inbound contract scaffold — refined for lane CO28.
/**
 * AdoptLanePort: adopt one relaunched lane from a verified save ref or a clean
 * commit (cutover plan CO28, §4 step 6). It registers the work order with its
 * planRef and baseBranch, freezes the lane's existing brief with its digest
 * unchanged, records an ended partial attempt at that commit and creates a lane
 * run entering `collecting` with `adopted` provenance, so the gate decides.
 * Each step is keyed `relaunch/<planDigest>/<lane>/adopt/<step>` with its intent
 * before the action; a repeat returns the recorded outcome. A missing or
 * unverified save, a commit not on the lane's branch or a lane that already has a
 * run is refused. It dispatches nothing and opens no fix round. Results carry
 * ids, digests, step tokens and fixed reason codes only.
 */

import type { BaseBranchValue } from '../../../domain/base-branch.js';
import type { AttemptRunnerRecord, PlanRef, WorkOrderRisk } from '../../../domain/execution-records.js';
import type { LaneRunTier } from '../../../domain/lane-run-records.js';

/** The four keyed steps, in order. */
export const ADOPT_LANE_STEPS = ['work-order', 'brief', 'attempt', 'run'] as const;
export type AdoptLaneStep = (typeof ADOPT_LANE_STEPS)[number];

/** The journal key of one adopt step. */
export function adoptLaneStepKey(planDigest: string, laneId: string, step: AdoptLaneStep): string {
  return `relaunch/${planDigest}/${laneId}/adopt/${step}`;
}

/** The journal key under which SaveLaneEdits (CO27) records the lane's save. */
export function adoptLaneSaveKey(planDigest: string, laneId: string): string {
  return `relaunch/${planDigest}/${laneId}/save`;
}

export type AdoptLaneSource =
  | {
      readonly kind: 'save-ref';
      /** Under `refs/fleet/saved/`. */
      readonly saveRef: string;
      /** 40-hex lowercase commit id of the save. */
      readonly commitOid: string;
      /** Lowercase hex tree digest of the save. */
      readonly treeDigest: string;
    }
  | {
      readonly kind: 'clean-commit';
      readonly commitOid: string;
      readonly branchName: string;
      /** `'unknown'` never passes. */
      readonly commitOnBranch: boolean | 'unknown';
      /** `'unknown'` never passes. */
      readonly dirtyCount: number | 'unknown';
      readonly commitsSinceBase?: readonly string[];
    };

export interface AdoptLaneWorkOrder {
  readonly workOrderId: string;
  readonly taskId: string;
  readonly repository: string;
  readonly baseCommit: string;
  readonly ownedPaths: readonly string[];
  readonly policyRevision: string;
  readonly risk?: WorkOrderRisk;
  readonly prerequisiteWorkOrderIds?: readonly string[];
}

/** The lane's existing brief; its text is never rewritten and its digest never recomputed into a new value. */
export interface AdoptLaneBrief {
  readonly briefId: string;
  readonly briefText: string;
  /** 64-hex lowercase digest the caller froze; the use case only verifies it. */
  readonly expectedBriefDigest: string;
  /** Repository-relative paths of the frozen brief files. */
  readonly prosePath: string;
  readonly manifestPath: string;
  readonly reviewerModel: string;
  /** The brief's acceptance spec in its stored shape (validated by `AcceptanceSpec`). */
  readonly acceptanceSpec: unknown;
}

export interface AdoptLaneAttempt {
  readonly attemptId: string;
  readonly endedAtIso: string;
  readonly sessionId?: string | null;
  readonly runner?: AttemptRunnerRecord;
}

export interface AdoptLaneRun {
  readonly runId: string;
  readonly tier: LaneRunTier;
  readonly seatPlanRef: string;
  readonly runPolicyRevision: string;
  readonly branchName?: string;
}

export interface AdoptLaneRequest {
  /** 64-hex lowercase sha256 of the relaunch plan. */
  readonly planDigest: string;
  readonly laneId: string;
  readonly projectId: string;
  readonly planRef: PlanRef;
  readonly baseBranch: BaseBranchValue;
  readonly workOrder: AdoptLaneWorkOrder;
  readonly brief: AdoptLaneBrief;
  readonly attempt: AdoptLaneAttempt;
  readonly run: AdoptLaneRun;
  readonly source: AdoptLaneSource;
  /** ISO 8601 with an explicit zone. */
  readonly nowIso: string;
  /** ISO 8601 with an explicit zone; a step is not started at or after it. */
  readonly deadlineIso?: string;
}

export type AdoptLaneRefusalReason =
  | 'invalid-request'
  | 'secret-detected'
  | 'save-missing'
  | 'save-unverified'
  | 'commit-not-on-branch'
  | 'worktree-dirty'
  | 'lane-already-has-run'
  | 'work-order-conflict'
  | 'owned-path-conflict'
  | 'brief-digest-mismatch'
  | 'invalid-brief'
  | 'attempt-conflict'
  | 'idempotency-conflict';

export type AdoptLaneUnknownReason =
  | 'cutover-journal-unreadable'
  | 'dirty-state-unknown'
  | 'branch-fact-unknown'
  | 'work-order-store-unavailable'
  | 'attempt-store-unavailable'
  | 'lane-run-store-unavailable'
  | 'run-journal-unavailable'
  | 'journal-append-failed'
  | 'adoption-unknown';

export type AdoptLaneResult =
  | {
      readonly outcome: 'adopted';
      /** True when every step was already recorded and nothing was written. */
      readonly reused: boolean;
      readonly workOrderId: string;
      readonly briefDigest: string;
      readonly attemptId: string;
      readonly runId: string;
      readonly commitOid: string;
      readonly enteredState: 'collecting';
      readonly provenance: 'adopted';
    }
  | {
      readonly outcome: 'budget-exhausted';
      readonly completedSteps: readonly AdoptLaneStep[];
      readonly nextStep: AdoptLaneStep;
    }
  | { readonly outcome: 'unknown'; readonly reason: AdoptLaneUnknownReason }
  | { readonly outcome: 'refused'; readonly reason: AdoptLaneRefusalReason };

export interface AdoptLanePort {
  adoptLane(request: AdoptLaneRequest): Promise<AdoptLaneResult>;
}
