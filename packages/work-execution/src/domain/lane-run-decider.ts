/**
 * The pure lane-run decider (plan §3.2, §3.5–§3.9.1; amendment K-GC).
 * Given the run record and the facts the driver gathered (K1b, K2–K7),
 * it returns exactly one decision: one keyed external action, a reconcile
 * of an intent without a result, a record-only transition, a record-only
 * cancel of a never-dispatched attempt, a park with its reason, a wait
 * with its reason, or done. It never throws and never performs anything;
 * time enters only through `nowIso`. Each rule id names one test in
 * `__tests__/lane-run-decider.test.ts`.
 */

import {
  buildLaneRunStepKey,
  LANE_RUN_MAX_RETRY,
} from './lane-run-keys.js';
import { LANE_RUN_KEY_HEAD_RULE } from './lane-run-records.js';
import type {
  LaneRunKeyStep,
  LaneRunParkReason,
  LaneRunRecord,
} from './lane-run-records.js';
import {
  afterLaneRunAcceptance,
  afterLaneRunFailure,
  afterLaneRunPreMergePass,
  laneRunDrainContinues,
  laneRunHaltLiftExit,
  laneRunHeadChanged,
  LANE_RUN_DRAIN_STEPS,
  LANE_RUN_HEAD_CHANGE_STATES,
  LANE_RUN_STEP_OF_STATE,
} from './lane-run-transitions.js';
import type { LaneRunFailureCause, RunStopMode } from './lane-run-transitions.js';
import type { LaneRunStateValue } from './value-objects/LaneRunState.vo.js';
import { SEAT_TRIGGER_CLASSES } from './value-objects/StopReason.vo.js';
import type { StopReasonValue } from './value-objects/StopReason.vo.js';
import type { AttemptStateValue } from './value-objects/AttemptState.vo.js';

/** A seat the caller chose with selectSeat / selectReviewSeat (S1a), or none eligible. */
export type LaneRunSeatFact = { readonly ok: true; readonly seatIndex: number } | { readonly ok: false };

/** The run's latest attempt as the decider reads it; `laneRunAttemptPhaseOf` maps AttemptState. */
export type LaneRunAttemptPhase =
  | 'prepared' | 'dispatching' | 'running' | 'blocked' | 'ended' | 'collected' | 'cancelled';

export interface LaneRunAttemptFact {
  readonly attemptId: string;
  /** The run round its prepare key named. */
  readonly round: number;
  /** Its implementer seat index. */
  readonly seatIndex: number;
  readonly phase: LaneRunAttemptPhase;
  /** `stopReasonOf(record)` (S1a). */
  readonly stopReason: StopReasonValue;
  /** When a running attempt is past ExecutionLimits; null = no deadline known. */
  readonly deadlineIso: string | null;
  /** Stop intents already journalled for this attempt (the next stop's retry ordinal). */
  readonly stopsIssued: number;
  /**
   * The dispatch key of this attempt's (round, seat) (§3.9.1): `none` before any dispatch intent;
   * `not-started` when the dispatch was refused, or its reconcile found the record still `intent-recorded`
   * and the worktree idle (DispatchAttempt saves `dispatching` before calling the runner); `started` otherwise.
   */
  readonly dispatchResult: 'none' | 'not-started' | 'started';
  /** After collection: commits since base and the C1 manifest verdict; null before collection. */
  readonly collection: { readonly commits: number; readonly manifest: 'sealed' | 'missing' | 'mismatch' } | null;
}

/** A review of one kind at the current head (§3.4). */
export interface LaneRunReviewFact {
  /** none: never requested at this head; no-receipt: a request ended without a receipt (empty, one-line, tried to act, transport down). */
  readonly verdict: 'none' | 'pending' | 'no-receipt' | 'passed' | 'failed' | 'unknown';
  /** Seat index of the latest request of this kind at this head; null when none. */
  readonly seatIndex: number | null;
  /** Retries already issued for that seat at this head (0 or 1). */
  readonly retries: number;
}

export interface LaneRunFacts {
  /** Projected state; `parked` exactly when `record.parked` is set (K1b). */
  readonly state: LaneRunStateValue;
  /** Halt marker present (§3.7) (K7). */
  readonly halted: boolean;
  /** The strongest stop recorded for the run (K1b / K7). */
  readonly stopMode: RunStopMode | null;
  /** When the first stop entry of the run was recorded; null when none (K1b). */
  readonly stopRequestedAtIso: string | null;
  /** `policy.conductor.stopGraceMinutes` (D12, default 45) (K2 / K7). */
  readonly stopGraceMinutes: number;
  /** The run's last keyed intent without a result (§3.5) (K1b; reconcile in K4/K6). */
  readonly pendingIntent: { readonly key: string; readonly step: LaneRunKeyStep; readonly reconciliation: 'unread' | 'ambiguous' } | null;
  /** Capacity, one active run per package, global cap (§3.6) (K3/K4). */
  readonly admission: 'admitted' | 'no-capacity' | 'package-busy' | 'global-cap';
  /** Run usage ≥ `policy.perLaneCostCeiling`; unreadable usage = false (K4). */
  readonly costCeilingReached: boolean;
  /** `selectSeat` for `implementerRoleFor(record.round, state)` (K4). */
  readonly implementerSeat: LaneRunSeatFact;
  /**
   * `selectReviewSeat` for the review kind due (K5). When that review kind already has a
   * recorded failure in this run, the supplier must select the same seat again (D10), or
   * supply `{ ok: false }` when that seat is unavailable; it never moves to another seat.
   */
  readonly reviewSeat: LaneRunSeatFact;
  /** Implementer seat indexes already dispatched in `record.round` (K4). */
  readonly roundSeatIndexes: readonly number[];
  /** The run's latest attempt; null before the first prepare (K4). */
  readonly attempt: LaneRunAttemptFact | null;
  /** Current head of the run's branch (collected head, or the PR head once pushed) (K4/K6). */
  readonly head12: string | null;
  /** Head of the run's last `accepted` acceptance (K1b). */
  readonly acceptedHead12: string | null;
  /** Gate result at `head12`; `unknown` is not a pass (K4, S2b). */
  readonly gate: 'none' | 'pending' | 'passed' | 'failed' | 'unknown';
  /** Receipts per (reviewer, kind) at `head12` (RW1) (PC/K5). */
  readonly briefCheck: LaneRunReviewFact;
  readonly codeReview: LaneRunReviewFact;
  /** Tier 2 pre-merge receipt for `head12` (D3) (K6). */
  readonly preMerge: 'none' | 'passed' | 'failed' | 'unknown';
  /** `AssessHeadAcceptance` at `head12` (K6). */
  readonly acceptance: 'none' | 'accepted' | 'rejected' | 'unknown';
  /** `CiStatePort` at `head12` (PC/K6). */
  readonly ci: 'pending' | 'passed' | 'failed' | 'unknown';
  /** The run's PR as the forge reports it (K6, AM4b). */
  readonly pr: { readonly state: 'open' | 'merged' | 'closed'; readonly head12: string } | null;
  /** The step whose latest result in this round at this head was a refusal (K1b). */
  readonly refusedStep: LaneRunKeyStep | null;
  /** Unreadable door or behind-ness reads true; `trainFree` and `policyGrant` per §3.6/AM4a (K6). */
  readonly merge: { readonly oneWayDoor: boolean; readonly branchBehind: boolean; readonly trainFree: boolean; readonly policyGrant: boolean };
}

const PHASE_OF_ATTEMPT_STATE: Record<AttemptStateValue, LaneRunAttemptPhase> = {
  'intent-recorded': 'prepared',
  dispatching: 'dispatching',
  running: 'running',
  reconciling: 'running',
  blocked: 'blocked',
  ended: 'ended',
  collected: 'collected',
  cancelled: 'cancelled',
};

/**
 * AttemptState → phase: intent-recorded→prepared, dispatching→dispatching, running and reconciling→running,
 * blocked→blocked, ended→ended, collected→collected, cancelled→cancelled; anything else → blocked (fail closed).
 */
export function laneRunAttemptPhaseOf(state: unknown): LaneRunAttemptPhase {
  if (typeof state !== 'string' || !Object.prototype.hasOwnProperty.call(PHASE_OF_ATTEMPT_STATE, state)) {
    return 'blocked';
  }
  return PHASE_OF_ATTEMPT_STATE[state as AttemptStateValue];
}

export type LaneRunWaitReason =
  | 'admission' | 'dispatch-pending' | 'lane-running' | 'prior-not-ended' | 'gate-pending'
  | 'review-pending' | 'premerge-pending' | 'ci-pending' | 'ci-unknown' | 'merge-train' | 'parked'
  | 'stop-unconfirmed' | 'facts-inconsistent' | 'stop-draining' | 'stop-grace-exceeded';

export type LaneRunDecision =
  | { readonly kind: 'act'; readonly step: LaneRunKeyStep; readonly key: string; readonly round: number;
      readonly seatIndex: number; readonly head12: string | null; readonly retry: number | null }
  | { readonly kind: 'reconcile'; readonly step: LaneRunKeyStep; readonly key: string }
  | { readonly kind: 'cancel'; readonly key: string; readonly attemptId: string; readonly round: number;
      readonly seatIndex: number; readonly retry: number | null }
  | { readonly kind: 'enter'; readonly to: LaneRunStateValue }
  | { readonly kind: 'park'; readonly reason: LaneRunParkReason; readonly qualifier: string | null;
      readonly parkedFrom: LaneRunStateValue }
  | { readonly kind: 'wait'; readonly reason: LaneRunWaitReason }
  | { readonly kind: 'done' };

const WAIT_FACTS_INCONSISTENT: LaneRunDecision = { kind: 'wait', reason: 'facts-inconsistent' };

/**
 * The one decision the run's next driver step takes. Crash-safe order: reconcile before acting, a
 * requested stop before the halt and every state rule, the halt before any external action; unknown is
 * never a pass; a seat switch only where no review receipt was recorded. Always returns a decision,
 * never throws.
 */
export function nextLaneRunAction(record: LaneRunRecord, facts: LaneRunFacts, nowIso: string): LaneRunDecision {
  try {
    const now = Date.parse(nowIso);
    if (typeof nowIso !== 'string' || Number.isNaN(now)) {
      return WAIT_FACTS_INCONSISTENT;
    }

    const wait = (reason: LaneRunWaitReason): LaneRunDecision => ({ kind: 'wait', reason });
    const park = (reason: LaneRunParkReason, qualifier: string | null): LaneRunDecision =>
      ({ kind: 'park', reason, qualifier, parkedFrom: facts.state });
    const enter = (to: LaneRunStateValue): LaneRunDecision => ({ kind: 'enter', to });

    const act = (input: {
      step: LaneRunKeyStep;
      round: number;
      seatIndex: number;
      head12: string | null;
      retry: number | null;
      attemptOrdinal: number | null;
    }): LaneRunDecision => {
      if (LANE_RUN_KEY_HEAD_RULE[input.step] === 'required' && input.head12 === null) {
        return WAIT_FACTS_INCONSISTENT;
      }
      const built = buildLaneRunStepKey({
        runId: record.runId,
        round: input.round,
        step: input.step,
        seatIndex: input.seatIndex,
        attemptOrdinal: input.attemptOrdinal,
        head12: input.head12,
        retry: input.retry,
      });
      if (!built.ok) {
        return WAIT_FACTS_INCONSISTENT;
      }
      return {
        kind: 'act',
        step: input.step,
        key: built.key,
        round: input.round,
        seatIndex: input.seatIndex,
        head12: input.head12,
        retry: input.retry,
      };
    };

    const prepareAct = (round: number, seatIndex: number): LaneRunDecision =>
      act({
        step: 'prepare',
        round,
        seatIndex,
        head12: null,
        retry: null,
        attemptOrdinal: record.attemptIds.length + 1,
      });

    const dispatchAct = (attempt: LaneRunAttemptFact): LaneRunDecision =>
      act({
        step: 'dispatch',
        round: attempt.round,
        seatIndex: attempt.seatIndex,
        head12: null,
        retry: null,
        attemptOrdinal: record.attemptIds.indexOf(attempt.attemptId) + 1,
      });

    const dispatchOrPrepare = (
      round: number,
      attempt: LaneRunAttemptFact | null,
      seat: LaneRunSeatFact,
    ): LaneRunDecision => {
      if (attempt !== null && attempt.phase === 'prepared' && attempt.round === round) {
        if (facts.admission !== 'admitted') {
          return wait('admission');
        }
        return dispatchAct(attempt);
      }
      if (!seat.ok) {
        return park('seat-plan-exhausted', null);
      }
      return prepareAct(round, seat.seatIndex);
    };

    const stopAct = (attempt: LaneRunAttemptFact, onExhausted: LaneRunDecision): LaneRunDecision => {
      if (attempt.stopsIssued > LANE_RUN_MAX_RETRY) {
        return onExhausted;
      }
      const retry = attempt.stopsIssued === 0 ? null : attempt.stopsIssued;
      return act({
        step: 'stop',
        round: attempt.round,
        seatIndex: attempt.seatIndex,
        head12: null,
        retry,
        attemptOrdinal: null,
      });
    };

    const afterFailure = (round: number, cause: LaneRunFailureCause): LaneRunDecision => {
      const outcome = afterLaneRunFailure(round, cause);
      if (outcome.kind === 'enter') {
        return enter(outcome.to);
      }
      return park(outcome.reason, null);
    };

    const reviewRules = (kind: 'brief-check' | 'code-review'): LaneRunDecision => {
      const review = kind === 'brief-check' ? facts.briefCheck : facts.codeReview;
      if (review.verdict === 'none') {
        if (!facts.reviewSeat.ok) {
          return park('review-seat-unavailable', null);
        }
        return act({
          step: kind,
          round: record.round,
          seatIndex: facts.reviewSeat.seatIndex,
          head12: facts.head12,
          retry: null,
          attemptOrdinal: null,
        });
      }
      if (review.verdict === 'pending') {
        return wait('review-pending');
      }
      if (review.verdict === 'no-receipt') {
        if (review.retries === 0 && review.seatIndex !== null) {
          return act({
            step: kind,
            round: record.round,
            seatIndex: review.seatIndex,
            head12: facts.head12,
            retry: 1,
            attemptOrdinal: null,
          });
        }
        if (facts.reviewSeat.ok && facts.reviewSeat.seatIndex !== review.seatIndex) {
          return act({
            step: kind,
            round: record.round,
            seatIndex: facts.reviewSeat.seatIndex,
            head12: facts.head12,
            retry: null,
            attemptOrdinal: null,
          });
        }
        return park('review-seat-unavailable', null);
      }
      if (review.verdict === 'unknown') {
        return park('ambiguous', kind);
      }
      if (review.verdict === 'passed') {
        return kind === 'brief-check' ? enter('code-review') : enter('accepting');
      }
      return afterFailure(record.round, kind);
    };

    const dispatchingRules = (): LaneRunDecision => {
      const attempt = facts.attempt;
      if (attempt === null) {
        return WAIT_FACTS_INCONSISTENT;
      }
      if (attempt.phase === 'running') {
        return enter('running');
      }
      if (attempt.phase === 'cancelled') {
        return enter('seat-failed');
      }
      if (attempt.phase === 'ended' || attempt.phase === 'collected') {
        return SEAT_TRIGGER_CLASSES.includes(attempt.stopReason)
          ? enter('seat-failed')
          : enter('running');
      }
      if (attempt.phase === 'blocked') {
        return park('ambiguous', 'dispatch');
      }
      return wait('dispatch-pending');
    };

    const runningRules = (): LaneRunDecision => {
      const attempt = facts.attempt;
      if (attempt === null) {
        return WAIT_FACTS_INCONSISTENT;
      }
      if (attempt.phase === 'ended' || attempt.phase === 'collected') {
        return SEAT_TRIGGER_CLASSES.includes(attempt.stopReason)
          ? enter('seat-failed')
          : enter('collecting');
      }
      if (attempt.phase === 'cancelled') {
        return enter('seat-failed');
      }
      if (attempt.phase === 'blocked') {
        return park('ambiguous', 'dispatch');
      }
      if (attempt.phase === 'running' && attempt.deadlineIso !== null) {
        const deadline = Date.parse(attempt.deadlineIso);
        if (!Number.isNaN(deadline) && now >= deadline) {
          return stopAct(attempt, park('ambiguous', 'stop'));
        }
      }
      return wait('lane-running');
    };

    const seatFailedRules = (): LaneRunDecision => {
      if (facts.costCeilingReached) {
        return park('cost-ceiling', null);
      }
      const attempt = facts.attempt;
      if (attempt !== null && attempt.phase === 'prepared' && attempt.round === record.round) {
        return dispatchOrPrepare(record.round, attempt, facts.implementerSeat);
      }
      if (!facts.implementerSeat.ok || facts.roundSeatIndexes.includes(facts.implementerSeat.seatIndex)) {
        return park('seat-plan-exhausted', null);
      }
      return prepareAct(record.round, facts.implementerSeat.seatIndex);
    };

    const collectingRules = (): LaneRunDecision => {
      const attempt = facts.attempt;
      if (attempt === null) {
        return WAIT_FACTS_INCONSISTENT;
      }
      if (attempt.collection === null) {
        return act({
          step: 'collect',
          round: attempt.round,
          seatIndex: attempt.seatIndex,
          head12: null,
          retry: null,
          attemptOrdinal: null,
        });
      }
      if (attempt.collection.commits === 0) {
        return enter('seat-failed');
      }
      if (attempt.collection.manifest === 'missing' || attempt.collection.manifest === 'mismatch') {
        return park('artifacts-unsealed', null);
      }
      return enter('gating');
    };

    const gatingRules = (): LaneRunDecision => {
      if (facts.gate === 'none') {
        const attempt = facts.attempt;
        if (attempt === null) {
          return WAIT_FACTS_INCONSISTENT;
        }
        return act({
          step: 'gate',
          round: attempt.round,
          seatIndex: attempt.seatIndex,
          head12: facts.head12,
          retry: null,
          attemptOrdinal: null,
        });
      }
      if (facts.gate === 'pending') {
        return wait('gate-pending');
      }
      if (facts.gate === 'unknown') {
        return park('ambiguous', 'gate');
      }
      if (facts.gate === 'passed') {
        return enter('brief-check');
      }
      return afterFailure(record.round, 'gate');
    };

    const fixingRules = (): LaneRunDecision => {
      if (record.round >= 2) {
        return park('blocker-after-round-2', null);
      }
      if (facts.costCeilingReached) {
        return park('cost-ceiling', null);
      }
      const nextRound = record.round + 1;
      const attempt = facts.attempt;
      if (attempt !== null && attempt.phase === 'prepared' && attempt.round === nextRound) {
        return dispatchOrPrepare(nextRound, attempt, facts.implementerSeat);
      }
      if (attempt === null) {
        return WAIT_FACTS_INCONSISTENT;
      }
      if (attempt.phase !== 'collected' && attempt.phase !== 'cancelled') {
        return wait('prior-not-ended');
      }
      return dispatchOrPrepare(nextRound, attempt, facts.implementerSeat);
    };

    const acceptingRules = (): LaneRunDecision => {
      if (facts.acceptance === 'none') {
        const attempt = facts.attempt;
        if (attempt === null) {
          return WAIT_FACTS_INCONSISTENT;
        }
        return act({
          step: 'accept',
          round: attempt.round,
          seatIndex: attempt.seatIndex,
          head12: facts.head12,
          retry: null,
          attemptOrdinal: null,
        });
      }
      if (facts.acceptance === 'unknown') {
        return park('ambiguous', 'accept');
      }
      if (facts.acceptance === 'rejected') {
        return park('acceptance-rejected', null);
      }
      return enter(afterLaneRunAcceptance(record.tier, record.prNumber));
    };

    const awaitingPremergeRules = (): LaneRunDecision => {
      if (facts.preMerge === 'none') {
        return wait('premerge-pending');
      }
      if (facts.preMerge === 'unknown') {
        return park('ambiguous', 'pre-merge');
      }
      if (facts.preMerge === 'passed') {
        return enter(afterLaneRunPreMergePass(record.prNumber));
      }
      return afterFailure(record.round, 'pre-merge');
    };

    const openingPrRules = (): LaneRunDecision => {
      if (record.prNumber !== null) {
        return enter('watching-ci');
      }
      const attempt = facts.attempt;
      if (attempt === null) {
        return WAIT_FACTS_INCONSISTENT;
      }
      return act({
        step: 'open-pr',
        round: attempt.round,
        seatIndex: attempt.seatIndex,
        head12: facts.head12,
        retry: null,
        attemptOrdinal: null,
      });
    };

    const pushingRules = (): LaneRunDecision => {
      if (facts.pr === null) {
        return WAIT_FACTS_INCONSISTENT;
      }
      if (facts.pr.head12 === facts.head12) {
        return enter('watching-ci');
      }
      const attempt = facts.attempt;
      if (attempt === null) {
        return WAIT_FACTS_INCONSISTENT;
      }
      return act({
        step: 'push',
        round: attempt.round,
        seatIndex: attempt.seatIndex,
        head12: facts.head12,
        retry: null,
        attemptOrdinal: null,
      });
    };

    const watchingCiRules = (): LaneRunDecision => {
      if (facts.ci === 'pending') {
        return wait('ci-pending');
      }
      if (facts.ci === 'unknown') {
        return wait('ci-unknown');
      }
      if (facts.ci === 'passed') {
        return enter('merging');
      }
      return afterFailure(record.round, 'ci');
    };

    const mergingRules = (): LaneRunDecision => {
      if (facts.pr === null) {
        return WAIT_FACTS_INCONSISTENT;
      }
      if (facts.pr.state === 'merged' && facts.pr.head12 === facts.head12) {
        return enter('merged');
      }
      if (facts.pr.state === 'merged' || facts.pr.state === 'closed') {
        return park('ambiguous', 'merge');
      }
      if (facts.merge.oneWayDoor) {
        return park('one-way-door', null);
      }
      if (facts.merge.branchBehind) {
        return park('branch-behind', null);
      }
      if (!facts.merge.policyGrant) {
        return park('owner-merge', null);
      }
      if (!facts.merge.trainFree) {
        return wait('merge-train');
      }
      const attempt = facts.attempt;
      if (attempt === null) {
        return WAIT_FACTS_INCONSISTENT;
      }
      return act({
        step: 'merge',
        round: attempt.round,
        seatIndex: attempt.seatIndex,
        head12: facts.head12,
        retry: null,
        attemptOrdinal: null,
      });
    };

    // G1: terminal states.
    if (facts.state === 'merged' || facts.state === 'stopped') {
      return { kind: 'done' };
    }

    // G2: the projected state and the record's park must agree.
    if ((facts.state === 'parked') !== (record.parked !== null)) {
      return WAIT_FACTS_INCONSISTENT;
    }

    // G3a: an unread intent without a result is reconciled first, in any state.
    if (facts.pendingIntent !== null && facts.pendingIntent.reconciliation === 'unread') {
      return { kind: 'reconcile', step: facts.pendingIntent.step, key: facts.pendingIntent.key };
    }

    // G3b / G3c: an ambiguous intent parks (or waits, when already parked).
    if (facts.pendingIntent !== null && facts.pendingIntent.reconciliation === 'ambiguous') {
      if (facts.state === 'parked') {
        return wait('parked');
      }
      return park('ambiguous', facts.pendingIntent.step);
    }

    // G3d: a merge that landed ends `merged`, never `stopped` (§3.9.1).
    if (facts.stopMode !== null && facts.state === 'merging' && facts.pr !== null && facts.pr.state === 'merged') {
      if (facts.pr.head12 === facts.head12) {
        return enter('merged');
      }
      return park('ambiguous', 'merge');
    }

    // G4a: a force stop with nothing to stop ends the run.
    if (facts.stopMode === 'force') {
      const phase = facts.attempt === null ? null : facts.attempt.phase;
      if (phase === null || phase === 'ended' || phase === 'collected' || phase === 'cancelled') {
        return enter('stopped');
      }
    }

    // G4h: the halt-marker exit for a halted park with a stop pending (not a resume).
    const haltLift = laneRunHaltLiftExit({ record, state: facts.state, halted: facts.halted, stopMode: facts.stopMode });
    if (haltLift !== null) {
      return enter(haltLift);
    }

    // G4e: record-only cancel of a never-dispatched attempt, under its stop step key.
    if (
      facts.stopMode !== null &&
      facts.attempt !== null &&
      facts.attempt.phase === 'prepared' &&
      (facts.attempt.dispatchResult === 'none' || facts.attempt.dispatchResult === 'not-started')
    ) {
      if (facts.attempt.stopsIssued > LANE_RUN_MAX_RETRY) {
        return wait('stop-unconfirmed');
      }
      const retry = facts.attempt.stopsIssued === 0 ? null : facts.attempt.stopsIssued;
      const built = buildLaneRunStepKey({
        runId: record.runId,
        round: facts.attempt.round,
        step: 'stop',
        seatIndex: facts.attempt.seatIndex,
        attemptOrdinal: null,
        head12: null,
        retry,
      });
      if (!built.ok) {
        return WAIT_FACTS_INCONSISTENT;
      }
      return {
        kind: 'cancel',
        key: built.key,
        attemptId: facts.attempt.attemptId,
        round: facts.attempt.round,
        seatIndex: facts.attempt.seatIndex,
        retry,
      };
    }

    // G4f / G4g: a graceful stop lets a started prepared attempt finish (or waits when parked).
    if (
      facts.stopMode === 'graceful' &&
      facts.attempt !== null &&
      facts.attempt.phase === 'prepared' &&
      facts.attempt.dispatchResult === 'started'
    ) {
      if (facts.state === 'parked') {
        return wait('parked');
      }
      return park('ambiguous', 'dispatch');
    }

    // G4b / G4c: the halt wins over the stop call, and a halted park waits.
    if (facts.stopMode !== null && facts.halted) {
      if (facts.state === 'parked') {
        return wait('parked');
      }
      return park('halted', null);
    }

    // G4j: a force stop reconciles a started prepared attempt before it can be stopped.
    if (
      facts.stopMode === 'force' &&
      facts.attempt !== null &&
      facts.attempt.phase === 'prepared' &&
      facts.attempt.dispatchResult === 'started'
    ) {
      if (facts.attempt.stopsIssued > LANE_RUN_MAX_RETRY) {
        return wait('stop-unconfirmed');
      }
      const retry = facts.attempt.stopsIssued === 0 ? null : facts.attempt.stopsIssued;
      let key = record.runId + '/r' + facts.attempt.round + '/reconcile/' + facts.attempt.seatIndex;
      if (retry !== null) {
        key += '/retry' + retry;
      }
      return { kind: 'reconcile', step: 'dispatch', key };
    }

    // G4d: a force stop stops a dispatching, running or blocked attempt.
    if (
      facts.stopMode === 'force' &&
      facts.attempt !== null &&
      (facts.attempt.phase === 'dispatching' || facts.attempt.phase === 'running' || facts.attempt.phase === 'blocked')
    ) {
      return stopAct(facts.attempt, wait('stop-unconfirmed'));
    }

    // G4i / GD1–GD6 (§3.9.1): a graceful stop drains the run's live attempt.
    if (facts.stopMode === 'graceful') {
      const phase = facts.attempt === null ? null : facts.attempt.phase;
      const live = phase === 'dispatching' || phase === 'running' || phase === 'blocked';
      const drainContinues = laneRunDrainContinues(facts.state, facts.gate);
      const drainWait = (): LaneRunDecision => {
        if (facts.stopRequestedAtIso === null || Number.isNaN(Date.parse(facts.stopRequestedAtIso))) {
          return wait('stop-grace-exceeded');
        }
        if (now >= Date.parse(facts.stopRequestedAtIso) + facts.stopGraceMinutes * 60_000) {
          return wait('stop-grace-exceeded');
        }
        return wait('stop-draining');
      };
      // GD1: nothing live left to drain ends the run.
      if ((phase === null || !live) && !drainContinues) {
        return enter('stopped');
      }
      // GD2: a park whose attempt may still run stands (§3.8).
      if (live && facts.state === 'parked') {
        return wait('parked');
      }
      // GD3: a live attempt outside the drain states waits on the drain.
      if (live && !drainContinues) {
        return drainWait();
      }
      // GD4: inside the drain states the state rules apply, with GD5 and GD6.
      let decision: LaneRunDecision;
      switch (facts.state) {
        case 'dispatching':
          decision = dispatchingRules();
          break;
        case 'running':
          decision = runningRules();
          break;
        case 'collecting':
          decision = collectingRules();
          break;
        case 'gating':
          decision = gatingRules();
          break;
        default:
          decision = WAIT_FACTS_INCONSISTENT;
      }
      if (decision.kind === 'wait' && (decision.reason === 'dispatch-pending' || decision.reason === 'lane-running')) {
        return drainWait();
      }
      if (
        decision.kind === 'act' &&
        !(LANE_RUN_DRAIN_STEPS as readonly string[]).includes(decision.step) &&
        decision.step !== 'stop'
      ) {
        return drainWait();
      }
      return decision;
    }

    // G5: parked waits for a resume or the owner's answer.
    if (facts.state === 'parked') {
      return wait('parked');
    }

    // G6: the halt allows no external action.
    if (facts.halted) {
      return park('halted', null);
    }

    // G7 / G7b: a head change after acceptance re-enters gating; a missing head is inconsistent.
    if (laneRunHeadChanged(facts.state, facts.head12, facts.acceptedHead12)) {
      return enter('gating');
    }
    if (
      (LANE_RUN_HEAD_CHANGE_STATES as readonly LaneRunStateValue[]).includes(facts.state) &&
      (facts.head12 === null || facts.acceptedHead12 === null)
    ) {
      return WAIT_FACTS_INCONSISTENT;
    }

    // G8 / G8b: a refused step parks; a refused prepare is never re-sent under its spent key.
    const stepOfState = (LANE_RUN_STEP_OF_STATE as Partial<Record<LaneRunStateValue, LaneRunKeyStep>>)[facts.state];
    if (facts.refusedStep !== null && stepOfState !== undefined && facts.refusedStep === stepOfState) {
      return park('step-refused', facts.refusedStep);
    }
    if (
      facts.refusedStep === 'prepare' &&
      (facts.state === 'ready' || facts.state === 'seat-failed' || facts.state === 'fixing')
    ) {
      return park('step-refused', 'prepare');
    }

    switch (facts.state) {
      case 'ready':
        if (facts.costCeilingReached) {
          return park('cost-ceiling', null);
        }
        return dispatchOrPrepare(0, facts.attempt, facts.implementerSeat);
      case 'dispatching':
        return dispatchingRules();
      case 'running':
        return runningRules();
      case 'seat-failed':
        return seatFailedRules();
      case 'collecting':
        return collectingRules();
      case 'gating':
        return gatingRules();
      case 'brief-check':
        return reviewRules('brief-check');
      case 'code-review':
        return reviewRules('code-review');
      case 'fixing':
        return fixingRules();
      case 'accepting':
        return acceptingRules();
      case 'awaiting-premerge':
        return awaitingPremergeRules();
      case 'opening-pr':
        return openingPrRules();
      case 'pushing':
        return pushingRules();
      case 'watching-ci':
        return watchingCiRules();
      case 'merging':
        return mergingRules();
      default:
        return WAIT_FACTS_INCONSISTENT;
    }
  } catch {
    return WAIT_FACTS_INCONSISTENT;
  }
}
