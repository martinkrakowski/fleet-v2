/**
 * The conductor plan's transition rules (plan §3.2 and §3.8) as pure data and
 * small functions, plus the §3.9.1 stop-mode and drain rules (amendment K-GC).
 * `parked` and `stopped` are reachable from every non-terminal state (§3.2
 * "stopped" row; §3.7 halt parks before any external action), so they are not
 * repeated per row; a park returns only to its recorded `parkedFrom`, except
 * that a park may end `merged` (CT-2a: the owner-merge park's PR merged). Every
 * function is total: it never throws and returns a typed result for any input
 * of its declared type (fail-closed where stated). No port, no I/O, no clock.
 * Amended by the lane-pipeline speed plan (`docs/planning/2026-10-28_lane-pipeline-speed-plan.md`
 * §3.6.2; D19, D20, D22, D24): the rows and rules marked KS1 are data for KS6 and KS7; the decider
 * keeps the D3 path until KS7 switches it.
 */

import type {
  LaneRunKeyStep,
  LaneRunRecord,
  LaneRunTier,
  RunStopRefusalKind,
} from './lane-run-records.js';
import { RUN_STOP_REFUSAL_KINDS } from './lane-run-records.js';
import { LANE_RUN_STATES, LANE_RUN_TERMINAL_STATES } from './value-objects/LaneRunState.vo.js';
import type { LaneRunStateValue } from './value-objects/LaneRunState.vo.js';
import type { ImplementerSeatRole } from './value-objects/SeatPlan.vo.js';
import type { WorkOrderStateValue } from './value-objects/WorkOrderState.vo.js';

/** Exits of each state besides the universal `parked` and `stopped` (plan §3.2 "Exits"). */
export const LANE_RUN_EXITS = {
  ready: ['dispatching'],
  dispatching: ['running', 'seat-failed'],
  running: ['collecting', 'seat-failed'],
  'seat-failed': ['dispatching'],
  collecting: ['gating', 'seat-failed'],
  gating: ['brief-check', 'fixing'],
  'brief-check': ['code-review', 'fixing'],
  'code-review': ['accepting', 'fixing'],
  fixing: ['dispatching'],
  accepting: ['awaiting-premerge', 'opening-pr', 'pushing'],
  'awaiting-premerge': ['opening-pr', 'pushing', 'fixing', 'gating'],
  'opening-pr': ['watching-ci', 'gating'],
  pushing: ['watching-ci', 'gating'],
  'watching-ci': ['merging', 'fixing', 'gating'],
  // KS1 (D20): a Tier 2 pre-merge finding read in `merging` goes to a fix round; (D22, D24): a forge
  // branch update re-runs CI on the new head. The `branch-behind` park stays universal (D6, §3.3).
  merging: ['merged', 'fixing', 'watching-ci', 'gating'],
  merged: [],
  stopped: [],
  parked: [],
} as const satisfies Record<LaneRunStateValue, readonly LaneRunStateValue[]>;

/** States after acceptance in which a changed head re-enters gating (plan §3.2 "Rounds"). */
export const LANE_RUN_HEAD_CHANGE_STATES = [
  'awaiting-premerge', 'opening-pr', 'pushing', 'watching-ci', 'merging',
] as const satisfies readonly LaneRunStateValue[];

/** The keyed step each acting state performs (used for `step-refused` parks). */
export const LANE_RUN_STEP_OF_STATE = {
  collecting: 'collect', gating: 'gate', 'brief-check': 'brief-check', 'code-review': 'code-review',
  accepting: 'accept', 'awaiting-premerge': 'pre-merge', 'opening-pr': 'open-pr', pushing: 'push',
  merging: 'merge',
} as const satisfies Partial<Record<LaneRunStateValue, LaneRunKeyStep>>;

/**
 * KS1 (D19; speed plan §3.6.2 row "gating, brief-check, code-review"): a run in `gating` may hold reviews in
 * flight. The brief-check and code-review intents keyed at the sealed head are appended while the gate runs,
 * and the `brief-check` and `code-review` states then read the recorded receipts instead of requesting them.
 * A receipt for a head the gate failed is kept for the fix brief and never accepts a head. The `gating` exits
 * are unchanged. A graceful drain appends none of them (LANE_RUN_DRAIN_STEPS; plan §3.9.1). KS6 appends the
 * intents; when inside `gating` they go out (SP-D4: after the static checks) is KS6's with KS3's facts.
 */
export const LANE_RUN_REVIEWS_IN_FLIGHT = {
  from: 'gating',
  steps: ['brief-check', 'code-review'],
} as const satisfies { readonly from: LaneRunStateValue; readonly steps: readonly LaneRunKeyStep[] };

/**
 * Whether `from → to` is a legal transition. Terminal `from` → false. `to === 'stopped'` → true.
 * `to === 'parked'` → true unless `from` is `parked`. `from === 'parked'` → true only when `to` equals
 * `parkedFrom` (pass the record's `parked.parkedFrom`; `null`/absent → false) or when `to` is `merged`
 * (CT-2a). Otherwise the table. Unknown strings → false.
 */
export function canEnterLaneRunState(from: string, to: string, parkedFrom?: string | null): boolean {
  if (!(LANE_RUN_STATES as readonly string[]).includes(from)) {
    return false;
  }
  const state = from as LaneRunStateValue;
  if ((LANE_RUN_TERMINAL_STATES as readonly LaneRunStateValue[]).includes(state)) {
    return false;
  }
  if (to === 'stopped') {
    return true;
  }
  if (to === 'parked') {
    return state !== 'parked';
  }
  if (state === 'parked') {
    // CT-2a: the conductor's owner-merge park enters `merged` by itself when
    // its PR merges with the lane head (the decider's G5), even though `merged`
    // is not the park's recorded `parkedFrom`.
    if (to === 'merged') {
      return true;
    }
    return parkedFrom !== null && parkedFrom !== undefined && to === parkedFrom;
  }
  return (LANE_RUN_EXITS[state] as readonly string[]).includes(to);
}

/** A fix round is left while round < 2 (plan §3.2 "Rounds"). */
export function laneRunRoundsLeft(round: number): boolean {
  return round < 2;
}

/** The implementer role due: `fix` in the fixing state or after round 0, else `first-pass`. */
export function implementerRoleFor(round: number, state: LaneRunStateValue): ImplementerSeatRole {
  if (state === 'fixing' || round > 0) {
    return 'fix';
  }
  return 'first-pass';
}

export type LaneRunFailureCause = 'gate' | 'brief-check' | 'code-review' | 'pre-merge' | 'ci';
export type LaneRunFailureOutcome =
  | { readonly kind: 'enter'; readonly to: 'fixing'; readonly nextRound: number }
  | { readonly kind: 'park'; readonly reason: 'blocker-after-round-2' | 'ci-failed-no-rounds' };

/**
 * A failed gate, a review with blockers or majors, a failed pre-merge pass or failed CI (D5).
 * Rounds left → fixing with nextRound = round + 1 (a failed first gate uses round 1). After round 2 →
 * park: `ci-failed-no-rounds` for `ci`, `blocker-after-round-2` otherwise. A round outside 0..2 parks
 * (fail closed) with the same reasons.
 */
export function afterLaneRunFailure(round: number, cause: LaneRunFailureCause): LaneRunFailureOutcome {
  if (round === 0 || round === 1) {
    return { kind: 'enter', to: 'fixing', nextRound: round + 1 };
  }
  return {
    kind: 'park',
    reason: cause === 'ci' ? 'ci-failed-no-rounds' : 'blocker-after-round-2',
  };
}

/** The PR exit after an accepted head: `opening-pr` without a PR, `pushing` with one (plan §3.2 rows opening-pr, pushing). */
function laneRunPrExit(prNumber: number | null): 'opening-pr' | 'pushing' {
  return prNumber === null ? 'opening-pr' : 'pushing';
}

/**
 * Where a Tier 2 run awaits its pre-merge pass: in the `awaiting-premerge` state (plan §3.2, D3: the
 * decider's path today) or as a hold read in `merging` (speed plan §3.6.2, D20: KS7 switches the decider).
 */
export type LaneRunPreMergeHold = 'awaiting-premerge' | 'merging';

/**
 * Accepted at the head. `hold === 'awaiting-premerge'` (the default until KS7 passes `'merging'`): Tier 2
 * waits in `awaiting-premerge` (D3). `hold === 'merging'`: every tier takes the PR exit (D20) and Tier 2's
 * receipt is read by `laneRunMergeHold` in `merging`. Tier 1 takes the PR exit either way.
 */
export function afterLaneRunAcceptance(
  tier: LaneRunTier,
  prNumber: number | null,
  hold: LaneRunPreMergeHold = 'awaiting-premerge',
): 'awaiting-premerge' | 'opening-pr' | 'pushing' {
  if (tier === 2 && hold === 'awaiting-premerge') {
    return 'awaiting-premerge';
  }
  return laneRunPrExit(prNumber);
}

/** The pre-merge pass recorded a pass for the head: the `awaiting-premerge` exit (D3). */
export function afterLaneRunPreMergePass(prNumber: number | null): 'opening-pr' | 'pushing' {
  return laneRunPrExit(prNumber);
}

/** The pre-merge receipt at the head as the decider reads it (`LaneRunFacts.preMerge`). */
export type LaneRunPreMergeReceipt = 'none' | 'passed' | 'failed' | 'unknown';

/** The `premerge` commit status the conductor posts at the exact head (speed plan §3.3.1); KS7 posts it. */
export type LaneRunPremergeStatus = 'success' | 'pending' | 'failure';

export type LaneRunMergeHold =
  /** Tier 1, or Tier 2 with a pass at this head: post `success`, then enable auto-merge at the head. */
  | { readonly kind: 'released'; readonly status: 'success' }
  /** Tier 2 without a receipt yet: post `pending`; the run waits `premerge-pending`. */
  | { readonly kind: 'wait'; readonly status: 'pending' }
  /** Tier 2 findings: post `failure`; `outcome` is `afterLaneRunFailure(round, 'pre-merge')` (a fix round, or the park after round 2). */
  | { readonly kind: 'fail'; readonly status: 'failure'; readonly outcome: LaneRunFailureOutcome }
  /** An unreadable receipt: post nothing; park `ambiguous` at `pre-merge`. */
  | { readonly kind: 'park'; readonly status: null; readonly reason: 'ambiguous'; readonly qualifier: 'pre-merge' };

/**
 * The merge hold read in `merging` (speed plan §3.6.2 row "accepting, awaiting-premerge, opening-pr"; §3.3.1):
 * the `awaiting-premerge` rule of the decider as data, for KS7 to wire. Total: Tier 1 is released; Tier 2 follows its receipt; a tier outside LANE_RUN_TIERS or, for Tier 2, an
 * unknown receipt string parks (fail closed; `LaneRun.create` refuses such a tier, so the guard is for the rule's own totality).
 */
export function laneRunMergeHold(tier: LaneRunTier, preMerge: LaneRunPreMergeReceipt, round: number): LaneRunMergeHold {
  if (tier !== 1 && tier !== 2) {
    return { kind: 'park', status: null, reason: 'ambiguous', qualifier: 'pre-merge' };
  }
  if (tier === 1 || preMerge === 'passed') {
    return { kind: 'released', status: 'success' };
  }
  if (preMerge === 'none') {
    return { kind: 'wait', status: 'pending' };
  }
  if (preMerge === 'failed') {
    return { kind: 'fail', status: 'failure', outcome: afterLaneRunFailure(round, 'pre-merge') };
  }
  return { kind: 'park', status: null, reason: 'ambiguous', qualifier: 'pre-merge' };
}

/**
 * How the repository merges (speed plan §3.3): a merge queue (D21), or strict up-to-date checks with forge
 * branch updates (D22). A-0 found no queue for fleet-v2, so the conductor runs `strict`.
 */
export type LaneRunMergePath = 'queue' | 'strict';

export type LaneRunBranchBehindExit =
  /** Not behind, or a queue builds the merged result itself (D24: D6's park is not reached). */
  | { readonly kind: 'proceed' }
  /** D22: the conductor updates the branch through the forge and CI re-runs on the new head. */
  | { readonly kind: 'update-branch'; readonly to: 'watching-ci' }
  /** D22 with an overlap on a file changed on main since the head's base (§3.3): D6's park stands. */
  | { readonly kind: 'park'; readonly reason: 'branch-behind' };

/**
 * What a behind branch does in `merging` (speed plan §3.6.2 row "merge train, D6"). Order: a queue never parks;
 * an overlap on main parks even when `branchBehind` reads false (contradictory facts fail closed); a behind
 * branch is updated; otherwise proceed to the merge rules. Any merge path other than `queue` reads as `strict`.
 */
export function laneRunBranchBehindExit(input: {
  readonly mergePath: LaneRunMergePath;
  readonly branchBehind: boolean;
  readonly overlapOnMain: boolean;
}): LaneRunBranchBehindExit {
  const { mergePath, branchBehind, overlapOnMain } = input;
  if (mergePath === 'queue') {
    return { kind: 'proceed' };
  }
  if (overlapOnMain) {
    return { kind: 'park', reason: 'branch-behind' };
  }
  if (branchBehind) {
    return { kind: 'update-branch', to: 'watching-ci' };
  }
  return { kind: 'proceed' };
}

/**
 * True when `state` is one of LANE_RUN_HEAD_CHANGE_STATES and both heads are 12-hex strings that
 * differ. A null head is not a change (the decider treats a missing head separately).
 */
export function laneRunHeadChanged(state: LaneRunStateValue, head12: string | null, acceptedHead12: string | null): boolean {
  if (!(LANE_RUN_HEAD_CHANGE_STATES as readonly LaneRunStateValue[]).includes(state)) {
    return false;
  }
  if (!isHead12(head12) || !isHead12(acceptedHead12)) {
    return false;
  }
  return head12 !== acceptedHead12;
}

const LANE_RUN_HEAD12_PATTERN = /^[0-9a-f]{12}$/;

/** A 12-hex lowercase head; anything else (null, wrong length, other characters, non-strings) is not one. */
function isHead12(value: unknown): value is string {
  return typeof value === 'string' && LANE_RUN_HEAD12_PATTERN.test(value);
}

/** The StopAttempt outcome for a run's attempt, as the domain reads it (a later lane maps the port result). */
export type RunStopOutcome =
  | { readonly outcome: 'terminated'; readonly capacityReleased: boolean }
  | { readonly outcome: 'cancelled'; readonly capacityReleased: boolean }
  | { readonly outcome: 'still-running' }
  | { readonly outcome: 'unknown' }
  | { readonly outcome: 'refused'; readonly refusal: RunStopRefusalKind };

export type RunStopEffect =
  | { readonly run: 'stopped'; readonly capacity: 'released' | 'held'; readonly attention: 'slot-held' | null }
  | { readonly run: 'parked'; readonly reason: 'stop-unconfirmed'; readonly qualifier: null;
      readonly capacity: 'held'; readonly attention: 'stop-unconfirmed'; readonly retryStop: true }
  | { readonly run: 'parked'; readonly reason: 'stop-refused'; readonly qualifier: RunStopRefusalKind;
      readonly capacity: 'held'; readonly attention: 'stop-refused'; readonly retryStop: false };

const STOP_UNCONFIRMED_EFFECT: RunStopEffect = {
  run: 'parked',
  reason: 'stop-unconfirmed',
  qualifier: null,
  capacity: 'held',
  attention: 'stop-unconfirmed',
  retryStop: true,
};

/** Plan §3.8. Total: a malformed outcome (unknown `outcome`, non-boolean flag, unknown refusal) reads as `unknown`. */
export function laneRunStopEffect(outcome: unknown): RunStopEffect {
  try {
    if (typeof outcome !== 'object' || outcome === null || Array.isArray(outcome)) {
      return STOP_UNCONFIRMED_EFFECT;
    }
    const record = outcome as Record<string, unknown>;
    const kind = record.outcome;
    if (kind === 'terminated' || kind === 'cancelled') {
      if (typeof record.capacityReleased !== 'boolean') {
        return STOP_UNCONFIRMED_EFFECT;
      }
      return record.capacityReleased
        ? { run: 'stopped', capacity: 'released', attention: null }
        : { run: 'stopped', capacity: 'held', attention: 'slot-held' };
    }
    if (kind === 'still-running' || kind === 'unknown') {
      return STOP_UNCONFIRMED_EFFECT;
    }
    if (kind === 'refused') {
      const refusal = record.refusal;
      if (
        typeof refusal !== 'string' ||
        !RUN_STOP_REFUSAL_KINDS.includes(refusal as RunStopRefusalKind)
      ) {
        return STOP_UNCONFIRMED_EFFECT;
      }
      return {
        run: 'parked',
        reason: 'stop-refused',
        qualifier: refusal as RunStopRefusalKind,
        capacity: 'held',
        attention: 'stop-refused',
        retryStop: false,
      };
    }
    return STOP_UNCONFIRMED_EFFECT;
  } catch {
    return STOP_UNCONFIRMED_EFFECT;
  }
}

/** Plan §3.9.1: graceful lets the running attempt finish and keeps its work; force stops it now (§3.8). */
export const RUN_STOP_MODES = ['graceful', 'force'] as const;
export type RunStopMode = (typeof RUN_STOP_MODES)[number];

/** Force wins over graceful; null means no stop. Total: an unknown string reads as null. */
export function strongerStopMode(a: RunStopMode | null, b: RunStopMode | null): RunStopMode | null {
  if (a === 'force' || b === 'force') {
    return 'force';
  }
  if (a === 'graceful' || b === 'graceful') {
    return 'graceful';
  }
  return null;
}

/** The states in which a graceful stop lets the run finish its current work (§3.9.1 drain table). */
export const LANE_RUN_DRAIN_STATES = ['dispatching', 'running', 'collecting', 'gating'] as const satisfies readonly LaneRunStateValue[];

/** The only keyed steps a graceful drain may still issue (`stop` stays allowed for the lane's own deadline). */
export const LANE_RUN_DRAIN_STEPS = ['collect', 'gate'] as const satisfies readonly LaneRunKeyStep[];

export type LaneRunGateFact = 'none' | 'pending' | 'passed' | 'failed' | 'unknown';

/**
 * Whether a graceful drain still has work in `state`: true for `dispatching`, `running`, `collecting`,
 * and for `gating` while the gate is `none` or `pending`; false for every other state, for `gating` with
 * a decided gate (`passed`, `failed`, `unknown`: the run then ends `stopped`), and for unknown strings.
 */
export function laneRunDrainContinues(state: string, gate: LaneRunGateFact): boolean {
  if (state === 'dispatching' || state === 'running' || state === 'collecting') {
    return true;
  }
  if (state === 'gating') {
    return gate === 'none' || gate === 'pending';
  }
  return false;
}

/**
 * Plan §3.9.1 "Halt and a pending stop": a run parked `halted` with a stop pending (either mode) leaves
 * the park by itself once the halt marker is gone. Returns `record.parked.parkedFrom` when state is
 * `parked`, `record.parked.reason === 'halted'`, `halted` is false and `stopMode` is not null; else null.
 * This is a §3.2 park exit taken by the driver, not a resume: `checkLaneRunResume` is not consulted, so
 * `stop-pending` never blocks it.
 */
export function laneRunHaltLiftExit(input: {
  readonly record: LaneRunRecord;
  readonly state: LaneRunStateValue;
  readonly halted: boolean;
  readonly stopMode: RunStopMode | null;
}): LaneRunStateValue | null {
  const { record, state, halted, stopMode } = input;
  if (state !== 'parked' || record.parked === null) {
    return null;
  }
  if (record.parked.reason !== 'halted' || halted || stopMode === null) {
    return null;
  }
  return record.parked.parkedFrom;
}

export type LaneRunResumeRefusal = 'run-stopped' | 'stale-revision' | 'not-parked' | 'stop-pending' | 'one-way-door' | 'fix-no-progress';
export type LaneRunResumeCheck =
  | { readonly ok: true; readonly to: LaneRunStateValue }
  | { readonly ok: false; readonly reason: LaneRunResumeRefusal };

/**
 * The rule ResumeLaneRun (K7) applies before it journals `<runId>/park/<n>/resume@web`.
 * Checks in this order: state `stopped` → run-stopped; expectedRevision !== record.revision →
 * stale-revision; stopMode not null (graceful or force) → stop-pending, parked or not (§3.9.1: a graceful
 * drain is not a park, and a requested stop always wins); state !== 'parked' or record.parked === null →
 * not-parked; parked.reason `stop-unconfirmed` or `stop-refused` → stop-pending;
 * parked.reason `one-way-door` → one-way-door (only the owner's signed decision answers it);
 * otherwise ok, to = parked.parkedFrom.
 */
export function checkLaneRunResume(input: {
  readonly record: LaneRunRecord;
  readonly state: LaneRunStateValue;
  /** The strongest stop recorded for the run (strongerStopMode over its stop entries); a fact, supplied by K1b/K7. */
  readonly stopMode: RunStopMode | null;
  readonly expectedRevision: number;
}): LaneRunResumeCheck {
  const { record, state, stopMode, expectedRevision } = input;
  if (state === 'stopped') {
    return { ok: false, reason: 'run-stopped' };
  }
  if (expectedRevision !== record.revision) {
    return { ok: false, reason: 'stale-revision' };
  }
  if (stopMode !== null) {
    return { ok: false, reason: 'stop-pending' };
  }
  if (state !== 'parked' || record.parked === null) {
    return { ok: false, reason: 'not-parked' };
  }
  if (record.parked.reason === 'stop-unconfirmed' || record.parked.reason === 'stop-refused') {
    return { ok: false, reason: 'stop-pending' };
  }
  if (record.parked.reason === 'one-way-door') {
    return { ok: false, reason: 'one-way-door' };
  }
  // A resume would re-collect the same unchanged head and park again: the
  // run is stopped, which releases its work order, and the lane is re-run
  // under a new work order (KF-21c, KF-36a).
  if (record.parked.reason === 'fix-no-progress') {
    return { ok: false, reason: 'fix-no-progress' };
  }
  return { ok: true, to: record.parked.parkedFrom };
}

/**
 * KF-36a: the work-order state a run's terminal transition releases. Answers
 * null (no save) when the work order is already `merged` or `stopped` (never
 * overwrite one terminal state with the other), when `otherRunActive` (another
 * non-terminal run still names the same work order), or when the run ends
 * `stopped` with a slot still held (a live session's paths stay claimed: fail
 * closed). A held slot does NOT block `merged` — the PR has merged, so the
 * paths' content is on main. Otherwise it answers `runEnds`.
 */
export function workOrderReleaseFor(input: {
  readonly runEnds: 'merged' | 'stopped';
  readonly workOrderState: WorkOrderStateValue;
  readonly slotHeld: boolean;
  readonly otherRunActive: boolean;
}): 'merged' | 'stopped' | null {
  const { runEnds, workOrderState, slotHeld, otherRunActive } = input;
  if (workOrderState === 'merged' || workOrderState === 'stopped') {
    return null;
  }
  if (otherRunActive) {
    return null;
  }
  if (runEnds === 'stopped' && slotHeld) {
    return null;
  }
  return runEnds;
}
