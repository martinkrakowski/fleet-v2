// @generated inbound contract scaffold — refined for lane CO29b.
/**
 * ApplyRelaunchPort: apply one stored relaunch plan by digest, only under a
 * recorded owner grant naming that digest (cutover plan CO29, §4 steps 1–9,
 * invariants I1–I7). Steps run in order, each keyed
 * `relaunch/<planDigest>/<lane>/<step>` with intent before action; a lane is
 * aborted only by directory through the runner after its save is verified; a
 * step with an intent but no result is reconciled, never repeated, so a
 * re-run is safe. It removes, resets or deletes no worktree or branch;
 * results carry ids, codes and digests only.
 */

import type { RelaunchPopulation } from './InventoryRelaunchPort.in-port.js';
import type {
  RelaunchPlanRepositoryPort,
  RelaunchPlanRecord,
  RelaunchPlanReadResult,
  RelaunchPlanLaneEntry,
  RelaunchConductedLanePlan,
  RelaunchAdoptableLanePlan,
  RelaunchPlanStepKind,
} from '../out/RelaunchPlanRepositoryPort.out-port.js';
import {
  RELAUNCH_PLAN_SCHEMA_VERSION,
  RELAUNCH_PLAN_STEPS,
} from '../out/RelaunchPlanRepositoryPort.out-port.js';

export { RELAUNCH_PLAN_SCHEMA_VERSION, RELAUNCH_PLAN_STEPS };
export type {
  RelaunchPlanRepositoryPort,
  RelaunchPlanRecord,
  RelaunchPlanReadResult,
  RelaunchPlanLaneEntry,
  RelaunchConductedLanePlan,
  RelaunchAdoptableLanePlan,
  RelaunchPlanStepKind,
};

/** The one application request: which plan, whose grant, which clock. */
export interface ApplyRelaunchRequest {
  /** 7–64 lowercase hex chars; the digest the owner grant names. */
  readonly planDigest: string;
  /** The recorded owner decision reference naming this plan digest. */
  readonly ownerGrantDecisionRef: string;
  /** ISO 8601 with an explicit zone: the apply's clock. */
  readonly nowIso: string;
  /** ISO 8601 with an explicit zone; a step is not started at or after it. */
  readonly deadlineIso?: string;
}

/** Why the whole apply was refused before any step ran. */
export type ApplyRelaunchRefusalReason =
  | 'invalid-request'
  | 'secret-detected'
  | 'plan-missing'
  | 'plan-malformed'
  | 'plan-digest-mismatch'
  | 'owner-grant-not-approved'
  | 'conducted-run-missing'
  | 'conducted-run-terminal'
  | 'attempt-missing'
  | 'idempotency-conflict';

/** Why the whole apply is in an unknown state before any step ran. */
export type ApplyRelaunchUnknownReason =
  | 'deadline-exceeded'
  | 'plan-store-unreadable'
  | 'plan-unknown-version'
  | 'owner-grant-unknown'
  | 'cutover-journal-unreadable'
  | 'lane-run-store-unavailable'
  | 'attempt-store-unavailable'
  | 'apply-unknown';

/** Why the apply stopped mid-plan, with the steps before it already done. */
export type ApplyRelaunchPartialReason =
  | 'deadline-exceeded'
  | 'save-refused'
  | 'save-unknown'
  | 'abort-without-save'
  | 'abort-runner-unavailable'
  | 'abort-not-idle'
  | 'abort-failed'
  | 'adopt-refused'
  | 'adopt-budget-exhausted'
  | 'adopt-unknown'
  | 'journal-write-failed'
  | 'idempotency-conflict'
  | 'step-failed';

/** One lane's outcome inside an applied or partial apply. */
export interface ApplyRelaunchLaneReport {
  readonly laneId: string;
  readonly population: RelaunchPopulation;
  readonly status: 'completed' | 'reused' | 'halted' | 'pending';
  readonly completedSteps: readonly RelaunchPlanStepKind[];
  readonly pendingSteps: readonly RelaunchPlanStepKind[];
  readonly stoppedAtStep?: RelaunchPlanStepKind;
  readonly reason?: string;
  readonly saveRef?: string;
  readonly commitId?: string;
}

export type ApplyRelaunchResult =
  | {
      readonly outcome: 'applied';
      readonly planDigest: string;
      /** True when every step of every lane was already recorded and nothing was written. */
      readonly reused: boolean;
      readonly lanes: readonly ApplyRelaunchLaneReport[];
    }
  | {
      readonly outcome: 'partial';
      readonly planDigest: string;
      readonly reason: ApplyRelaunchPartialReason;
      readonly stoppedLaneId: string;
      readonly stoppedStep: RelaunchPlanStepKind;
      readonly lanes: readonly ApplyRelaunchLaneReport[];
    }
  | {
      readonly outcome: 'refused';
      readonly reason: ApplyRelaunchRefusalReason;
      readonly laneId?: string;
    }
  | {
      readonly outcome: 'unknown';
      readonly reason: ApplyRelaunchUnknownReason;
      readonly laneId?: string;
    };

export interface ApplyRelaunchPort {
  /** Never throws on runtime input; an invalid request is a typed refusal. */
  applyRelaunch(request: ApplyRelaunchRequest): Promise<ApplyRelaunchResult>;
}
