/**
 * The conductor plan's transition rules (plan §3.2 and §3.8) as pure data and
 * small functions, plus the §3.9.1 stop-mode and drain rules (amendment K-GC).
 * `parked` and `stopped` are reachable from every non-terminal state (§3.2
 * "stopped" row; §3.7 halt parks before any external action), so they are not
 * repeated per row; a park returns only to its recorded `parkedFrom`, except
 * that a park may end `merged` (CT-2a: the owner-merge park's PR merged). Every
 * function is total: it never throws and returns a typed result for any input
 * of its declared type (fail-closed where stated). No port, no I/O, no clock.
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
  merging: ['merged', 'gating'],
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

/** Accepted at the head: Tier 2 waits in awaiting-premerge (D3); else opening-pr without a PR, pushing with one. */
export function afterLaneRunAcceptance(tier: LaneRunTier, prNumber: number | null):
  'awaiting-premerge' | 'opening-pr' | 'pushing' {
  if (tier === 2) {
    return 'awaiting-premerge';
  }
  return prNumber === null ? 'opening-pr' : 'pushing';
}

/** The pre-merge pass recorded a pass for the head. */
export function afterLaneRunPreMergePass(prNumber: number | null): 'opening-pr' | 'pushing' {
  return prNumber === null ? 'opening-pr' : 'pushing';
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

export type LaneRunResumeRefusal = 'run-stopped' | 'stale-revision' | 'not-parked' | 'stop-pending' | 'one-way-door';
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
  return { ok: true, to: record.parked.parkedFrom };
}
