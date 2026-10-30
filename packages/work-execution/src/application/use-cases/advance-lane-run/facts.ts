/** The facts readers and admission hook of AdvanceLaneRunUseCase (AL-2). */
import type { AdvanceLaneRunDependencies } from '../AdvanceLaneRunUseCase.use-case.js';
import type { AdvanceLaneRunRequest, AdvanceLaneRunResult } from '../../ports/in/AdvanceLaneRunPort.in-port.js';
import { parseSeatTool, type AttemptRecord } from '../../../domain/execution-records.js';
import type { ArtifactManifestVerdict } from '../../../domain/artifact-manifest.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import {
  laneRunJournalPendingIntent,
  laneRunJournalStopFacts,
} from '../../../domain/lane-run-journal.js';
import {
  laneRunAttemptDispatchResult,
  laneRunAttemptPlacement,
  laneRunDispatchedAtIso,
  laneRunGateFact,
  laneRunRefusedStep,
  laneRunStopsIssued,
  laneRunTimedOut,
} from '../../../domain/lane-run-step-facts.js';
import { head12Of } from '../../../domain/lane-run-keys.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type {
  LaneRunAttemptFact,
  LaneRunFacts,
  LaneRunSeatFact,
} from '../../../domain/lane-run-decider.js';
import { laneRunAttemptPhaseOf } from '../../../domain/lane-run-decider.js';
import { implementerRoleFor } from '../../../domain/lane-run-transitions.js';
import { historyEntryOf, selectSeat, stopReasonOf } from '../../../domain/seat-selection.js';
import type { LaneRunStateValue } from '../../../domain/value-objects/LaneRunState.vo.js';
import { SeatPlan } from '../../../domain/value-objects/SeatPlan.vo.js';
import type { AdvanceStepContext, GatheredLaneRunFacts } from './step-context.js';
import { performPark } from './step-context.js';
import { manifestTimeLimitSeconds, readFrozenManifest } from './frozen-manifest.js';
import { conductedRunnerOf } from './conducted-host.js';
import { reviewFactsOf } from './review-fix.js';
import { acceptanceFactsOf } from './merge.js';

/** The manifest verdict of a collected attempt: the port's outcome, `missing` when absent or unreadable. */
export async function manifestVerdictOf(
  latest: AttemptRecord,
  artifactPort: AdvanceLaneRunDependencies['artifactPort'],
): Promise<Extract<ArtifactManifestVerdict, { readonly outcome: 'sealed' | 'missing' | 'mismatch' }>['outcome']> {
  // Called on the port, never copied off it: an adapter method reads `this` (KF-11).
  if (artifactPort.verifyArtifactManifest === undefined) {
    return 'missing';
  }
  // Q2a-2: a conducted attempt's read goes through its recorded host or is not
  // made; a missing host never falls back to the local executor.
  const recordedHost = conductedRunnerOf(latest);
  if (recordedHost === null) {
    return 'missing';
  }
  try {
    const verdict = await artifactPort.verifyArtifactManifest({
      attemptId: latest.id,
      worktreePath: latest.worktreePath,
      recordedHost,
      manifestPath: latest.artifacts?.manifestPath,
      expectedManifestSha256: latest.artifacts?.manifestSha256,
    });
    return verdict.outcome;
  } catch {
    return 'missing';
  }
}

/** The collection fact of a collected attempt with artifacts; null before collection. */
export async function collectionFactOf(
  latest: AttemptRecord,
  prior: AttemptRecord | null,
  artifactPort: AdvanceLaneRunDependencies['artifactPort'],
): Promise<LaneRunAttemptFact['collection']> {
  if (latest.state !== 'collected' || latest.artifacts === null) {
    return null;
  }
  return {
    commits: latest.artifacts.commitsSinceBase.length,
    manifest: await manifestVerdictOf(latest, artifactPort),
    // A fix attempt collected at its prior's head made no change: never park on a guess,
    // so a missing prior (null) reads false.
    headUnchanged:
      latest.kind === 'fix' &&
      prior !== null &&
      prior.artifacts !== null &&
      prior.artifacts.headCommit === latest.artifacts.headCommit,
  };
}

/** The decider's attempt fact of the run's latest attempt (a burned ordinal reads `cancelled`). */
export async function attemptFactOf(
  record: LaneRunRecord,
  entries: readonly LaneRunJournalEntryRecord[],
  latestId: string,
  latest: AttemptRecord | null,
  prior: AttemptRecord | null,
  artifactPort: AdvanceLaneRunDependencies['artifactPort'],
  deadlineIso: string | null,
): Promise<LaneRunAttemptFact> {
  const placement = laneRunAttemptPlacement(entries, record.runId, latestId);
  if (latest === null) {
    return {
      attemptId: latestId,
      round: placement?.round ?? record.round,
      seatIndex: placement?.seatIndex ?? 0,
      phase: 'cancelled',
      stopReason: 'none',
      deadlineIso: null,
      stopsIssued: 0,
      dispatchResult: 'none',
      collection: null,
    };
  }
  const placementOfRecord = placement ?? {
    round: 0,
    seatIndex: latest.seatSelection?.seatIndex ?? 0,
  };
  const timedOut = laneRunTimedOut(entries, record.runId, placementOfRecord.round, placementOfRecord.seatIndex);
  return {
    attemptId: latest.id,
    round: placementOfRecord.round,
    seatIndex: placementOfRecord.seatIndex,
    phase: laneRunAttemptPhaseOf(latest.state),
    stopReason: timedOut ? 'timeout' : stopReasonOf(latest),
    deadlineIso,
    stopsIssued: laneRunStopsIssued(entries, record.runId, placementOfRecord.round, placementOfRecord.seatIndex),
    dispatchResult: laneRunAttemptDispatchResult(entries, record.runId, latest.id),
    collection: await collectionFactOf(latest, prior, artifactPort),
  };
}

/**
 * The facts the decider reads (K4-4b). Journal-derived and attempt-record
 * fields come from the pure readers; the lane's end is read from the runner
 * through reconcile when the latest attempt is running or reconciling with a
 * session, the deadline from the frozen time limit, admission from held
 * reservations, the cost ceiling from recorded usage, and the implementer
 * seat by selectSeat over the run's attempts with their timeouts.
 */
export async function gatherFacts(ctx: AdvanceStepContext,
  record: LaneRunRecord,
  entries: readonly LaneRunJournalEntryRecord[],
  request: AdvanceLaneRunRequest,
  journalState: LaneRunStateValue,
): Promise<GatheredLaneRunFacts> {
  let deadlineUnknown = false;

  const attemptRecords = await Promise.all(
    record.attemptIds.map((attemptId) => ctx.deps.attemptRepo.findAttemptById(attemptId)),
  );
  const latestId = record.attemptIds.length > 0 ? record.attemptIds[record.attemptIds.length - 1] : null;
  let latest: AttemptRecord | null =
    latestId === null ? null : attemptRecords[attemptRecords.length - 1] ?? null;

  // Lane end from the runner: reconcile a running or reconciling attempt with a session.
  if (
    latest !== null &&
    (latest.state === 'running' || latest.state === 'reconciling') &&
    latest.sessionId !== null
  ) {
    const reconciled = await reconcileLatest(ctx, latest, request.nowIso);
    if (reconciled !== null) {
      latest = reconciled;
    }
  }

  const state = journalState;
  const phase = latest === null ? null : laneRunAttemptPhaseOf(latest.state);
  const manifest = latest === null ? null : await readFrozenManifest(latest, ctx.deps.artifactPort);

  let deadlineIso: string | null = null;
  if (phase === 'running' && latest !== null) {
    const dispatchedAt = laneRunDispatchedAtIso(entries, record.runId, latest.id);
    const timeLimitSeconds = manifestTimeLimitSeconds(manifest);
    if (dispatchedAt !== null && timeLimitSeconds !== null) {
      deadlineIso = new Date(Date.parse(dispatchedAt) + timeLimitSeconds * 1000).toISOString();
    } else {
      deadlineUnknown = true;
    }
  }

  const attempt: LaneRunAttemptFact | null =
    latestId === null
      ? null
      : await attemptFactOf(
          record,
          entries,
          latestId,
          latest,
          // The prior attempt by the latest attempt's own `priorAttemptId` (KF-21c):
          // read through the same repository path as every other attempt record;
          // a missing prior reads as no unchanged head (never park on a guess).
          latest !== null && latest.priorAttemptId !== null
            ? await ctx.deps.attemptRepo.findAttemptById(latest.priorAttemptId)
            : null,
          ctx.deps.artifactPort,
          deadlineIso,
        );

  const stopFacts = laneRunJournalStopFacts(entries, record.runId);
  const head12 = latest === null ? null : head12Of(latest.artifacts?.headCommit);
  const acceptance = await acceptanceFactsOf(ctx, record, state, entries, latest, head12, request.halted);

  const reservations = await ctx.deps.executionJournal.listActiveReservations();
  const admitted = latestId !== null && reservations.some((reservation) => reservation.attemptId === latestId);

  let costCeilingReached = false;
  const ceiling = ctx.deps.perLaneCostCeiling;
  if (ceiling !== undefined) {
    let totalCostUsd = 0;
    for (const attemptRecord of attemptRecords) {
      const costUsd = attemptRecord?.usage?.costUsd;
      if (typeof costUsd === 'number' && Number.isFinite(costUsd)) {
        totalCostUsd += costUsd;
      }
    }
    costCeilingReached = totalCostUsd >= ceiling;
  }

  const roundSeatIndexes: number[] = [];
  for (const attemptRecord of attemptRecords) {
    if (attemptRecord === null) {
      continue;
    }
    const placement = laneRunAttemptPlacement(entries, record.runId, attemptRecord.id);
    if (placement !== null && placement.round === record.round) {
      roundSeatIndexes.push(placement.seatIndex);
    }
  }

  const review = reviewFactsOf(ctx, record, state, entries, head12, attemptRecords);

  const facts: LaneRunFacts = {
    state,
    halted: request.halted,
    stopMode: stopFacts.stopMode,
    stopRequestedAtIso: stopFacts.stopRequestedAtIso,
    stopGraceMinutes: ctx.deps.stopGraceMinutes ?? 45,
    pendingIntent: laneRunJournalPendingIntent(entries, record.runId),
    admission: admitted ? 'admitted' : 'no-capacity',
    costCeilingReached,
    implementerSeat: implementerSeatOf(record, state, entries, attemptRecords),
    reviewSeat: review.reviewSeat,
    roundSeatIndexes,
    attempt,
    head12,
    acceptedHead12: acceptance.acceptedHead12,
    gate: laneRunGateFact(entries, record.runId, head12),
    briefCheck: review.briefCheck,
    codeReview: review.codeReview,
    preMerge: acceptance.preMerge,
    acceptance: acceptance.acceptance,
    acceptanceRetry: acceptance.acceptanceRetry,
    ci: acceptance.ci,
    pr: acceptance.pr,
    refusedStep: laneRunRefusedStep(entries, record.runId, record.round),
    merge: acceptance.merge,
  };
  return { facts, deadlineUnknown, latestAttempt: latest, attemptRecords };
}

/** Reconcile the latest running attempt; `refused` / `not-found` keep the record as read. */
export async function reconcileLatest(ctx: AdvanceStepContext, latest: AttemptRecord, nowIso: string): Promise<AttemptRecord | null> {
  const result = await ctx.deps.reconcileAttempt.reconcileAttempt({ attemptId: latest.id, nowIso });
  switch (result.outcome) {
    case 'active':
    case 'ended':
    case 'unknown':
    case 'cancelled':
      return result.attempt;
    default:
      return null;
  }
}

/** The implementer seat (K4): the run's first attempt's plan, selected over its history. */
export function implementerSeatOf(
  record: LaneRunRecord,
  state: LaneRunStateValue,
  entries: readonly LaneRunJournalEntryRecord[],
  attemptRecords: readonly (AttemptRecord | null)[],
): LaneRunSeatFact {
  const first = attemptRecords[0] ?? null;
  if (first === null || first.seatPlan === null || first.seatPlan === undefined) {
    return { ok: false };
  }
  const planResult = SeatPlan.create(first.seatPlan);
  if (!planResult.success || planResult.value === undefined) {
    return { ok: false };
  }
  const history = attemptRecords
    .filter((attempt): attempt is AttemptRecord => attempt !== null)
    .sort((left, right) => left.createdAtIso.localeCompare(right.createdAtIso))
    .map((attempt) => {
      const entry = historyEntryOf(attempt);
      const placement = laneRunAttemptPlacement(entries, record.runId, attempt.id);
      if (placement !== null && laneRunTimedOut(entries, record.runId, placement.round, placement.seatIndex)) {
        return { ...entry, stopReason: 'timeout' as const };
      }
      return entry;
    });
  const selected = selectSeat({
    plan: planResult.value,
    role: implementerRoleFor(record.round, state),
    history,
  });
  if (selected.ok) {
    return { ok: true, seatIndex: selected.seatIndex };
  }
  return { ok: false };
}

/**
 * The `wait admission` hook: reserve once for a prepared attempt, never
 * while halted. A refused admit parks `step-refused dispatch` (the dispatch
 * refusal's park) so the owner sees it; admitted and no-capacity wait.
 */
export async function performAdmissionWait(ctx: AdvanceStepContext,
  record: LaneRunRecord,
  facts: LaneRunFacts,
  latest: AttemptRecord | null,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  const attempt = facts.attempt;
  if (!request.halted && attempt !== null && attempt.phase === 'prepared' && latest !== null) {
    const admission = await ctx.deps.admission.admit({
      attemptId: attempt.attemptId,
      workOrderId: record.workOrderId,
      seatTool: parseSeatTool(latest.seatSelection?.tool) ?? 'opencode',
      worktreePath: latest.worktreePath,
      nowIso: request.nowIso,
    });
    if (admission.outcome === 'refused') {
      return performPark(ctx, record, 'step-refused', 'dispatch', facts.state, request);
    }
  }
  return { outcome: 'waiting', reason: 'admission' };
}
