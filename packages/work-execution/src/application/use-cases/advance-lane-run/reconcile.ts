/** The `reconcile` decisions of AdvanceLaneRunUseCase (AL-2). */
import type { AdvanceLaneRunRequest, AdvanceLaneRunResult } from '../../ports/in/AdvanceLaneRunPort.in-port.js';
import { parseSeatTool, type AttemptRecord, type AttemptRunnerRecord } from '../../../domain/execution-records.js';
import type { LaneRunDecision } from '../../../domain/lane-run-decider.js';
import type { LaneRunJournalOutcome } from '../../../domain/lane-run-journal.js';
import { parseLaneRunKey } from '../../../domain/lane-run-keys.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { LaneRunResultReasonCode } from '../../../domain/lane-run-step-facts.js';
import type { AdvanceStepContext, GatheredLaneRunFacts } from './step-context.js';
import { appendConduct, appendRunIntent, appendRunResult, intentMintedIdOf, releaseWorkOrderAtEnd, saveOrRefuse } from './step-context.js';
import { conductDispatching } from './prepare-dispatch.js';
import { gatePreCheck, runCollectBody, runGateBody } from './collect-gate.js';
import { reconcileReview } from './review-fix.js';
import { reconcileAccept, reconcileMerge, reconcilePrPush } from './merge.js';
import { reconcilePremerge } from './premerge.js';

/**
 * The `reconcile` decisions (K4-7, §3.5): an intent without a result is
 * reconciled, never repeated. One private handler per step; the result
 * entry is appended under the pending key, and nothing here calls an
 * acting port of a one-way step. A key whose step is `reconcile` is the
 * G4j force reconcile; any other unhandled step stays `not-built`.
 */
export async function performReconcile(ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: Extract<LaneRunDecision, { kind: 'reconcile' }>,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  const parsed = parseLaneRunKey(decision.key);
  if (parsed !== null && parsed.kind === 'step' && parsed.step === 'reconcile') {
    return reconcileForceStop(ctx, gathered, decision, request);
  }
  if (decision.step === 'prepare') {
    return reconcilePrepare(ctx, record, decision, request);
  }
  if (decision.step === 'dispatch') {
    return reconcileDispatch(ctx, gathered, decision, request);
  }
  if (decision.step === 'accept') {
    return reconcileAccept(ctx, record, gathered, decision, request);
  }
  if (decision.step === 'open-pr' || decision.step === 'push') {
    return reconcilePrPush(ctx, record, gathered, decision, request);
  }
  if (decision.step === 'merge') {
    return reconcileMerge(ctx, record, gathered, decision, request);
  }
  if (decision.step === 'premerge') {
    return reconcilePremerge(ctx, record, gathered, decision, request);
  }
  if (decision.step === 'stop') {
    return reconcileStop(ctx, record, gathered, decision, request);
  }
  if (decision.step === 'collect') {
    return reconcileCollect(ctx, record, gathered, decision, request);
  }
  if (decision.step === 'gate') {
    return reconcileGate(ctx, record, gathered, decision, request);
  }
  if (decision.step === 'brief-check' || decision.step === 'code-review') {
    return reconcileReview(ctx, record, gathered, decision, request);
  }
  return { outcome: 'not-built', decision: 'reconcile', step: decision.step };
}

/**
 * The prepare reconcile (§3.5): the key's minted id is the attempt the
 * prepare act wrote before it saved the run record. When the attempt
 * exists the run record gains the id it may still lack (the crash lost the
 * save); when it does not, the ordinal is spent: the id is appended anyway
 * (a burned ordinal reads as a `cancelled` attempt fact) and the next
 * prepare mints a new attempt under a new key. The one-way key is never
 * re-sent.
 */
export async function reconcilePrepare(ctx: AdvanceStepContext,
  record: LaneRunRecord,
  decision: Extract<LaneRunDecision, { kind: 'reconcile' }>,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  const mintedId = await intentMintedIdOf(ctx, decision.key);
  if (mintedId === null) {
    const resultRefusal = await appendRunResult(ctx, request, decision.key, 'not-started', 'attempt-absent');
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    return { outcome: 'acted', step: decision.step, key: decision.key, result: 'not-started', reasonCode: 'attempt-absent' };
  }
  const attempt = await ctx.deps.attemptRepo.findAttemptById(mintedId);
  const outcome: LaneRunJournalOutcome = attempt !== null ? 'reconciled' : 'not-started';
  const reasonCode: LaneRunResultReasonCode = attempt !== null ? 'prepared' : 'attempt-absent';
  // The ordinal is spent on the run record BEFORE the result is journalled: once a result exists this
  // handler never runs again, so a crash between the two must leave the id on the run, never off it.
  if (!record.attemptIds.includes(mintedId)) {
    const saved = await saveOrRefuse(ctx,
      { ...record, attemptIds: [...record.attemptIds, mintedId], revision: record.revision + 1 },
      request,
    );
    if (!saved.ok) {
      return { outcome: 'refused', reason: saved.reason };
    }
  }
  const resultRefusal = await appendRunResult(ctx, request, decision.key, outcome, reasonCode);
  if (resultRefusal !== null) {
    return { outcome: 'refused', reason: resultRefusal };
  }
  return { outcome: 'acted', step: decision.step, key: decision.key, result: outcome, reasonCode };
}

/**
 * The dispatch reconcile (§3.5, §3.9.1): one-way, so it only reads and
 * records. The attempt record decides first — `DispatchAttempt` saves
 * `dispatching` before it calls the runner, so a record still
 * `intent-recorded` proves no start was requested for it — and only that
 * case inspects the worktree.
 */
export async function reconcileDispatch(ctx: AdvanceStepContext,
  gathered: GatheredLaneRunFacts,
  decision: Extract<LaneRunDecision, { kind: 'reconcile' }>,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  const mintedId = await intentMintedIdOf(ctx, decision.key);
  const attempt = mintedId === null ? null : await ctx.deps.attemptRepo.findAttemptById(mintedId);
  if (
    attempt !== null &&
    (attempt.state === 'running' || attempt.state === 'ended' || attempt.state === 'collected' || attempt.sessionId !== null)
  ) {
    return reconcileDispatchStarted(ctx, gathered, decision, request, 'dispatch-started');
  }
  if (
    attempt !== null &&
    attempt.state === 'cancelled' &&
    attempt.sessionId === null &&
    !(await dispatchEverJournalled(ctx, attempt.id))
  ) {
    // Re-entry after a crash between the idle-worktree cancel and its result. DispatchAttempt journals a
    // `dispatch` intent before it contacts any runner, so a cancelled attempt with no such entry never
    // reached a runner, whoever cancelled it; one with an entry did, and stays runner-refused below.
    return closeDispatchNotStarted(ctx, decision, request);
  }
  if (attempt !== null && attempt.state === 'cancelled') {
    const resultRefusal = await appendRunResult(ctx, request, decision.key, 'refused', 'runner-refused');
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    const conductRefusal = await conductDispatching(ctx, gathered.facts.state, request);
    if (conductRefusal !== null) {
      return { outcome: 'refused', reason: conductRefusal };
    }
    return { outcome: 'acted', step: decision.step, key: decision.key, result: 'refused', reasonCode: 'runner-refused' };
  }
  if (
    attempt !== null &&
    (attempt.state === 'dispatching' || attempt.state === 'reconciling' || attempt.state === 'blocked')
  ) {
    const result = await ctx.deps.reconcileAttempt.reconcileAttempt({ attemptId: attempt.id, nowIso: request.nowIso });
    if (result.outcome === 'active' || result.outcome === 'ended' || result.outcome === 'cancelled') {
      return reconcileDispatchStarted(ctx, gathered, decision, request, 'reconciled');
    }
    // unknown, refused, not-found: the next advance parks `ambiguous dispatch`.
    const resultRefusal = await appendRunResult(ctx, request, decision.key, 'ambiguous', 'dispatch-unknown');
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    return { outcome: 'acted', step: decision.step, key: decision.key, result: 'ambiguous', reasonCode: 'dispatch-unknown' };
  }
  // The record is still `intent-recorded`, or absent: the worktree decides.
  return reconcileDispatchByWorktree(ctx, gathered, decision, attempt, mintedId, request);
}

/** A dispatch reconcile that found the attempt started (or reconciled): record it and conduct `dispatching`. */
export async function reconcileDispatchStarted(ctx: AdvanceStepContext,
  gathered: GatheredLaneRunFacts,
  decision: Extract<LaneRunDecision, { kind: 'reconcile' }>,
  request: AdvanceLaneRunRequest,
  reasonCode: LaneRunResultReasonCode,
): Promise<AdvanceLaneRunResult> {
  const resultRefusal = await appendRunResult(ctx, request, decision.key, 'reconciled', reasonCode);
  if (resultRefusal !== null) {
    return { outcome: 'refused', reason: resultRefusal };
  }
  const conductRefusal = await conductDispatching(ctx, gathered.facts.state, request);
  if (conductRefusal !== null) {
    return { outcome: 'refused', reason: conductRefusal };
  }
  return { outcome: 'acted', step: decision.step, key: decision.key, result: 'reconciled', reasonCode };
}

/**
 * The worktree read of a dispatch reconcile: the attempt is still
 * `intent-recorded` or absent. The runner record to resolve with is the
 * attempt's own; an agy seat without one is resolved from the held
 * reservation's host (an agy worktree is never inspected through the
 * opencode runner), an opencode seat resolves the legacy runner. `idle`
 * proves the dispatch never started: the attempt is cancelled so its
 * one-way key can never be re-sent.
 */
export async function reconcileDispatchByWorktree(ctx: AdvanceStepContext,
  gathered: GatheredLaneRunFacts,
  decision: Extract<LaneRunDecision, { kind: 'reconcile' }>,
  attempt: AttemptRecord | null,
  mintedId: string | null,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  const ambiguous = async (reasonCode: LaneRunResultReasonCode): Promise<AdvanceLaneRunResult> => {
    const resultRefusal = await appendRunResult(ctx, request, decision.key, 'ambiguous', reasonCode);
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    return { outcome: 'acted', step: decision.step, key: decision.key, result: 'ambiguous', reasonCode };
  };
  const runnerForAttempt = ctx.deps.runnerForAttempt;
  if (runnerForAttempt === undefined) {
    return ambiguous('worktree-unknown');
  }
  let runnerRecord: AttemptRunnerRecord | null = attempt?.runner ?? null;
  if (runnerRecord === null && (parseSeatTool(attempt?.seatSelection?.tool) ?? 'opencode') === 'agy') {
    const reservations = await ctx.deps.executionJournal.listActiveReservations();
    const held = reservations.find((reservation) => reservation.attemptId === mintedId && reservation.held);
    if (held === undefined || held.hostName == null) {
      return ambiguous('worktree-unknown');
    }
    runnerRecord = {
      kind: 'agy',
      hostName: held.hostName,
      remotePort: null,
      host: null,
      agent: null,
      model: null,
      variant: null,
    };
  }
  const resolved = runnerForAttempt.runnerForAttempt({ runner: runnerRecord });
  if (!resolved.ok || resolved.runner.inspectWorktreeRun === undefined) {
    return ambiguous('worktree-unknown');
  }
  const attemptId = mintedId ?? (attempt !== null ? attempt.id : gathered.latestAttempt?.id ?? null);
  const worktreePath = attempt?.worktreePath ?? gathered.latestAttempt?.worktreePath ?? null;
  if (attemptId === null || worktreePath === null) {
    return ambiguous('worktree-unknown');
  }
  const worktree = await resolved.runner.inspectWorktreeRun({ attemptId, worktreePath, runner: runnerRecord });
  if (worktree.state === 'running') {
    const resultRefusal = await appendRunResult(ctx, request, decision.key, 'ambiguous', 'worktree-running');
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    return { outcome: 'acted', step: decision.step, key: decision.key, result: 'ambiguous', reasonCode: 'worktree-running' };
  }
  if (worktree.state !== 'idle') {
    return ambiguous('worktree-unknown');
  }
  // The untouched attempt is cancelled BEFORE the key is closed not-started, and only a confirmed
  // cancel closes it: a not-started result over an attempt still intent-recorded would let it dispatch.
  if (attempt !== null && attempt.state !== 'cancelled') {
    const cancel = ctx.deps.cancelPreparedAttempt;
    if (cancel === undefined) {
      return ambiguous('worktree-unknown');
    }
    const cancelled = await cancel.cancelPreparedAttempt({ attemptId, nowIso: request.nowIso });
    if (cancelled.outcome !== 'cancelled') {
      return ambiguous('worktree-unknown');
    }
  }
  return closeDispatchNotStarted(ctx, decision, request);
}

/** True when the execution journal holds a non-refused `dispatch` entry for the attempt (a runner may have been contacted). */
export async function dispatchEverJournalled(ctx: AdvanceStepContext, attemptId: string): Promise<boolean> {
  const entries = await ctx.deps.executionJournal.listJournalEntriesForAttempt(attemptId);
  return entries.some((entry) => entry.action === 'dispatch' && entry.status !== 'refused');
}

/** The dispatch key's `not-started` / `worktree-idle` result, once its untouched attempt is cancelled. */
export async function closeDispatchNotStarted(ctx: AdvanceStepContext,
  decision: Extract<LaneRunDecision, { kind: 'reconcile' }>,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  const resultRefusal = await appendRunResult(ctx, request, decision.key, 'not-started', 'worktree-idle');
  if (resultRefusal !== null) {
    return { outcome: 'refused', reason: resultRefusal };
  }
  return { outcome: 'acted', step: decision.step, key: decision.key, result: 'not-started', reasonCode: 'worktree-idle' };
}

/**
 * The stop reconcile (§3.5): the stop act's intent without a result is
 * settled from the attempt record alone — `StopAttempt` is never called
 * again here. A terminal attempt completes the stop, `stop-timeout` when
 * no force stop is recorded and `stop-force` (with the `stopped` conduct)
 * otherwise; a forced stop reads the active reservations so a still-held
 * slot reports `stop-force-slot-held`, never released. Anything else stays
 * `stop-unconfirmed`, which the decider retries under a retry key.
 */
export async function reconcileStop(ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: Extract<LaneRunDecision, { kind: 'reconcile' }>,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  // The G4e cancel journals under the stop key with its attempt id; a stop intent carries none.
  const cancelAttemptId = await intentMintedIdOf(ctx, decision.key);
  if (cancelAttemptId !== null) {
    return reconcileCancel(ctx, cancelAttemptId, decision, request);
  }
  const latest = gathered.latestAttempt;
  const stored = latest === null ? null : await ctx.deps.attemptRepo.findAttemptById(latest.id);
  const attempt = stored ?? latest;
  const terminal =
    attempt !== null &&
    (attempt.state === 'cancelled' ||
      attempt.state === 'collected' ||
      (attempt.state === 'ended' && attempt.completionReceipt !== null && attempt.completionReceipt.authoritative === true));
  if (!terminal) {
    const resultRefusal = await appendRunResult(ctx, request, decision.key, 'completed', 'stop-unconfirmed');
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    return { outcome: 'acted', step: decision.step, key: decision.key, result: 'completed', reasonCode: 'stop-unconfirmed' };
  }
  if (gathered.facts.stopMode === 'force') {
    // §3.8: a slot is never reported released unless the reservation confirmed it.
    const reservations = await ctx.deps.executionJournal.listActiveReservations();
    const held = attempt !== null && reservations.some((reservation) => reservation.attemptId === attempt.id && reservation.held);
    const reasonCode = held ? 'stop-force-slot-held' : 'stop-force';
    const resultRefusal = await appendRunResult(ctx, request, decision.key, 'completed', reasonCode);
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    // Before the terminal conduct entry: a crash between the two leaves a
    // non-terminal run the next pass re-ends (the release is idempotent).
    await releaseWorkOrderAtEnd(ctx, record, 'stopped', request);
    const appended = await appendConduct(ctx, request, 'stopped');
    if (!appended.ok) {
      return { outcome: 'refused', reason: appended.reason };
    }
    return { outcome: 'acted', step: decision.step, key: decision.key, result: 'completed', reasonCode };
  }
  const resultRefusal = await appendRunResult(ctx, request, decision.key, 'completed', 'stop-timeout');
  if (resultRefusal !== null) {
    return { outcome: 'refused', reason: resultRefusal };
  }
  return { outcome: 'acted', step: decision.step, key: decision.key, result: 'completed', reasonCode: 'stop-timeout' };
}

/**
 * A pending G4e cancel intent (§3.9.1): settled as a cancel, never with stop semantics, so a
 * never-dispatched attempt is never read as timed out. The cancel is record-only, so an attempt still
 * `intent-recorded` is cancelled now; an already cancelled one is reported with the capacity it holds.
 */
export async function reconcileCancel(ctx: AdvanceStepContext,
  attemptId: string,
  decision: Extract<LaneRunDecision, { kind: 'reconcile' }>,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  const attempt = await ctx.deps.attemptRepo.findAttemptById(attemptId);
  let outcome: LaneRunJournalOutcome;
  let reasonCode: LaneRunResultReasonCode;
  if (attempt === null) {
    outcome = 'cancelled-unstarted';
    reasonCode = 'attempt-absent';
  } else if (attempt.state === 'cancelled') {
    const reservations = await ctx.deps.executionJournal.listActiveReservations();
    const held = reservations.some((reservation) => reservation.attemptId === attemptId && reservation.held);
    outcome = 'cancelled-unstarted';
    reasonCode = held ? 'capacity-held' : 'capacity-none-held';
  } else if (attempt.state === 'intent-recorded') {
    const cancel = ctx.deps.cancelPreparedAttempt;
    if (cancel === undefined) {
      return { outcome: 'not-wired', step: decision.step };
    }
    const cancelled = await cancel.cancelPreparedAttempt({ attemptId, nowIso: request.nowIso });
    if (cancelled.outcome === 'cancelled') {
      outcome = 'cancelled-unstarted';
      reasonCode =
        cancelled.capacity === 'released'
          ? 'capacity-released'
          : cancelled.capacity === 'none-held'
            ? 'capacity-none-held'
            : 'capacity-held';
    } else {
      outcome = 'refused';
      reasonCode = cancelled.reason === 'changed' ? 'cancel-changed' : 'cancel-refused';
    }
  } else {
    outcome = 'refused';
    reasonCode = 'cancel-refused';
  }
  const resultRefusal = await appendRunResult(ctx, request, decision.key, outcome, reasonCode);
  if (resultRefusal !== null) {
    return { outcome: 'refused', reason: resultRefusal };
  }
  return { outcome: 'acted', step: decision.step, key: decision.key, result: outcome, reasonCode };
}

/**
 * The collect reconcile (§3.5): collect is not one-way, so its reconcile
 * completes it. An already collected attempt records `reconciled`; an
 * ended attempt runs the K4-6 collect body, both of whose steps are safe
 * to repeat.
 */
export async function reconcileCollect(ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: Extract<LaneRunDecision, { kind: 'reconcile' }>,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  const latest = gathered.latestAttempt;
  if (latest === null) {
    return { outcome: 'waiting', reason: 'facts-inconsistent' };
  }
  if (latest.state === 'collected') {
    const resultRefusal = await appendRunResult(ctx, request, decision.key, 'reconciled', 'collected');
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    return { outcome: 'acted', step: decision.step, key: decision.key, result: 'reconciled', reasonCode: 'collected' };
  }
  return runCollectBody(ctx, record, gathered, decision, request, decision.key);
}

/**
 * The gate reconcile (§3.5): gate is not one-way, so its reconcile
 * completes it — the K4-6 pre-checks and mapping run again, and the
 * evaluation returns the first's stored outcome.
 */
export async function reconcileGate(ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: Extract<LaneRunDecision, { kind: 'reconcile' }>,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  const preCheck = await gatePreCheck(ctx, record, gathered, decision, request);
  if (preCheck !== null) {
    return preCheck;
  }
  return runGateBody(ctx, record, gathered, decision, request, decision.key);
}

/**
 * The G4j force reconcile (§3.5, §3.9.1): a forced stop may not stop a
 * started prepared attempt before a fresh `…/reconcile/<seat>` key has
 * reconciled it, moving the record from `intent-recorded` to `reconciling`
 * (K4-1's pinned behaviour) so the next advance stops it by worktree
 * through G4d. The intent is appended first (mintedId = the attempt id);
 * an agy attempt with no runner record stays `ambiguous` — the forced stop
 * that follows would resolve a null runner record to the opencode runner —
 * so the park stands and the owner stops the lane.
 */
export async function reconcileForceStop(ctx: AdvanceStepContext,
  gathered: GatheredLaneRunFacts,
  decision: Extract<LaneRunDecision, { kind: 'reconcile' }>,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  const latest = gathered.latestAttempt;
  if (latest === null) {
    return { outcome: 'waiting', reason: 'facts-inconsistent' };
  }
  const entries = await ctx.deps.runJournal.listForKey(decision.key);
  if (!entries.some((entry) => entry.kind === 'intent')) {
    const intentRefusal = await appendRunIntent(ctx, request, decision.key, latest.id);
    if (intentRefusal !== null) {
      return { outcome: 'refused', reason: intentRefusal };
    }
  }
  if ((latest.runner ?? null) === null && (parseSeatTool(latest.seatSelection?.tool) ?? 'opencode') === 'agy') {
    const resultRefusal = await appendRunResult(ctx, request, decision.key, 'ambiguous', 'worktree-unknown');
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    return { outcome: 'acted', step: decision.step, key: decision.key, result: 'ambiguous', reasonCode: 'worktree-unknown' };
  }
  const result = await ctx.deps.reconcileAttempt.reconcileAttempt({ attemptId: latest.id, nowIso: request.nowIso });
  // Only a settled answer is `reconciled`; a refused or unknown reconcile settles nothing and stays ambiguous.
  let outcome: LaneRunJournalOutcome;
  let reasonCode: LaneRunResultReasonCode;
  if (result.outcome === 'not-found') {
    outcome = 'not-started';
    reasonCode = 'attempt-absent';
  } else if (result.outcome === 'refused' || result.outcome === 'unknown') {
    outcome = 'ambiguous';
    reasonCode = 'dispatch-unknown';
  } else {
    outcome = 'reconciled';
    reasonCode = 'reconciled';
  }
  const resultRefusal = await appendRunResult(ctx, request, decision.key, outcome, reasonCode);
  if (resultRefusal !== null) {
    return { outcome: 'refused', reason: resultRefusal };
  }
  return { outcome: 'acted', step: decision.step, key: decision.key, result: outcome, reasonCode };
}
