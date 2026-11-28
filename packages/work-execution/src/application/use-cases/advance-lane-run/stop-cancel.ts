/** The `act stop` and G4e `cancel` steps of AdvanceLaneRunUseCase (AL-1). */
import type { AdvanceLaneRunRequest, AdvanceLaneRunResult } from '../../ports/in/AdvanceLaneRunPort.in-port.js';
import type { StopAttemptResult } from '../../ports/in/StopAttemptPort.in-port.js';
import type { AttemptRepositoryPort } from '../../ports/out/AttemptRepositoryPort.out-port.js';
import type { LaneRunDecision } from '../../../domain/lane-run-decider.js';
import { LANE_RUN_INTENT_ABANDONED_REASON_CODE } from '../../../domain/lane-run-step-facts.js';
import type { LaneRunResultReasonCode } from '../../../domain/lane-run-step-facts.js';
import { isNonFinalLaneRunOutcome } from '../../../domain/lane-run-journal.js';
import type { LaneRunJournalOutcome } from '../../../domain/lane-run-journal.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import { laneRunStopEffect } from '../../../domain/lane-run-transitions.js';
import type { RunStopEffect, RunStopOutcome } from '../../../domain/lane-run-transitions.js';
import type { AttemptRecord } from '../../../domain/execution-records.js';
import { refreshGatheredJournalFacts } from './facts.js';
import type { AdvanceStepContext, GatheredLaneRunFacts } from './step-context.js';
import { appendConduct, appendRunIntent, appendRunResult, performPark, refusedResult, releaseWorkOrderAtEnd } from './step-context.js';
import { conductedRunnerOf } from './conducted-host.js';
import { worktreeRecoveryPatchInputsValid } from './prepare-dispatch.js';

/** CB3: the suffix that distinguishes a stop-timeout patch from a park or GB3 patch. */
export const STOP_TIMEOUT_PATCH_SUFFIX = '.stop-timeout.patch';

/** CB3: the journal detail prefix a stop-timeout patch is recorded under. */
export const STOP_TIMEOUT_PRESERVE_DETAIL = 'stop-timeout worktree preserved: ';

/** GB3's own marker: its presence means a recovery already owns this worktree. */
const GB3_DETAIL = 'preserved uncommitted edits:';

/**
 * CB3: after a `stop-timeout`, the killed seat's worktree may still hold
 * uncommitted tracked edits no commit carries and no next seat has yet been
 * handed. This preserves them as a patch beside the worktree and journals
 * where it went, mirroring F198's park preserve. Deliberately NON-DESTRUCTIVE:
 * nothing is reset, cancelled or deleted, so the worktree a later fix seat
 * receives under `allowUncommittedHandover` is unchanged and the patch is
 * additive evidence. Never throws and never fails or alters the already
 * recorded `stop-timeout` result: every refusal (unwired port, an invalid
 * patch path, no runner host, a clean tree, an unreadable host) is silent.
 */
export async function preserveStoppedWorktree(
  ctx: AdvanceStepContext,
  record: LaneRunRecord,
  latest: AttemptRecord | null,
  nowIso: string,
): Promise<void> {
  if (latest === null) {
    return;
  }
  const preserve = ctx.deps.worktreeRecovery?.preserveWorktreeEdits?.bind(ctx.deps.worktreeRecovery);
  const append = ctx.deps.executionJournal.appendJournalEntry?.bind(ctx.deps.executionJournal);
  if (preserve === undefined || append === undefined) {
    return;
  }
  if (latest.worktreePath === null || !worktreeRecoveryPatchInputsValid(latest.worktreePath, latest.id)) {
    return;
  }
  const recordedHost = conductedRunnerOf(latest);
  if (recordedHost === null) {
    return;
  }
  try {
    const patchPath = latest.worktreePath + '.' + latest.id + STOP_TIMEOUT_PATCH_SUFFIX;
    const priorEntries = await ctx.deps.executionJournal.listJournalEntriesForAttempt(latest.id);
    // Idempotent: a re-reconciled stop of the same attempt must not write a
    // second entry, and `destination-exists` below would refuse the write anyway.
    const owned = priorEntries.some((entry) => {
      const detail = entry.detail ?? '';
      return detail.startsWith(STOP_TIMEOUT_PRESERVE_DETAIL) || detail.startsWith(GB3_DETAIL);
    });
    if (owned) {
      return;
    }
    const preserved = await preserve({ worktreePath: latest.worktreePath, patchPath, recordedHost });
    // `nothing-to-preserve` is the common, healthy case: a clean worktree. Only
    // a patch that now exists is worth a journal entry.
    const saved =
      preserved.outcome === 'preserved' ||
      (preserved.outcome === 'refused' && preserved.reason === 'destination-exists');
    if (!saved) {
      return;
    }
    await append({
      id: latest.id + ':dispatch:' + String(priorEntries.length + 1),
      attemptId: latest.id,
      workOrderId: record.workOrderId,
      action: 'dispatch',
      baseCommit: latest.baseCommit,
      recordedAtIso: nowIso,
      status: 'completed',
      sessionId: null,
      detail: STOP_TIMEOUT_PRESERVE_DETAIL + patchPath,
    });
  } catch {
    // A stop-timeout result is never failed by its evidence step.
  }
}

export type AbandonAmbiguousStopOutcome =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'resolved'; readonly gathered: GatheredLaneRunFacts }
  | { readonly kind: 'refused'; readonly result: AdvanceLaneRunResult };

/**
 * F171: a recorded stop on a run whose pending intent is ambiguous would wait
 * on that intent forever (G3b/G3c run ahead of the stop rules). The operator's
 * stop abandons it: one final `overtaken` `intent-abandoned-by-operator` result
 * on the intent's key, then the journal-derived facts are refreshed so the
 * decider applies the stop rules. FS: the same applies to an unread `premerge`
 * intent (a `wait` hold with no result) under a force stop with no halt — the
 * decider no longer reconciles it (G3a), so it would block the stop forever on
 * `premerge-pending`. Nothing is read or written unless a stop is recorded over
 * an ambiguous non-reconcile intent or over an unread premerge intent under a
 * force stop; a merged PR (G3f) still ends the run `merged`, and a key that
 * already has a final result is not written twice.
 */
export async function abandonAmbiguousIntentForStop(ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: LaneRunDecision,
  request: AdvanceLaneRunRequest,
): Promise<AbandonAmbiguousStopOutcome> {
  const pending = gathered.facts.pendingIntent;
  const ambiguousNonReconcile =
    pending !== null &&
    pending.reconciliation === 'ambiguous' &&
    pending.step !== 'reconcile';
  const forceStopOverUnreadPremerge =
    pending !== null &&
    pending.reconciliation === 'unread' &&
    pending.step === 'premerge' &&
    gathered.facts.stopMode === 'force' &&
    !gathered.facts.halted;
  if (
    gathered.facts.stopMode === null ||
    pending === null ||
    (!ambiguousNonReconcile && !forceStopOverUnreadPremerge) ||
    decision.kind === 'done' ||
    (decision.kind === 'enter' && decision.to === 'merged')
  ) {
    return { kind: 'unchanged' };
  }
  const keyEntries = await ctx.deps.runJournal.listForKey(pending.key);
  if (!keyEntries.some((entry) => entry.kind === 'result' && !isNonFinalLaneRunOutcome(entry.outcome))) {
    const resultRefusal = await appendRunResult(ctx, request, pending.key, 'overtaken', LANE_RUN_INTENT_ABANDONED_REASON_CODE);
    if (resultRefusal !== null) {
      return { kind: 'refused', result: refusedResult(resultRefusal) };
    }
  }
  const refreshedEntries = await ctx.deps.runJournal.listForRun(request.runId);
  return { kind: 'resolved', gathered: refreshGatheredJournalFacts(ctx, record, refreshedEntries, gathered) };
}

/** Map a StopAttempt port result onto the domain's RunStopOutcome; a refusal re-reads the attempt for its kind. */
export async function runStopOutcomeOf(
  result: StopAttemptResult,
  latestId: string,
  attemptRepo: AttemptRepositoryPort,
): Promise<RunStopOutcome> {
  if (result.outcome === 'terminated' || result.outcome === 'cancelled') {
    return { outcome: result.outcome, capacityReleased: result.capacityReleased };
  }
  if (result.outcome === 'still-running' || result.outcome === 'unknown') {
    return { outcome: result.outcome };
  }
  const stored = await attemptRepo.findAttemptById(latestId);
  if (stored === null) {
    return { outcome: 'refused', refusal: 'attempt-missing' };
  }
  if (
    stored.state === 'cancelled' ||
    stored.state === 'collected' ||
    (stored.state === 'ended' && stored.completionReceipt !== null && stored.completionReceipt.authoritative === true)
  ) {
    return { outcome: 'refused', refusal: 'attempt-terminal' };
  }
  return { outcome: 'refused', refusal: 'other' };
}

/**
 * The `act stop` decision (K4-6): stop the latest running attempt through
 * `StopAttemptPort`. A timeout (no force) journals `stop-timeout` when the
 * stop terminated or cancelled, `stop-unconfirmed` when still-running or
 * unknown (the decider retries under `/retryN`), and parks `stop-refused`
 * on a refusal. A forced run maps the plan's §3.8 table: stopped releases or
 * holds the slot, still-running parks `stop-unconfirmed`, a refusal parks
 * `stop-refused` with the attempt's re-read kind, never its text.
 */
export async function performStop(ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: Extract<LaneRunDecision, { kind: 'act' }>,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  const stop = ctx.deps.stopAttempt;
  if (stop === undefined) {
    return { outcome: 'not-wired', step: decision.step };
  }
  const latest = gathered.latestAttempt;
  if (latest === null) {
    return { outcome: 'waiting', reason: 'facts-inconsistent' };
  }
  const intentRefusal = await appendRunIntent(ctx, request, decision.key, null);
  if (intentRefusal !== null) {
    return refusedResult(intentRefusal);
  }
  const result = await stop.stopAttempt({ attemptId: latest.id, nowIso: request.nowIso });
  const mapped = await runStopOutcomeOf(result, latest.id, ctx.deps.attemptRepo);
  const effect = laneRunStopEffect(mapped);
  if (gathered.facts.stopMode === 'force') {
    return finishForceStop(ctx, record, gathered, decision, effect, request);
  }
  if (mapped.outcome === 'terminated' || mapped.outcome === 'cancelled') {
    const resultRefusal = await appendRunResult(ctx, request, decision.key, 'completed', 'stop-timeout');
    if (resultRefusal !== null) {
      return refusedResult(resultRefusal);
    }
    // CB3: preserve the killed seat's uncommitted tracked edits as a patch
    // before handing the worktree on; silent, never alters this result.
    await preserveStoppedWorktree(ctx, record, latest, request.nowIso);
    return { outcome: 'acted', step: decision.step, key: decision.key, result: 'completed', reasonCode: 'stop-timeout' };
  }
  if (mapped.outcome === 'still-running' || mapped.outcome === 'unknown') {
    const resultRefusal = await appendRunResult(ctx, request, decision.key, 'completed', 'stop-unconfirmed');
    if (resultRefusal !== null) {
      return refusedResult(resultRefusal);
    }
    return { outcome: 'acted', step: decision.step, key: decision.key, result: 'completed', reasonCode: 'stop-unconfirmed' };
  }
  const resultRefusal = await appendRunResult(ctx, request, decision.key, 'refused', null);
  if (resultRefusal !== null) {
    return refusedResult(resultRefusal);
  }
  return performPark(ctx, record, 'stop-refused', effect.run === 'parked' ? effect.qualifier : null, gathered.facts.state, request);
}

/** The force branch of `act stop` (§3.8): stopped, stop-unconfirmed or stop-refused. */
export async function finishForceStop(ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: Extract<LaneRunDecision, { kind: 'act' }>,
  effect: RunStopEffect,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  if (effect.run === 'stopped') {
    const reasonCode = effect.capacity === 'held' ? 'stop-force-slot-held' : 'stop-force';
    const resultRefusal = await appendRunResult(ctx, request, decision.key, 'completed', reasonCode);
    if (resultRefusal !== null) {
      return refusedResult(resultRefusal);
    }
    // Before the terminal conduct entry: a crash between the two leaves a
    // non-terminal run the next pass re-ends (the release is idempotent).
    await releaseWorkOrderAtEnd(ctx, record, 'stopped', request);
    const appended = await appendConduct(ctx, request, 'stopped');
    if (!appended.ok) {
      return refusedResult(appended);
    }
    return { outcome: 'acted', step: decision.step, key: decision.key, result: 'completed', reasonCode };
  }
  if (effect.reason === 'stop-unconfirmed') {
    const resultRefusal = await appendRunResult(ctx, request, decision.key, 'completed', 'stop-unconfirmed');
    if (resultRefusal !== null) {
      return refusedResult(resultRefusal);
    }
    if (record.parked === null) {
      return performPark(ctx, record, 'stop-unconfirmed', null, gathered.facts.state, request);
    }
    return { outcome: 'acted', step: decision.step, key: decision.key, result: 'completed', reasonCode: 'stop-unconfirmed' };
  }
  const resultRefusal = await appendRunResult(ctx, request, decision.key, 'refused', null);
  if (resultRefusal !== null) {
    return refusedResult(resultRefusal);
  }
  return performPark(ctx, record, 'stop-refused', effect.qualifier, gathered.facts.state, request);
}

/**
 * The G4e `cancel` decision (K4-5): the record-only cancel of a prepared,
 * never-dispatched attempt, journalled under its stop step key.
 */
export async function performCancel(ctx: AdvanceStepContext,
  decision: Extract<LaneRunDecision, { kind: 'cancel' }>,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  const cancel = ctx.deps.cancelPreparedAttempt;
  if (cancel === undefined) {
    return { outcome: 'not-wired', step: 'stop' };
  }
  const intentRefusal = await appendRunIntent(ctx, request, decision.key, decision.attemptId);
  if (intentRefusal !== null) {
    return refusedResult(intentRefusal);
  }
  const cancelled = await cancel.cancelPreparedAttempt({
    attemptId: decision.attemptId,
    nowIso: request.nowIso,
  });
  let outcome: LaneRunJournalOutcome;
  let reasonCode: LaneRunResultReasonCode;
  if (cancelled.outcome === 'cancelled') {
    outcome = 'cancelled-unstarted';
    if (cancelled.capacity === 'released') {
      reasonCode = 'capacity-released';
    } else if (cancelled.capacity === 'none-held') {
      reasonCode = 'capacity-none-held';
    } else {
      reasonCode = 'capacity-held';
    }
  } else if (cancelled.reason === 'not-prepared') {
    outcome = 'refused';
    reasonCode = 'cancel-refused';
  } else if (cancelled.reason === 'changed') {
    outcome = 'refused';
    reasonCode = 'cancel-changed';
  } else {
    outcome = 'cancelled-unstarted';
    reasonCode = 'attempt-absent';
  }
  const resultRefusal = await appendRunResult(ctx, request, decision.key, outcome, reasonCode);
  if (resultRefusal !== null) {
    return refusedResult(resultRefusal);
  }
  return { outcome: 'acted', step: 'stop', key: decision.key, result: outcome, reasonCode };
}
