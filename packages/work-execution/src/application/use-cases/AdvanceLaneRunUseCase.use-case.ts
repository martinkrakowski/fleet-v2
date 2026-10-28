/**
 * AdvanceLaneRunUseCase: the conductor's advance, one driver step of plan
 * §3.1. It loads the run, checks the caller's run lease, repairs a park the
 * record and the journal disagree on (K4-4a step 3), reads the journal-derived
 * and attempt-record facts, asks the pure decider (`nextLaneRunAction`) and
 * performs the record-only decisions: `enter`, `park`, `wait` and `done`.
 *
 * This part stops there. The facts that need the runner, the frozen manifest,
 * reservations, costs or seat selection are read in full (K4-4b), including
 * the lane's end from the runner through reconcile and the one `admit` call
 * on the decider's wait for admission, never while halted. Every `act`,
 * `reconcile` and `cancel` decision is still reported `not-built` (K4-5 to
 * K4-7 build them) and writes nothing.
 */

import type {
  AdvanceLaneRunPort,
  AdvanceLaneRunRefusal,
  AdvanceLaneRunRequest,
  AdvanceLaneRunResult,
} from '../ports/in/AdvanceLaneRunPort.in-port.js';
import type { LaneRunAdmissionPort } from '../ports/out/LaneRunAdmissionPort.out-port.js';
import type { LaneRunRepositoryPort } from '../ports/out/LaneRunRepositoryPort.out-port.js';
import type { LaneRunJournalPort } from '../ports/out/LaneRunJournalPort.out-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../ports/out/ExecutionJournalPort.out-port.js';
import type { AttemptArtifactPort } from '../ports/out/AttemptArtifactPort.out-port.js';
import type { ReconcileAttemptPort } from '../ports/in/ReconcileAttemptPort.in-port.js';
import { parseSeatTool, type AttemptRecord } from '../../domain/execution-records.js';
import type { ArtifactManifestVerdict } from '../../domain/artifact-manifest.js';
import { checkLeaseHeld } from '../../domain/lane-run-lease.js';
import type { LeaseRefusal } from '../../domain/lane-run-lease.js';
import type { LaneRunJournalEntryRecord } from '../../domain/lane-run-journal.js';
import {
  laneRunJournalPendingIntent,
  laneRunJournalState,
  laneRunJournalStopFacts,
} from '../../domain/lane-run-journal.js';
import {
  laneRunAttemptDispatchResult,
  laneRunAttemptPlacement,
  laneRunConductEntry,
  laneRunDispatchedAtIso,
  laneRunGateFact,
  laneRunParkedConductCount,
  laneRunRefusedStep,
  laneRunStopsIssued,
  laneRunTimedOut,
} from '../../domain/lane-run-step-facts.js';
import { head12Of } from '../../domain/lane-run-keys.js';
import { isCalendarDateTime } from '../../domain/plain-record-reads.js';
import type { LaneRunParkReason, LaneRunRecord } from '../../domain/lane-run-records.js';
import type {
  LaneRunAttemptFact,
  LaneRunDecision,
  LaneRunFacts,
  LaneRunSeatFact,
} from '../../domain/lane-run-decider.js';
import { laneRunAttemptPhaseOf, nextLaneRunAction } from '../../domain/lane-run-decider.js';
import { canEnterLaneRunState, implementerRoleFor } from '../../domain/lane-run-transitions.js';
import { historyEntryOf, selectSeat, stopReasonOf } from '../../domain/seat-selection.js';
import type { LaneRunStateValue } from '../../domain/value-objects/LaneRunState.vo.js';
import { SeatPlan } from '../../domain/value-objects/SeatPlan.vo.js';

export interface AdvanceLaneRunDependencies {
  readonly runRepo: LaneRunRepositoryPort;
  readonly runJournal: LaneRunJournalPort;
  readonly attemptRepo: AttemptRepositoryPort;
  readonly executionJournal: Pick<ExecutionJournalPort, 'listActiveReservations' | 'listJournalEntriesForAttempt'>;
  readonly artifactPort: Pick<AttemptArtifactPort, 'readBriefManifest' | 'verifyArtifactManifest'>;
  readonly reconcileAttempt: ReconcileAttemptPort;
  readonly admission: LaneRunAdmissionPort;
  /** A fresh ULID per call (journal entry ids, attempt ids). */
  readonly newUlid: () => string;
  /** policy.conductor.stopGraceMinutes (D12); default 45. */
  readonly stopGraceMinutes?: number;
  /** policy.perLaneCostCeiling; absent = no ceiling. */
  readonly perLaneCostCeiling?: number;
}

/** The request shape the pure readers take for granted; anything else is a usage error. */
function requestShapeError(request: AdvanceLaneRunRequest): AdvanceLaneRunRefusal | null {
  if (typeof request.runId !== 'string' || request.runId.trim().length === 0) {
    return 'invalid-request';
  }
  // The port is reached from the CLI and the driver; a missing lease is refused, never thrown on.
  const lease: unknown = request.lease;
  if (typeof lease !== 'object' || lease === null) {
    return 'invalid-request';
  }
  if (typeof request.lease.holderId !== 'string' || request.lease.holderId.trim().length === 0) {
    return 'invalid-request';
  }
  if (!Number.isSafeInteger(request.lease.fence) || request.lease.fence < 1) {
    return 'invalid-request';
  }
  if (typeof request.nowIso !== 'string' || !isCalendarDateTime(request.nowIso)) {
    return 'invalid-request';
  }
  return null;
}

/** `checkLeaseHeld`'s three outcomes mapped onto the advance refusals. */
function leaseRefusalOf(refusal: LeaseRefusal | null): AdvanceLaneRunRefusal | null {
  if (refusal === null) {
    return null;
  }
  if (refusal === 'lease-expired') {
    return 'lease-expired';
  }
  if (refusal === 'lease-not-held') {
    return 'lease-not-held';
  }
  return 'invalid-request';
}

/** The manifest verdict of a collected attempt: the port's outcome, `missing` when absent or unreadable. */
async function manifestVerdictOf(
  latest: AttemptRecord,
  artifactPort: AdvanceLaneRunDependencies['artifactPort'],
): Promise<Extract<ArtifactManifestVerdict, { readonly outcome: 'sealed' | 'missing' | 'mismatch' }>['outcome']> {
  const verify = artifactPort.verifyArtifactManifest;
  if (verify === undefined) {
    return 'missing';
  }
  try {
    const verdict = await verify({
      attemptId: latest.id,
      worktreePath: latest.worktreePath,
      recordedHost: latest.runner ?? null,
      manifestPath: latest.artifacts?.manifestPath,
      expectedManifestSha256: latest.artifacts?.manifestSha256,
    });
    return verdict.outcome;
  } catch {
    return 'missing';
  }
}

/** The collection fact of a collected attempt with artifacts; null before collection. */
async function collectionFactOf(
  latest: AttemptRecord,
  artifactPort: AdvanceLaneRunDependencies['artifactPort'],
): Promise<LaneRunAttemptFact['collection']> {
  if (latest.state !== 'collected' || latest.artifacts === null) {
    return null;
  }
  return {
    commits: latest.artifacts.commitsSinceBase.length,
    manifest: await manifestVerdictOf(latest, artifactPort),
  };
}

/** The decider's attempt fact of the run's latest attempt (a burned ordinal reads `cancelled`). */
async function attemptFactOf(
  record: LaneRunRecord,
  entries: readonly LaneRunJournalEntryRecord[],
  latestId: string,
  latest: AttemptRecord | null,
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
    collection: await collectionFactOf(latest, artifactPort),
  };
}

/** The frozen brief manifest as a plain object; null when absent or unreadable (K4-4b). */
async function readFrozenManifest(
  attempt: AttemptRecord,
  artifactPort: AdvanceLaneRunDependencies['artifactPort'],
): Promise<Record<string, unknown> | null> {
  const read = artifactPort.readBriefManifest;
  if (read === undefined || attempt.briefPackagePath === null) {
    return null;
  }
  try {
    const text = await read(
      attempt.worktreePath,
      attempt.briefPackagePath.replace(/\.md$/, '-manifest.json'),
      attempt.runner ?? null,
    );
    if (text === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Positive safe-integer `timeLimitSeconds` of a frozen manifest; null when absent or invalid. */
function manifestTimeLimitSeconds(manifest: Record<string, unknown> | null): number | null {
  if (manifest === null) {
    return null;
  }
  const seconds = manifest.timeLimitSeconds;
  if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds <= 0) {
    return null;
  }
  return seconds;
}

type WriteOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: AdvanceLaneRunRefusal };

/**
 * One advance's facts plus what its decision hooks need. Kept per call, never on
 * the instance: one use case serves overlapping advances of different runs.
 */
interface GatheredLaneRunFacts {
  readonly facts: LaneRunFacts;
  /** A running attempt's deadline could not be read (K4-4b): park `ambiguous stop`. */
  readonly deadlineUnknown: boolean;
  /** The latest attempt as gathered, for the admission hook. */
  readonly latestAttempt: AttemptRecord | null;
}

export class AdvanceLaneRunUseCase implements AdvanceLaneRunPort {
  constructor(private readonly deps: AdvanceLaneRunDependencies) {}

  async advanceLaneRun(request: AdvanceLaneRunRequest): Promise<AdvanceLaneRunResult> {
    const invalid = requestShapeError(request);
    if (invalid !== null) {
      return { outcome: 'refused', reason: invalid };
    }
    const record = await this.deps.runRepo.get(request.runId);
    if (record === null) {
      return { outcome: 'refused', reason: 'run-not-found' };
    }
    const leaseRefusal = leaseRefusalOf(
      checkLeaseHeld(record.lease, {
        holderId: request.lease.holderId,
        fence: request.lease.fence,
        nowIso: request.nowIso,
      }),
    );
    if (leaseRefusal !== null) {
      return { outcome: 'refused', reason: leaseRefusal };
    }

    const entries = await this.deps.runJournal.listForRun(request.runId);
    const journalState = laneRunJournalState(entries, request.runId);
    const parkedConducts = laneRunParkedConductCount(entries, request.runId);

    // Park repair (K4-4a step 3): one write, then return `repaired`.
    if (record.parked !== null && journalState !== 'parked') {
      if (parkedConducts === record.parkCount - 1) {
        const appended = await this.appendConduct(request, 'parked');
        if (!appended.ok) {
          return { outcome: 'refused', reason: appended.reason };
        }
        return { outcome: 'repaired', state: 'parked' };
      }
      if (parkedConducts === record.parkCount) {
        const saved = await this.saveOrRefuse(
          { ...record, parked: null, revision: record.revision + 1 },
          request,
        );
        if (!saved.ok) {
          return { outcome: 'refused', reason: saved.reason };
        }
        return { outcome: 'repaired', state: journalState };
      }
    } else if (record.parked === null && journalState === 'parked') {
      // Never written by this use case; the owner reconciles it.
      return { outcome: 'waiting', reason: 'facts-inconsistent' };
    }

    const gathered = await this.gatherFacts(record, entries, request, journalState);
    const decision = nextLaneRunAction(record, gathered.facts, request.nowIso);
    return this.performDecision(record, gathered, decision, request);
  }

  private async performDecision(
    record: LaneRunRecord,
    gathered: GatheredLaneRunFacts,
    decision: LaneRunDecision,
    request: AdvanceLaneRunRequest,
  ): Promise<AdvanceLaneRunResult> {
    const facts = gathered.facts;
    if (decision.kind === 'done') {
      return { outcome: 'done' };
    }
    if (decision.kind === 'wait' && decision.reason === 'admission') {
      return this.performAdmissionWait(record, facts, gathered.latestAttempt, request);
    }
    if (decision.kind === 'wait' && decision.reason === 'lane-running' && gathered.deadlineUnknown) {
      return this.performPark(record, 'ambiguous', 'stop', facts.state, request);
    }
    if (decision.kind === 'wait') {
      return { outcome: 'waiting', reason: decision.reason };
    }
    if (decision.kind === 'act') {
      return { outcome: 'not-built', decision: 'act', step: decision.step };
    }
    if (decision.kind === 'reconcile') {
      return { outcome: 'not-built', decision: 'reconcile', step: decision.step };
    }
    if (decision.kind === 'cancel') {
      return { outcome: 'not-built', decision: 'cancel', step: 'stop' };
    }
    if (decision.kind === 'enter') {
      return this.performEnter(record, facts.state, decision.to, request);
    }
    return this.performPark(record, decision.reason, decision.qualifier, decision.parkedFrom, request);
  }

  private async performEnter(
    record: LaneRunRecord,
    from: LaneRunStateValue,
    to: LaneRunStateValue,
    request: AdvanceLaneRunRequest,
  ): Promise<AdvanceLaneRunResult> {
    if (!canEnterLaneRunState(from, to, record.parked?.parkedFrom ?? null)) {
      return { outcome: 'refused', reason: 'illegal-transition' };
    }
    const appended = await this.appendConduct(request, to);
    if (!appended.ok) {
      return { outcome: 'refused', reason: appended.reason };
    }
    if (record.parked !== null) {
      const saved = await this.saveOrRefuse(
        { ...record, parked: null, revision: record.revision + 1 },
        request,
      );
      if (!saved.ok) {
        return { outcome: 'refused', reason: saved.reason };
      }
    }
    return { outcome: 'entered', state: to };
  }

  private async performPark(
    record: LaneRunRecord,
    reason: LaneRunParkReason,
    qualifier: string | null,
    parkedFrom: LaneRunStateValue,
    request: AdvanceLaneRunRequest,
  ): Promise<AdvanceLaneRunResult> {
    const saved = await this.saveOrRefuse(
      {
        ...record,
        parked: { reason, qualifier, parkedFrom, questionId: null },
        parkCount: record.parkCount + 1,
        revision: record.revision + 1,
      },
      request,
    );
    if (!saved.ok) {
      return { outcome: 'refused', reason: saved.reason };
    }
    const appended = await this.appendConduct(request, 'parked');
    if (!appended.ok) {
      return { outcome: 'refused', reason: appended.reason };
    }
    return { outcome: 'parked', reason, qualifier };
  }

  private async appendConduct(
    request: AdvanceLaneRunRequest,
    state: LaneRunStateValue,
  ): Promise<WriteOutcome> {
    const appended = await this.deps.runJournal.append(
      laneRunConductEntry(this.deps.newUlid(), request.runId, state, request.nowIso),
    );
    return appended.outcome === 'appended' ? { ok: true } : { ok: false, reason: 'journal-refused' };
  }

  private async saveOrRefuse(next: LaneRunRecord, request: AdvanceLaneRunRequest): Promise<WriteOutcome> {
    const saved = await this.deps.runRepo.save(next, {
      holderId: request.lease.holderId,
      fence: request.lease.fence,
      nowIso: request.nowIso,
    });
    return saved.outcome === 'saved' ? { ok: true } : { ok: false, reason: 'save-refused' };
  }

  /**
   * The facts the decider reads (K4-4b). Journal-derived and attempt-record
   * fields come from the pure readers; the lane's end is read from the runner
   * through reconcile when the latest attempt is running or reconciling with a
   * session, the deadline from the frozen time limit, admission from held
   * reservations, the cost ceiling from recorded usage, and the implementer
   * seat by selectSeat over the run's attempts with their timeouts.
   */
  private async gatherFacts(
    record: LaneRunRecord,
    entries: readonly LaneRunJournalEntryRecord[],
    request: AdvanceLaneRunRequest,
    journalState: LaneRunStateValue,
  ): Promise<GatheredLaneRunFacts> {
    let deadlineUnknown = false;

    const attemptRecords = await Promise.all(
      record.attemptIds.map((attemptId) => this.deps.attemptRepo.findAttemptById(attemptId)),
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
      const reconciled = await this.reconcileLatest(latest, request.nowIso);
      if (reconciled !== null) {
        latest = reconciled;
      }
    }

    const state = journalState;
    const phase = latest === null ? null : laneRunAttemptPhaseOf(latest.state);
    const manifest = latest === null ? null : await readFrozenManifest(latest, this.deps.artifactPort);

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
        : await attemptFactOf(record, entries, latestId, latest, this.deps.artifactPort, deadlineIso);

    const stopFacts = laneRunJournalStopFacts(entries, record.runId);
    const head12 = latest === null ? null : head12Of(latest.artifacts?.headCommit);

    const reservations = await this.deps.executionJournal.listActiveReservations();
    const admitted = latestId !== null && reservations.some((reservation) => reservation.attemptId === latestId);

    let costCeilingReached = false;
    const ceiling = this.deps.perLaneCostCeiling;
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

    const facts: LaneRunFacts = {
      state,
      halted: request.halted,
      stopMode: stopFacts.stopMode,
      stopRequestedAtIso: stopFacts.stopRequestedAtIso,
      stopGraceMinutes: this.deps.stopGraceMinutes ?? 45,
      pendingIntent: laneRunJournalPendingIntent(entries, record.runId),
      admission: admitted ? 'admitted' : 'no-capacity',
      costCeilingReached,
      implementerSeat: this.implementerSeatOf(record, state, entries, attemptRecords),
      reviewSeat: { ok: false },
      roundSeatIndexes,
      attempt,
      head12,
      acceptedHead12: null,
      gate: laneRunGateFact(entries, record.runId, head12),
      briefCheck: { verdict: 'none', seatIndex: null, retries: 0 },
      codeReview: { verdict: 'none', seatIndex: null, retries: 0 },
      preMerge: 'none',
      acceptance: 'none',
      ci: 'unknown',
      pr: null,
      refusedStep: laneRunRefusedStep(entries, record.runId, record.round),
      merge: { oneWayDoor: true, branchBehind: true, trainFree: false, policyGrant: false },
    };
    return { facts, deadlineUnknown, latestAttempt: latest };
  }

  /** Reconcile the latest running attempt; `refused` / `not-found` keep the record as read. */
  private async reconcileLatest(latest: AttemptRecord, nowIso: string): Promise<AttemptRecord | null> {
    const result = await this.deps.reconcileAttempt.reconcileAttempt({ attemptId: latest.id, nowIso });
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
  private implementerSeatOf(
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

  /** The `wait admission` hook: reserve once for a prepared attempt, never while halted. */
  private async performAdmissionWait(
    record: LaneRunRecord,
    facts: LaneRunFacts,
    latest: AttemptRecord | null,
    request: AdvanceLaneRunRequest,
  ): Promise<AdvanceLaneRunResult> {
    const attempt = facts.attempt;
    if (!request.halted && attempt !== null && attempt.phase === 'prepared' && latest !== null) {
      await this.deps.admission.admit({
        attemptId: attempt.attemptId,
        workOrderId: record.workOrderId,
        seatTool: parseSeatTool(latest.seatSelection?.tool) ?? 'opencode',
        worktreePath: latest.worktreePath,
        nowIso: request.nowIso,
      });
    }
    return { outcome: 'waiting', reason: 'admission' };
  }
}
