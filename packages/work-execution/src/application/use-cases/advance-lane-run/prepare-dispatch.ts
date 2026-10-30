/** The `act prepare` and `act dispatch` steps of AdvanceLaneRunUseCase (AL-1). */
import type { AdvanceLaneRunRefusal, AdvanceLaneRunRequest, AdvanceLaneRunResult } from '../../ports/in/AdvanceLaneRunPort.in-port.js';
import { AttemptRevisionConflictError } from '../../ports/out/AttemptRepositoryPort.out-port.js';
import { parseSeatTool, type AttemptRecord, type AttemptSeatOverrideRecord, type AttemptSeatSelectionRecord } from '../../../domain/execution-records.js';
import type { LaneRunDecision } from '../../../domain/lane-run-decider.js';
import type { LaneRunResultReasonCode } from '../../../domain/lane-run-step-facts.js';
import type { LaneRunCursorsRecord, LaneRunRecord } from '../../../domain/lane-run-records.js';
import { implementerRoleFor } from '../../../domain/lane-run-transitions.js';
import { seatMatchesAssignment, seatSelectionRecord } from '../../../domain/seat-selection.js';
import type { LaneRunStateValue } from '../../../domain/value-objects/LaneRunState.vo.js';
import { SeatPlan } from '../../../domain/value-objects/SeatPlan.vo.js';
import { conductedRunnerOf } from './conducted-host.js';
import type { AdvanceStepContext, GatheredLaneRunFacts } from './step-context.js';
import { appendConduct, appendRunIntent, appendRunResult, ceilingPark, performPark, saveOrRefuse } from './step-context.js';
import { manifestExpectedArtifacts, manifestPositiveInteger, manifestTimeLimitSeconds, readFrozenManifest } from './frozen-manifest.js';
import { performFixPrepare } from './review-fix.js';
import { parkSpentOneWayKey } from './merge.js';

/**
 * The `act prepare` decision (K4-5): a fresh round-0 attempt on the selected
 * first-pass seat, copying the frozen-brief fields from the run's latest
 * attempt (the seat pivot). Order: intent, attempt record, run record,
 * result — so a result never exists for an attempt the run record does not
 * list. A fix-round prepare stays with K5 and routes to `performFixPrepare`
 * under its key.
 */
export async function performPrepare(ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: Extract<LaneRunDecision, { kind: 'act' }>,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  const ceiling = await ceilingPark(ctx, record, gathered, request);
  if (ceiling !== null) {
    return ceiling;
  }
  const nowIso = request.nowIso;
  const refuse = async (reasonCode: LaneRunResultReasonCode): Promise<AdvanceLaneRunResult> => {
    const intentRefusal = await appendRunIntent(ctx, request, decision.key, null);
    if (intentRefusal !== null) {
      return { outcome: 'refused', reason: intentRefusal };
    }
    const resultRefusal = await appendRunResult(ctx, request, decision.key, 'refused', reasonCode);
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    return { outcome: 'acted', step: decision.step, key: decision.key, result: 'refused', reasonCode };
  };

  if (decision.round !== 0) {
    return performFixPrepare(ctx, record, gathered, decision, request, refuse);
  }
  let source: AttemptRecord | null = null;
  for (let index = gathered.attemptRecords.length - 1; index >= 0; index -= 1) {
    const candidate = gathered.attemptRecords[index];
    if (candidate !== null) {
      source = candidate;
      break;
    }
  }
  if (source === null) {
    return refuse('no-frozen-brief');
  }
  const planResult = SeatPlan.create(source.seatPlan);
  const seat =
    planResult.success && planResult.value !== undefined
      ? planResult.value.getSeats('first-pass')[decision.seatIndex]
      : undefined;
  if (seat === undefined) {
    return refuse('seat-missing');
  }
  const sourceTool = parseSeatTool(source.seatSelection?.tool) ?? 'opencode';
  if ((parseSeatTool(seat.tool) ?? 'opencode') !== sourceTool) {
    return refuse('seat-tool-differs');
  }
  const attemptId = 'attempt-' + ctx.deps.newUlid();
  const intentRefusal = await appendRunIntent(ctx, request, decision.key, attemptId);
  if (intentRefusal !== null) {
    return { outcome: 'refused', reason: intentRefusal };
  }
  // The next attempt keeps the run's host identity (seam register: a conducted
  // attempt always carries its runner host); the session fields stay null and
  // dispatch overwrites the block with describeRunner().
  const sourceRunner = conductedRunnerOf(source);
  const attempt: AttemptRecord = {
    ...(sourceRunner !== null
      ? {
          runner: {
            kind: sourceRunner.kind,
            remotePort: sourceRunner.remotePort,
            host: sourceRunner.host,
            hostName: sourceRunner.hostName,
            agent: null,
            model: null,
            variant: null,
          },
        }
      : {}),
    id: attemptId,
    workOrderId: source.workOrderId,
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: source.id,
    worktreePath: source.worktreePath,
    baseCommit: source.baseCommit,
    state: 'intent-recorded',
    outcome: null,
    revision: 0,
    briefDigest: source.briefDigest,
    briefPackagePath: source.briefPackagePath,
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    seatPlan: source.seatPlan ?? null,
    seatSelection: seatSelectionRecord('first-pass', decision.seatIndex, seat),
    reviewerSeat: source.reviewerSeat ?? null,
    createdAtIso: nowIso,
    updatedAtIso: nowIso,
  };
  try {
    await ctx.deps.attemptRepo.saveAttempt(attempt);
  } catch (error) {
    if (error instanceof AttemptRevisionConflictError) {
      const resultRefusal = await appendRunResult(ctx, request, decision.key, 'refused', 'attempt-exists');
      if (resultRefusal !== null) {
        return { outcome: 'refused', reason: resultRefusal };
      }
      return { outcome: 'acted', step: decision.step, key: decision.key, result: 'refused', reasonCode: 'attempt-exists' };
    }
    throw error;
  }
  try {
    const saved = await saveOrRefuse(ctx,
      { ...record, attemptIds: [...record.attemptIds, attemptId], revision: record.revision + 1 },
      request,
    );
    if (!saved.ok) {
      // The intent stays pending; K4-7's prepare reconcile finds the attempt
      // and appends the id to the run record.
      return { outcome: 'refused', reason: saved.reason };
    }
  } catch {
    return { outcome: 'refused', reason: 'save-refused' };
  }
  const resultRefusal = await appendRunResult(ctx, request, decision.key, 'completed', 'prepared');
  if (resultRefusal !== null) {
    return { outcome: 'refused', reason: resultRefusal };
  }
  return { outcome: 'acted', step: decision.step, key: decision.key, result: 'completed', reasonCode: 'prepared' };
}

/**
 * KF-16: the fixed detail code a refused dispatch journals with its result
 * entry, derived from the refusal's stable prefix or phrase. Reason details
 * are fixed codes, never free text; unknown refusals map to `other` and the
 * function never returns the input text.
 */
export function dispatchRefusalDetail(reason: string): string {
  // Worktree refusals name the path and then a fixed phrase. The path may hold
  // spaces, so the first fixed phrase after it decides; a listed file name
  // after the phrase can never change the code.
  const worktree = /^Worktree .+? (does not match the base commit|does not match the prior attempt's head|has uncommitted changes|has untracked files|contains residue from earlier attempts)/.exec(reason);
  if (worktree !== null) {
    return WORKTREE_REFUSAL_DETAILS[worktree[1]!] ?? 'other';
  }
  if (reason.startsWith('No active capacity reservation')) {
    return 'no-reservation';
  }
  if (reason.includes('is not the configured runner host')) {
    return 'reservation-host-mismatch';
  }
  if (reason.includes('does not match the path allocated by the capacity reservation')) {
    return 'reservation-worktree-mismatch';
  }
  if (reason.startsWith('Runner capabilities do not satisfy')) {
    return 'capabilities-missing';
  }
  if (reason.endsWith('a fix attempt starts only after it is collected or cancelled')) {
    return 'prior-not-settled';
  }
  if (reason.startsWith('Prior attempt not found')) {
    return 'prior-not-found';
  }
  if (reason.startsWith('Prior attempt ') && reason.endsWith('is collected but has no sealed head commit')) {
    return 'prior-head-missing';
  }
  if (reason.startsWith('Work order not found')) {
    return 'work-order-missing';
  }
  if (reason === 'runner-not-available' || reason.startsWith('No runner port can be described')) {
    return 'runner-unavailable';
  }
  // KF-18: the seat-binding refusal of a fix attempt whose fix seat differs
  // from the frozen brief's model assignment, and the reviewer-seat family
  // refusal of a seat override.
  if (reason.includes('does not match seat')) {
    return 'seat-mismatch';
  }
  if (reason.includes('shares underlying model family with recorded reviewer seat')) {
    return 'seat-family-conflict';
  }
  return 'other';
}

const WORKTREE_REFUSAL_DETAILS: Readonly<Record<string, string>> = {
  'does not match the base commit': 'worktree-head-mismatch',
  "does not match the prior attempt's head": 'worktree-head-mismatch',
  'has uncommitted changes': 'worktree-uncommitted',
  'has untracked files': 'worktree-untracked',
  'contains residue from earlier attempts': 'worktree-residue',
};

/**
 * The `act dispatch` decision (K4-5): start the prepared attempt through
 * `DispatchAttemptPort` with the frozen brief's limits, raising the round and
 * the seat cursor on the record before the call (§3.2, D8). The dispatch key
 * is one-way: when a reconcile already recorded the dispatch as never
 * started but its cancel did not land, the attempt is cancelled instead of
 * re-sending the key. A pivot dispatches with a conductor seat override.
 */
export async function performDispatch(ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: Extract<LaneRunDecision, { kind: 'act' }>,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  const facts = gathered.facts;
  const ceiling = await ceilingPark(ctx, record, gathered, request);
  if (ceiling !== null) {
    return ceiling;
  }
  const dispatch = ctx.deps.dispatchAttempt;
  if (dispatch === undefined) {
    return { outcome: 'not-wired', step: decision.step };
  }
  const nowIso = request.nowIso;
  const latest = gathered.latestAttempt;
  if (latest === null || latest.state !== 'intent-recorded') {
    return { outcome: 'waiting', reason: 'facts-inconsistent' };
  }
  if (facts.attempt !== null && facts.attempt.dispatchResult === 'not-started') {
    const cancel = ctx.deps.cancelPreparedAttempt;
    if (cancel === undefined) {
      return { outcome: 'not-wired', step: decision.step };
    }
    await cancel.cancelPreparedAttempt({ attemptId: latest.id, nowIso });
    return { outcome: 'waiting', reason: 'dispatch-pending' };
  }
  // The dispatch key is one-way (KF-10): an intent already recorded for this
  // key is never re-sent. A spent key parks step-refused dispatch without
  // writing (the parkSpentOneWayKey shape from merge.ts) instead of hitting
  // the journal's duplicate-key refusal on every resume. The `not-started`
  // cancel above owns the refused-dispatch pivot, so it runs first.
  const spent = await parkSpentOneWayKey(ctx, record, gathered, decision, request);
  if (spent !== null) {
    return spent;
  }
  const manifest = await readFrozenManifest(latest, ctx.deps.artifactPort);
  const stepLimit = manifestPositiveInteger(manifest, 'stepLimit');
  const timeLimitSeconds = manifestTimeLimitSeconds(manifest);
  const expectedArtifacts = manifestExpectedArtifacts(manifest);
  const briefPackagePath = latest.briefPackagePath;
  const briefDigest = latest.briefDigest;
  const inputsReadable =
    stepLimit !== null &&
    timeLimitSeconds !== null &&
    expectedArtifacts !== null &&
    briefPackagePath !== null &&
    briefDigest !== null;
  const intentRefusal = await appendRunIntent(ctx, request, decision.key, latest.id);
  if (intentRefusal !== null) {
    return { outcome: 'refused', reason: intentRefusal };
  }
  if (!inputsReadable) {
    const resultRefusal = await appendRunResult(ctx, request, decision.key, 'refused', 'dispatch-inputs-unreadable');
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    return performPark(ctx, record, 'step-refused', 'dispatch', facts.state, request);
  }
  const role = implementerRoleFor(decision.round, facts.state);
  const roundRaised = decision.round > record.round;
  if (roundRaised || record.cursors[role] !== decision.seatIndex) {
    const cursors: LaneRunCursorsRecord =
      role === 'first-pass'
        ? { ...record.cursors, 'first-pass': decision.seatIndex }
        : { ...record.cursors, fix: decision.seatIndex };
    const saved = await saveOrRefuse(ctx,
      {
        ...record,
        round: roundRaised ? decision.round : record.round,
        cursors,
        revision: record.revision + 1,
      },
      request,
    );
    if (!saved.ok) {
      // The pending intent is reconciled by K4-7 as never started; the
      // dispatch is never called on a refused save.
      return { outcome: 'refused', reason: saved.reason };
    }
    // Later writes in this advance (a park) must chain on the saved revision.
    record = saved.record ?? record;
  }
  // KF-18: a fix attempt dispatches on its own fix seat through a seat
  // override; the seat-plan pivot (a re-prepare on the round's next seat)
  // keeps its override. A fix attempt with no seat selection keeps no
  // override, and a first attempt (priorAttemptId null) never carries one.
  // A fix attempt's override names only a seat of its frozen plan: the
  // selection is verified against the plan before it is used (no plan,
  // unparsable plan, index out of range, or id/model/tool/variant/agent
  // mismatch send no override — the dispatch then refuses `seat-mismatch`
  // and the run parks, never a guessed seat).
  const seatSelection = latest.seatSelection ?? null;
  let seatForOverride: AttemptSeatSelectionRecord | null = null;
  if (latest.kind === 'initial' && latest.priorAttemptId !== null) {
    seatForOverride = seatSelection;
  } else if (latest.kind === 'fix' && seatSelection !== null && seatSelection.role === 'fix') {
    const planResult = SeatPlan.create(latest.seatPlan);
    if (planResult.success && planResult.value !== undefined) {
      const planSeat = planResult.value.getSeats('fix')[seatSelection.seatIndex];
      if (
        planSeat !== undefined &&
        planSeat.id === seatSelection.seatId &&
        seatMatchesAssignment(planSeat, {
          model: seatSelection.model,
          tool: seatSelection.tool,
          variant: seatSelection.variant,
          agent: seatSelection.agent,
        })
      ) {
        seatForOverride = seatSelection;
      }
    }
  }
  const seatOverride: AttemptSeatOverrideRecord | null =
    seatForOverride === null
      ? null
      : {
          model: seatForOverride.model,
          ...(seatForOverride.agent !== null ? { agent: seatForOverride.agent } : {}),
          ...(seatForOverride.variant !== null ? { variant: seatForOverride.variant } : {}),
          reason:
            latest.kind === 'fix'
              ? 'fix seat ' + seatForOverride.seatId
              : 'seat-plan pivot to ' + seatForOverride.seatId,
          setBy: 'conductor',
          expiresAtIso: new Date(Date.parse(nowIso) + timeLimitSeconds * 1000).toISOString(),
        };
  const dispatched = await dispatch.dispatchAttempt({
    attemptId: latest.id,
    workOrderId: record.workOrderId,
    worktreePath: latest.worktreePath,
    briefPackagePath,
    briefDigest,
    baseCommit: latest.baseCommit,
    stepLimit,
    timeLimitSeconds,
    expectedArtifacts,
    nowIso,
    ...(seatOverride !== null ? { seatOverride } : {}),
    ...(ctx.deps.installationSchemaVersion !== undefined
      ? { installationSchemaVersion: ctx.deps.installationSchemaVersion }
      : {}),
  });
  if (dispatched.outcome === 'started' || dispatched.outcome === 'blocked' || dispatched.outcome === 'unknown') {
    let reasonCode: LaneRunResultReasonCode;
    if (dispatched.outcome === 'started') {
      reasonCode = 'dispatch-started';
    } else if (dispatched.outcome === 'blocked') {
      reasonCode = 'dispatch-blocked';
    } else {
      reasonCode = 'dispatch-unknown';
    }
    const resultRefusal = await appendRunResult(ctx, request, decision.key, 'completed', reasonCode);
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    const conductRefusal = await conductDispatching(ctx, facts.state, request);
    if (conductRefusal !== null) {
      return { outcome: 'refused', reason: conductRefusal };
    }
    return { outcome: 'acted', step: decision.step, key: decision.key, result: 'completed', reasonCode };
  }
  // Refused: a runner refusal saved with its stop reason (S1) pivots through
  // seat-failed; anything else parks for the owner (the key is spent). A
  // refused FIX dispatch recovers in the same round after resume: the round
  // is already raised here, so the decider re-reads the parked attempt as
  // still this round's and the next advance cancels it and prepares again
  // at that round (KF-17).
  const stored = await ctx.deps.attemptRepo.findAttemptById(latest.id);
  let reasonCode: LaneRunResultReasonCode;
  if (stored !== null && stored.state === 'cancelled') {
    reasonCode = 'runner-refused';
  } else {
    reasonCode = 'dispatch-refused';
  }
  // KF-16: the refused result journals a fixed detail code derived from the
  // refusal text, for the dispatch-refused park and the runner-refused pivot
  // alike.
  const resultRefusal = await appendRunResult(
    ctx, request, decision.key, 'refused', reasonCode, dispatchRefusalDetail(dispatched.reason),
  );
  if (resultRefusal !== null) {
    return { outcome: 'refused', reason: resultRefusal };
  }
  if (reasonCode === 'runner-refused') {
    const conductRefusal = await conductDispatching(ctx, facts.state, request);
    if (conductRefusal !== null) {
      return { outcome: 'refused', reason: conductRefusal };
    }
    return { outcome: 'acted', step: decision.step, key: decision.key, result: 'refused', reasonCode };
  }
  return performPark(ctx, record, 'step-refused', 'dispatch', facts.state, request);
}

/** The `dispatching` conduct entry after a dispatch, unless the run is already in it. */
export async function conductDispatching(ctx: AdvanceStepContext,
  state: LaneRunStateValue,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunRefusal | null> {
  if (state === 'dispatching') {
    return null;
  }
  const appended = await appendConduct(ctx, request, 'dispatching');
  return appended.ok ? null : appended.reason;
}
