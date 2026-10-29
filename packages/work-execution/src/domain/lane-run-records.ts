/**
 * Pure, serializable facts of the `LaneRun` aggregate (plan §3.2, "State,
 * derived first"): only what cannot be derived. There is no `state` field —
 * the run's state is a projection of attempts, the keyed journal, receipts and
 * forge evidence (K1b derives it; K1-2's decider receives it as a fact). Ids,
 * enums and numbers only, never a credential or model output. Version 1,
 * stored from the first commit (plan §5).
 */

import type { SeatPlanRole } from './value-objects/SeatPlan.vo.js';
import type { LaneRunStateValue } from './value-objects/LaneRunState.vo.js';

export const LANE_RUN_RECORD_VERSION = 1 as const;

/** Tier 0 has no lane (fleet policy), so a run is Tier 1 or Tier 2. Tier 2 waits in awaiting-premerge. */
export const LANE_RUN_TIERS = [1, 2] as const;
export type LaneRunTier = (typeof LANE_RUN_TIERS)[number];

/** Round 0 is the first pass; rounds 1 and 2 are the two fix rounds (plan §3.2 "Rounds"). */
export const LANE_RUN_MAX_ROUND = 2;
export const LANE_RUN_MAX_ATTEMPTS = 32;

/** `run-` followed by a ULID: no `/` or `@`, so it can never break a key. */
export const LANE_RUN_ID_PATTERN = /^run-[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/**
 * The action steps that carry a step key (plan §3.2, §3.3). `prepare` mints a fresh attempt for
 * (round, seat) (initial or fix, with the handover brief); `dispatch` starts it. The three review
 * kinds are separate steps so a brief check and a code review at one head never share a key.
 * `reconcile` reconciles an attempt before a forced stop (K1-2b G4j); not one-way, so it may carry a retry.
 */
export const LANE_RUN_KEY_STEPS = [
  'prepare', 'dispatch', 'stop', 'collect', 'gate', 'brief-check', 'code-review', 'pre-merge',
  'accept', 'open-pr', 'push', 'merge', 'park', 'reconcile',
] as const;
export type LaneRunKeyStep = (typeof LANE_RUN_KEY_STEPS)[number];

/** One-way steps are never issued twice for one key and never retried under a retry key (§3.5). */
export const LANE_RUN_ONE_WAY_STEPS = ['prepare', 'dispatch', 'open-pr', 'push', 'merge', 'park'] as const satisfies readonly LaneRunKeyStep[];

/** Whether a step key carries `@<head12>`. */
export const LANE_RUN_KEY_HEAD_RULE = {
  prepare: 'absent', dispatch: 'absent', stop: 'absent', collect: 'absent',
  gate: 'required', 'brief-check': 'required', 'code-review': 'required', 'pre-merge': 'required',
  accept: 'required', 'open-pr': 'required', push: 'required', merge: 'required', park: 'absent',
  reconcile: 'absent',
} as const satisfies Record<LaneRunKeyStep, 'required' | 'absent'>;

/** Whether a step key carries `/a<n>`. */
export const LANE_RUN_KEY_ATTEMPT_RULE = {
  prepare: 'required', dispatch: 'required', stop: 'absent', collect: 'absent',
  gate: 'absent', 'brief-check': 'absent', 'code-review': 'absent', 'pre-merge': 'absent',
  accept: 'absent', 'open-pr': 'absent', push: 'absent', merge: 'absent', park: 'absent',
  reconcile: 'absent',
} as const satisfies Record<LaneRunKeyStep, 'required' | 'absent'>;

/** Why a StopAttempt for a run was refused (plan §3.8 "refused: its reason carrying the refusal's typed reason"). */
export const RUN_STOP_REFUSAL_KINDS = [
  'attempt-missing', 'attempt-terminal', 'runner-unavailable', 'runner-refused', 'other',
] as const;
export type RunStopRefusalKind = (typeof RUN_STOP_REFUSAL_KINDS)[number];

/** Plan §3.6 and §3.8, then four K1 additions the §3.2 exits need (each documented on its line). */
export const LANE_RUN_PARK_REASONS = [
  'one-way-door', 'seat-plan-exhausted', 'blocker-after-round-2', 'ambiguous', 'artifacts-unsealed',
  'cost-ceiling', 'ci-failed-no-rounds', 'branch-behind', 'review-seat-unavailable', 'halted',
  'stop-unconfirmed',
  'stop-refused',        // §3.8 row "refused": the qualifier is the RunStopRefusalKind
  'acceptance-rejected', // §3.2 accepting → parked: AssessHeadAcceptance rejected at the head
  'step-refused',        // a keyed action was refused (prepare, collect, gate, accept, open-pr, push, merge); qualifier = the step
  'owner-merge',         // merging without a policy grant (auto-merge off or not eligible): the owner merges
] as const;
export type LaneRunParkReason = (typeof LANE_RUN_PARK_REASONS)[number];

/** What `parked.qualifier` holds for each reason. */
export const LANE_RUN_PARK_QUALIFIER = {
  'one-way-door': 'none',
  'seat-plan-exhausted': 'none',
  'blocker-after-round-2': 'none',
  ambiguous: 'step',
  'artifacts-unsealed': 'none',
  'cost-ceiling': 'none',
  'ci-failed-no-rounds': 'none',
  'branch-behind': 'none',
  'review-seat-unavailable': 'none',
  halted: 'none',
  'stop-unconfirmed': 'none',
  'stop-refused': 'stop-refusal',
  'acceptance-rejected': 'none',
  'step-refused': 'step',
  'owner-merge': 'none',
} as const satisfies Record<LaneRunParkReason, 'none' | 'step' | 'stop-refusal'>;

export interface LaneRunParkRecord {
  readonly reason: LaneRunParkReason;
  /** A LaneRunKeyStep (`ambiguous`, `step-refused`), a RunStopRefusalKind (`stop-refused`), else null. */
  readonly qualifier: string | null;
  /** The state `conductor resume` or the owner's answer returns to (one of LANE_RUN_RESUMABLE_STATES). */
  readonly parkedFrom: LaneRunStateValue;
  /** The keyed owner question, once asked; null when none is (e.g. stop-unconfirmed, halted). */
  readonly questionId: string | null;
}

/** The driver's lease on this run (K3 takes and renews it by CAS with a fencing revision). */
export interface LaneRunLeaseRecord {
  readonly holderId: string;
  readonly fence: number;
  readonly leaseUntilIso: string;
}

/** The seat index each role last used in this run; null before its first use (D8). */
export type LaneRunCursorsRecord = { readonly [role in SeatPlanRole]: number | null };

/** Serializable snapshot of the LaneRun aggregate (version 1). */
export interface LaneRunRecord {
  readonly version: typeof LANE_RUN_RECORD_VERSION;
  readonly runId: string;
  readonly workOrderId: string;
  readonly tier: LaneRunTier;
  /** sha256 hex of the frozen SeatPlan's canonical JSON (computed outside the domain). */
  readonly seatPlanRef: string;
  readonly cursors: LaneRunCursorsRecord;
  /** 0 first pass; 1 and 2 the fix rounds. Raised when a later round's dispatch intent is recorded. */
  readonly round: number;
  /** Every attempt of the run, oldest first. */
  readonly attemptIds: readonly string[];
  readonly prNumber: number | null;
  readonly parked: LaneRunParkRecord | null;
  /** Parks so far, the current one included: `<n>` of `<runId>/park/<n>/resume@web`. */
  readonly parkCount: number;
  readonly lease: LaneRunLeaseRecord | null;
  /** CAS revision of this record; a resume or stop from the web carries it as expectedRevision. */
  readonly revision: number;
  /** The policy revision the run started under; a merge's journal entry names it (plan §5). */
  readonly runPolicyRevision: string;
  /**
   * The run's worktree branch (`fleet/<runId>` by K7-D7), recorded at start so forge
   * acts and reads name the branch the run created; absent on records written before
   * KF-5a (readers fall back to the worktree path's last segment).
   */
  readonly branchName?: string;
}
