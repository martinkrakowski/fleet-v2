/**
 * AdvanceLaneRunUseCase: the conductor's advance, one driver step of plan
 * §3.1. It loads the run, checks the caller's run lease, repairs a park the
 * record and the journal disagree on (K4-4a step 3), reads the journal-derived
 * and attempt-record facts, asks the pure decider (`nextLaneRunAction`) and
 * performs the record-only decisions: `enter`, `park`, `wait` and `done`.
 *
 * This part stops there. The facts that need the runner, the frozen manifest,
 * reservations, costs or seat selection are stubbed fail-closed (K4-4b fills
 * `gatherFacts`), and every `act`, `reconcile` and `cancel` decision is
 * reported `not-built` (K4-5 to K4-7 build them) and writes nothing. The
 * admission port is declared for K7 to compose; K4-4a never calls it.
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
import type { AttemptRecord } from '../../domain/execution-records.js';
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
  laneRunGateFact,
  laneRunParkedConductCount,
  laneRunRefusedStep,
  laneRunStopsIssued,
} from '../../domain/lane-run-step-facts.js';
import { head12Of } from '../../domain/lane-run-keys.js';
import { isCalendarDateTime } from '../../domain/plain-record-reads.js';
import type { LaneRunParkReason, LaneRunRecord } from '../../domain/lane-run-records.js';
import type { LaneRunAttemptFact, LaneRunDecision, LaneRunFacts } from '../../domain/lane-run-decider.js';
import { laneRunAttemptPhaseOf, nextLaneRunAction } from '../../domain/lane-run-decider.js';
import { canEnterLaneRunState } from '../../domain/lane-run-transitions.js';
import { stopReasonOf } from '../../domain/seat-selection.js';
import type { LaneRunStateValue } from '../../domain/value-objects/LaneRunState.vo.js';

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
  return {
    attemptId: latest.id,
    round: placementOfRecord.round,
    seatIndex: placementOfRecord.seatIndex,
    phase: laneRunAttemptPhaseOf(latest.state),
    stopReason: stopReasonOf(latest),
    deadlineIso: null,
    stopsIssued: laneRunStopsIssued(entries, record.runId, placementOfRecord.round, placementOfRecord.seatIndex),
    dispatchResult: laneRunAttemptDispatchResult(entries, record.runId, latest.id),
    collection: await collectionFactOf(latest, artifactPort),
  };
}

type WriteOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: AdvanceLaneRunRefusal };

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

    const facts = await this.gatherFacts(record, entries, request, journalState);
    const decision = nextLaneRunAction(record, facts, request.nowIso);
    return this.performDecision(record, facts, decision, request);
  }

  private async performDecision(
    record: LaneRunRecord,
    facts: LaneRunFacts,
    decision: LaneRunDecision,
    request: AdvanceLaneRunRequest,
  ): Promise<AdvanceLaneRunResult> {
    if (decision.kind === 'done') {
      return { outcome: 'done' };
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
   * The facts the decider reads. K4-4a fills the journal-derived and
   * attempt-record fields; the runner, manifest, reservation, cost and seat
   * facts are stubbed fail-closed until K4-4b.
   */
  private async gatherFacts(
    record: LaneRunRecord,
    entries: readonly LaneRunJournalEntryRecord[],
    request: AdvanceLaneRunRequest,
    journalState: LaneRunStateValue,
  ): Promise<LaneRunFacts> {
    const attemptRecords = await Promise.all(
      record.attemptIds.map((attemptId) => this.deps.attemptRepo.findAttemptById(attemptId)),
    );
    const latestId = record.attemptIds.length > 0 ? record.attemptIds[record.attemptIds.length - 1] : null;
    const latest = latestId === null ? null : attemptRecords[attemptRecords.length - 1] ?? null;
    const attempt: LaneRunAttemptFact | null =
      latestId === null ? null : await attemptFactOf(record, entries, latestId, latest, this.deps.artifactPort);
    const stopFacts = laneRunJournalStopFacts(entries, record.runId);
    const head12 = latest === null ? null : head12Of(latest.artifacts?.headCommit);
    return {
      state: journalState,
      halted: request.halted,
      stopMode: stopFacts.stopMode,
      stopRequestedAtIso: stopFacts.stopRequestedAtIso,
      stopGraceMinutes: this.deps.stopGraceMinutes ?? 45,
      pendingIntent: laneRunJournalPendingIntent(entries, record.runId),
      admission: 'no-capacity',
      costCeilingReached: false,
      implementerSeat: { ok: false },
      reviewSeat: { ok: false },
      roundSeatIndexes: [],
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
  }
}
