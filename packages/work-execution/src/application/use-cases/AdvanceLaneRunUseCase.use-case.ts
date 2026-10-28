/**
 * AdvanceLaneRunUseCase: the conductor's advance, one driver step of plan
 * §3.1. It loads the run, checks the caller's run lease, repairs a park the
 * record and the journal disagree on (K4-4a step 3), reads the journal-derived
 * and attempt-record facts, asks the pure decider (`nextLaneRunAction`) and
 * performs the record-only decisions: `enter`, `park`, `wait` and `done`.
 *
 * The facts that need the runner, the frozen manifest, reservations, costs or
 * seat selection are read in full (K4-4b), including the lane's end from the
 * runner through reconcile and the one `admit` call on the decider's wait for
 * admission, never while halted. Three acts are performed here (K4-5): `act
 * prepare` (a fresh round-0 attempt on the selected first-pass seat, the seat
 * pivot), `act dispatch` (through `DispatchAttemptPort`, with the pivot's
 * conductor seat override) and the G4e `cancel` (through
 * `CancelPreparedAttemptPort`). Each writes its keyed intent first, performs
 * the one action, saves the record it needs, then appends the result entry;
 * both acting steps re-check the cost ceiling before writing anything. The
 * acts `stop`, `collect` and `gate` are performed here too (K4-6): stop
 * handles a timeout and a forced run stop through `StopAttemptPort` mapped by
 * the plan's §3.8 table, collect runs the edit-only commit step first for an
 * agy attempt then collects through `CollectAttemptArtifactsPort`, and gate
 * reads the typed verdict from `EvaluateAttemptGatePort`. The `reconcile`
 * decisions are performed here too (K4-7, §3.5): an intent without a result
 * is reconciled, never repeated. Prepare and dispatch are one-way, so their
 * reconcile only reads and records — a dispatch reads the attempt record,
 * then the runner by worktree, and an idle worktree under an untouched
 * record is `not-started` with the attempt cancelled so its key is never
 * re-sent; a stop reads the record; collect and gate, which are not
 * one-way, are completed. The G4j force reconcile (a fresh
 * `…/reconcile/<seat>` key) moves a prepared attempt to reconciling so it
 * can be stopped; any other step stays `not-built` and writes nothing.
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
import type { DispatchAttemptPort } from '../ports/in/DispatchAttemptPort.in-port.js';
import type { CancelPreparedAttemptPort } from '../ports/in/CancelPreparedAttemptPort.in-port.js';
import type { StopAttemptPort, StopAttemptResult } from '../ports/in/StopAttemptPort.in-port.js';
import type { CollectAttemptArtifactsPort } from '../ports/in/CollectAttemptArtifactsPort.in-port.js';
import type { CommitEditOnlyAttemptPort } from '../ports/in/CommitEditOnlyAttemptPort.in-port.js';
import type { EvaluateAttemptGatePort } from '../ports/in/EvaluateAttemptGatePort.in-port.js';
import type { RunnerForAttemptPort } from '../ports/out/RunnerForAttemptPort.out-port.js';
import { AttemptRevisionConflictError } from '../ports/out/AttemptRepositoryPort.out-port.js';
import {
  parseSeatTool,
  type AttemptRecord,
  type AttemptRunnerRecord,
  type AttemptSeatOverrideRecord,
} from '../../domain/execution-records.js';
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
  laneRunIntentEntry,
  laneRunParkedConductCount,
  laneRunRefusedStep,
  laneRunResultEntry,
  laneRunStopsIssued,
  laneRunTimedOut,
  type LaneRunResultReasonCode,
} from '../../domain/lane-run-step-facts.js';
import type { LaneRunJournalOutcome } from '../../domain/lane-run-journal.js';
import { head12Of, parseLaneRunKey } from '../../domain/lane-run-keys.js';
import { isCalendarDateTime } from '../../domain/plain-record-reads.js';
import type {
  LaneRunCursorsRecord,
  LaneRunParkReason,
  LaneRunRecord,
} from '../../domain/lane-run-records.js';
import type {
  LaneRunAttemptFact,
  LaneRunDecision,
  LaneRunFacts,
  LaneRunSeatFact,
} from '../../domain/lane-run-decider.js';
import { laneRunAttemptPhaseOf, nextLaneRunAction } from '../../domain/lane-run-decider.js';
import { canEnterLaneRunState, implementerRoleFor, laneRunStopEffect } from '../../domain/lane-run-transitions.js';
import type { RunStopEffect, RunStopOutcome } from '../../domain/lane-run-transitions.js';
import { historyEntryOf, selectSeat, seatSelectionRecord, stopReasonOf } from '../../domain/seat-selection.js';
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
  /** Dispatch a prepared attempt (K4-5); absent → `not-wired dispatch`. */
  readonly dispatchAttempt?: DispatchAttemptPort;
  /** The record-only cancel of a never-dispatched attempt (K4-1, K4-5); absent → `not-wired stop`. */
  readonly cancelPreparedAttempt?: CancelPreparedAttemptPort;
  /** Stop a running attempt (K4-6); absent → `not-wired stop`. */
  readonly stopAttempt?: StopAttemptPort;
  /** Collect an ended attempt's artifacts (K4-6); absent → `not-wired collect`. */
  readonly collectAttemptArtifacts?: CollectAttemptArtifactsPort;
  /** The edit-only commit step (AG-4), run first at collect for an agy attempt (K4-6); absent → `not-wired collect` only for agy. */
  readonly commitEditOnlyAttempt?: CommitEditOnlyAttemptPort;
  /** The frozen gate verdict (K4-2, K4-6); absent → `not-wired gate`. */
  readonly evaluateAttemptGate?: EvaluateAttemptGatePort;
  /**
   * Resolve the runner that addresses a host for the dispatch reconcile's
   * worktree read (K4-7); absent → a dispatch reconcile that needs the
   * worktree read records `ambiguous` / `worktree-unknown`.
   */
  readonly runnerForAttempt?: RunnerForAttemptPort;
  /** The installation schema version the dispatching root runs under (H9a2). */
  readonly installationSchemaVersion?: number;
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

/** A positive safe-integer field of a frozen manifest; null when absent or invalid. */
function manifestPositiveInteger(manifest: Record<string, unknown> | null, field: string): number | null {
  if (manifest === null) {
    return null;
  }
  const value = manifest[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

/** Positive safe-integer `timeLimitSeconds` of a frozen manifest; null when absent or invalid. */
function manifestTimeLimitSeconds(manifest: Record<string, unknown> | null): number | null {
  return manifestPositiveInteger(manifest, 'timeLimitSeconds');
}

/** `expectedArtifacts` of a frozen manifest: the field absent reads `[]`; present but not a string array is unreadable (null). */
function manifestExpectedArtifacts(manifest: Record<string, unknown> | null): readonly string[] | null {
  if (manifest === null || !Object.prototype.hasOwnProperty.call(manifest, 'expectedArtifacts')) {
    return [];
  }
  const value = manifest.expectedArtifacts;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    return null;
  }
  return value as readonly string[];
}

/** Map a StopAttempt port result onto the domain's RunStopOutcome; a refusal re-reads the attempt for its kind. */
async function runStopOutcomeOf(
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

type WriteOutcome =
  | { readonly ok: true; readonly record?: LaneRunRecord }
  | { readonly ok: false; readonly reason: AdvanceLaneRunRefusal };

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
  /** The run's attempt records in `attemptIds` order (null where a record is missing), for the prepare act. */
  readonly attemptRecords: readonly (AttemptRecord | null)[];
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
      if (decision.step === 'prepare') {
        return this.performPrepare(record, gathered, decision, request);
      }
      if (decision.step === 'dispatch') {
        return this.performDispatch(record, gathered, decision, request);
      }
      if (decision.step === 'stop') {
        return this.performStop(record, gathered, decision, request);
      }
      if (decision.step === 'collect') {
        return this.performCollect(record, gathered, decision, request);
      }
      if (decision.step === 'gate') {
        return this.performGate(record, gathered, decision, request);
      }
      return { outcome: 'not-built', decision: 'act', step: decision.step };
    }
    if (decision.kind === 'reconcile') {
      return this.performReconcile(record, gathered, decision, request);
    }
    if (decision.kind === 'cancel') {
      return this.performCancel(decision, request);
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

  /** The acts' own cost-ceiling re-check (§3.6): park before anything is written. */
  private async ceilingPark(
    record: LaneRunRecord,
    gathered: GatheredLaneRunFacts,
    request: AdvanceLaneRunRequest,
  ): Promise<AdvanceLaneRunResult | null> {
    if (!gathered.facts.costCeilingReached) {
      return null;
    }
    return this.performPark(record, 'cost-ceiling', null, gathered.facts.state, request);
  }

  private async appendRunIntent(
    request: AdvanceLaneRunRequest,
    key: string,
    mintedId: string | null,
  ): Promise<AdvanceLaneRunRefusal | null> {
    const appended = await this.deps.runJournal.append(
      laneRunIntentEntry(this.deps.newUlid(), request.runId, key, mintedId, request.nowIso),
    );
    return appended.outcome === 'appended' ? null : 'journal-refused';
  }

  private async appendRunResult(
    request: AdvanceLaneRunRequest,
    key: string,
    outcome: LaneRunJournalOutcome,
    reasonCode: LaneRunResultReasonCode | null,
  ): Promise<AdvanceLaneRunRefusal | null> {
    const appended = await this.deps.runJournal.append(
      laneRunResultEntry(this.deps.newUlid(), request.runId, key, outcome, reasonCode, request.nowIso),
    );
    return appended.outcome === 'appended' ? null : 'journal-refused';
  }

  /**
   * The `act prepare` decision (K4-5): a fresh round-0 attempt on the selected
   * first-pass seat, copying the frozen-brief fields from the run's latest
   * attempt (the seat pivot). Order: intent, attempt record, run record,
   * result — so a result never exists for an attempt the run record does not
   * list. A fix-round prepare stays with K5 and is refused under its key.
   */
  private async performPrepare(
    record: LaneRunRecord,
    gathered: GatheredLaneRunFacts,
    decision: Extract<LaneRunDecision, { kind: 'act' }>,
    request: AdvanceLaneRunRequest,
  ): Promise<AdvanceLaneRunResult> {
    const ceiling = await this.ceilingPark(record, gathered, request);
    if (ceiling !== null) {
      return ceiling;
    }
    const nowIso = request.nowIso;
    const refuse = async (reasonCode: LaneRunResultReasonCode): Promise<AdvanceLaneRunResult> => {
      const intentRefusal = await this.appendRunIntent(request, decision.key, null);
      if (intentRefusal !== null) {
        return { outcome: 'refused', reason: intentRefusal };
      }
      const resultRefusal = await this.appendRunResult(request, decision.key, 'refused', reasonCode);
      if (resultRefusal !== null) {
        return { outcome: 'refused', reason: resultRefusal };
      }
      return { outcome: 'acted', step: decision.step, key: decision.key, result: 'refused', reasonCode };
    };

    if (decision.round !== 0) {
      return refuse('prepare-fix-round-not-built');
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
    const attemptId = 'attempt-' + this.deps.newUlid();
    const intentRefusal = await this.appendRunIntent(request, decision.key, attemptId);
    if (intentRefusal !== null) {
      return { outcome: 'refused', reason: intentRefusal };
    }
    const attempt: AttemptRecord = {
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
      await this.deps.attemptRepo.saveAttempt(attempt);
    } catch (error) {
      if (error instanceof AttemptRevisionConflictError) {
        const resultRefusal = await this.appendRunResult(request, decision.key, 'refused', 'attempt-exists');
        if (resultRefusal !== null) {
          return { outcome: 'refused', reason: resultRefusal };
        }
        return { outcome: 'acted', step: decision.step, key: decision.key, result: 'refused', reasonCode: 'attempt-exists' };
      }
      throw error;
    }
    try {
      const saved = await this.saveOrRefuse(
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
    const resultRefusal = await this.appendRunResult(request, decision.key, 'completed', 'prepared');
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    return { outcome: 'acted', step: decision.step, key: decision.key, result: 'completed', reasonCode: 'prepared' };
  }

  /**
   * The `act dispatch` decision (K4-5): start the prepared attempt through
   * `DispatchAttemptPort` with the frozen brief's limits, raising the round and
   * the seat cursor on the record before the call (§3.2, D8). The dispatch key
   * is one-way: when a reconcile already recorded the dispatch as never
   * started but its cancel did not land, the attempt is cancelled instead of
   * re-sending the key. A pivot dispatches with a conductor seat override.
   */
  private async performDispatch(
    record: LaneRunRecord,
    gathered: GatheredLaneRunFacts,
    decision: Extract<LaneRunDecision, { kind: 'act' }>,
    request: AdvanceLaneRunRequest,
  ): Promise<AdvanceLaneRunResult> {
    const facts = gathered.facts;
    const ceiling = await this.ceilingPark(record, gathered, request);
    if (ceiling !== null) {
      return ceiling;
    }
    const dispatch = this.deps.dispatchAttempt;
    if (dispatch === undefined) {
      return { outcome: 'not-wired', step: decision.step };
    }
    const nowIso = request.nowIso;
    const latest = gathered.latestAttempt;
    if (latest === null || latest.state !== 'intent-recorded') {
      return { outcome: 'waiting', reason: 'facts-inconsistent' };
    }
    if (facts.attempt !== null && facts.attempt.dispatchResult === 'not-started') {
      const cancel = this.deps.cancelPreparedAttempt;
      if (cancel === undefined) {
        return { outcome: 'not-wired', step: decision.step };
      }
      await cancel.cancelPreparedAttempt({ attemptId: latest.id, nowIso });
      return { outcome: 'waiting', reason: 'dispatch-pending' };
    }
    const manifest = await readFrozenManifest(latest, this.deps.artifactPort);
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
    const intentRefusal = await this.appendRunIntent(request, decision.key, latest.id);
    if (intentRefusal !== null) {
      return { outcome: 'refused', reason: intentRefusal };
    }
    if (!inputsReadable) {
      const resultRefusal = await this.appendRunResult(request, decision.key, 'refused', 'dispatch-inputs-unreadable');
      if (resultRefusal !== null) {
        return { outcome: 'refused', reason: resultRefusal };
      }
      return this.performPark(record, 'step-refused', 'dispatch', facts.state, request);
    }
    const role = implementerRoleFor(decision.round, facts.state);
    const roundRaised = decision.round > record.round;
    if (roundRaised || record.cursors[role] !== decision.seatIndex) {
      const cursors: LaneRunCursorsRecord =
        role === 'first-pass'
          ? { ...record.cursors, 'first-pass': decision.seatIndex }
          : { ...record.cursors, fix: decision.seatIndex };
      const saved = await this.saveOrRefuse(
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
    const pivot =
      latest.kind === 'initial' && latest.priorAttemptId !== null && latest.seatSelection != null
        ? latest.seatSelection
        : null;
    const seatOverride: AttemptSeatOverrideRecord | null =
      pivot === null
        ? null
        : {
            model: pivot.model,
            ...(pivot.agent !== null ? { agent: pivot.agent } : {}),
            ...(pivot.variant !== null ? { variant: pivot.variant } : {}),
            reason: 'seat-plan pivot to ' + pivot.seatId,
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
      ...(this.deps.installationSchemaVersion !== undefined
        ? { installationSchemaVersion: this.deps.installationSchemaVersion }
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
      const resultRefusal = await this.appendRunResult(request, decision.key, 'completed', reasonCode);
      if (resultRefusal !== null) {
        return { outcome: 'refused', reason: resultRefusal };
      }
      const conductRefusal = await this.conductDispatching(facts.state, request);
      if (conductRefusal !== null) {
        return { outcome: 'refused', reason: conductRefusal };
      }
      return { outcome: 'acted', step: decision.step, key: decision.key, result: 'completed', reasonCode };
    }
    // Refused: a runner refusal saved with its stop reason (S1) pivots through
    // seat-failed; anything else parks for the owner (the key is spent).
    const stored = await this.deps.attemptRepo.findAttemptById(latest.id);
    let reasonCode: LaneRunResultReasonCode;
    if (stored !== null && stored.state === 'cancelled') {
      reasonCode = 'runner-refused';
    } else {
      reasonCode = 'dispatch-refused';
    }
    const resultRefusal = await this.appendRunResult(request, decision.key, 'refused', reasonCode);
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    if (reasonCode === 'runner-refused') {
      const conductRefusal = await this.conductDispatching(facts.state, request);
      if (conductRefusal !== null) {
        return { outcome: 'refused', reason: conductRefusal };
      }
      return { outcome: 'acted', step: decision.step, key: decision.key, result: 'refused', reasonCode };
    }
    return this.performPark(record, 'step-refused', 'dispatch', facts.state, request);
  }

  /** The `dispatching` conduct entry after a dispatch, unless the run is already in it. */
  private async conductDispatching(
    state: LaneRunStateValue,
    request: AdvanceLaneRunRequest,
  ): Promise<AdvanceLaneRunRefusal | null> {
    if (state === 'dispatching') {
      return null;
    }
    const appended = await this.appendConduct(request, 'dispatching');
    return appended.ok ? null : appended.reason;
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
  private async performStop(
    record: LaneRunRecord,
    gathered: GatheredLaneRunFacts,
    decision: Extract<LaneRunDecision, { kind: 'act' }>,
    request: AdvanceLaneRunRequest,
  ): Promise<AdvanceLaneRunResult> {
    const stop = this.deps.stopAttempt;
    if (stop === undefined) {
      return { outcome: 'not-wired', step: decision.step };
    }
    const latest = gathered.latestAttempt;
    if (latest === null) {
      return { outcome: 'waiting', reason: 'facts-inconsistent' };
    }
    const intentRefusal = await this.appendRunIntent(request, decision.key, null);
    if (intentRefusal !== null) {
      return { outcome: 'refused', reason: intentRefusal };
    }
    const result = await stop.stopAttempt({ attemptId: latest.id, nowIso: request.nowIso });
    const mapped = await runStopOutcomeOf(result, latest.id, this.deps.attemptRepo);
    const effect = laneRunStopEffect(mapped);
    if (gathered.facts.stopMode === 'force') {
      return this.finishForceStop(record, gathered, decision, effect, request);
    }
    if (mapped.outcome === 'terminated' || mapped.outcome === 'cancelled') {
      const resultRefusal = await this.appendRunResult(request, decision.key, 'completed', 'stop-timeout');
      if (resultRefusal !== null) {
        return { outcome: 'refused', reason: resultRefusal };
      }
      return { outcome: 'acted', step: decision.step, key: decision.key, result: 'completed', reasonCode: 'stop-timeout' };
    }
    if (mapped.outcome === 'still-running' || mapped.outcome === 'unknown') {
      const resultRefusal = await this.appendRunResult(request, decision.key, 'completed', 'stop-unconfirmed');
      if (resultRefusal !== null) {
        return { outcome: 'refused', reason: resultRefusal };
      }
      return { outcome: 'acted', step: decision.step, key: decision.key, result: 'completed', reasonCode: 'stop-unconfirmed' };
    }
    const resultRefusal = await this.appendRunResult(request, decision.key, 'refused', null);
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    return this.performPark(record, 'stop-refused', effect.run === 'parked' ? effect.qualifier : null, gathered.facts.state, request);
  }

  /** The force branch of `act stop` (§3.8): stopped, stop-unconfirmed or stop-refused. */
  private async finishForceStop(
    record: LaneRunRecord,
    gathered: GatheredLaneRunFacts,
    decision: Extract<LaneRunDecision, { kind: 'act' }>,
    effect: RunStopEffect,
    request: AdvanceLaneRunRequest,
  ): Promise<AdvanceLaneRunResult> {
    if (effect.run === 'stopped') {
      const reasonCode = effect.capacity === 'held' ? 'stop-force-slot-held' : 'stop-force';
      const resultRefusal = await this.appendRunResult(request, decision.key, 'completed', reasonCode);
      if (resultRefusal !== null) {
        return { outcome: 'refused', reason: resultRefusal };
      }
      const appended = await this.appendConduct(request, 'stopped');
      if (!appended.ok) {
        return { outcome: 'refused', reason: appended.reason };
      }
      return { outcome: 'acted', step: decision.step, key: decision.key, result: 'completed', reasonCode };
    }
    if (effect.reason === 'stop-unconfirmed') {
      const resultRefusal = await this.appendRunResult(request, decision.key, 'completed', 'stop-unconfirmed');
      if (resultRefusal !== null) {
        return { outcome: 'refused', reason: resultRefusal };
      }
      if (record.parked === null) {
        return this.performPark(record, 'stop-unconfirmed', null, gathered.facts.state, request);
      }
      return { outcome: 'acted', step: decision.step, key: decision.key, result: 'completed', reasonCode: 'stop-unconfirmed' };
    }
    const resultRefusal = await this.appendRunResult(request, decision.key, 'refused', null);
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    return this.performPark(record, 'stop-refused', effect.qualifier, gathered.facts.state, request);
  }

  /**
   * The `act collect` decision (K4-6): collect an ended attempt's artifacts
   * through `CollectAttemptArtifactsPort`, running the edit-only commit step
   * (`CommitEditOnlyAttemptPort`) first when the attempt ran under agy. A
   * commit refusal parks for the owner on the next advance, unknown parks as
   * ambiguous, and a collect refusal journals `collect-refused`.
   */
  private async performCollect(
    record: LaneRunRecord,
    gathered: GatheredLaneRunFacts,
    decision: Extract<LaneRunDecision, { kind: 'act' }>,
    request: AdvanceLaneRunRequest,
  ): Promise<AdvanceLaneRunResult> {
    const collect = this.deps.collectAttemptArtifacts;
    if (collect === undefined) {
      return { outcome: 'not-wired', step: decision.step };
    }
    const latest = gathered.latestAttempt;
    if (latest === null) {
      return { outcome: 'waiting', reason: 'facts-inconsistent' };
    }
    const commitEditOnlyAttempt = this.deps.commitEditOnlyAttempt;
    if (latest.runner?.kind === 'agy' && commitEditOnlyAttempt === undefined) {
      return { outcome: 'not-wired', step: decision.step };
    }
    const intentRefusal = await this.appendRunIntent(request, decision.key, null);
    if (intentRefusal !== null) {
      return { outcome: 'refused', reason: intentRefusal };
    }
    return this.runCollectBody(record, gathered, decision, request, decision.key);
  }

  /**
   * The collect body after its intent (K4-6): the frozen artifact list is
   * read before any write, the edit-only commit step runs first for an agy
   * attempt, then the collection. Both steps are safe to repeat — the commit
   * reads `already-committed`, a collected record is not collected twice —
   * so the collect reconcile (K4-7) runs this same body under the pending
   * key instead of appending a second intent.
   */
  private async runCollectBody(
    record: LaneRunRecord,
    gathered: GatheredLaneRunFacts,
    decision: Extract<LaneRunDecision, { kind: 'act' | 'reconcile' }>,
    request: AdvanceLaneRunRequest,
    key: string,
  ): Promise<AdvanceLaneRunResult> {
    const collect = this.deps.collectAttemptArtifacts;
    if (collect === undefined) {
      return { outcome: 'not-wired', step: decision.step };
    }
    const latest = gathered.latestAttempt;
    if (latest === null) {
      return { outcome: 'waiting', reason: 'facts-inconsistent' };
    }
    // Shared by the act and the reconcile: an agy attempt is never collected without its edit-only commit.
    if (latest.runner?.kind === 'agy' && this.deps.commitEditOnlyAttempt === undefined) {
      return { outcome: 'not-wired', step: decision.step };
    }
    if (latest.state !== 'ended' || latest.completionReceipt === null) {
      const resultRefusal = await this.appendRunResult(request, key, 'refused', 'no-completion-receipt');
      if (resultRefusal !== null) {
        return { outcome: 'refused', reason: resultRefusal };
      }
      return { outcome: 'acted', step: decision.step, key, result: 'refused', reasonCode: 'no-completion-receipt' };
    }
    // The frozen artifact list is read before any write: an absent or unreadable manifest, or an
    // unreadable expectedArtifacts, refuses the collect before the edit-only commit touches git.
    const manifest = await readFrozenManifest(latest, this.deps.artifactPort);
    const expectedArtifacts = manifest === null ? null : manifestExpectedArtifacts(manifest);
    if (expectedArtifacts === null) {
      const resultRefusal = await this.appendRunResult(request, key, 'refused', 'collect-refused');
      if (resultRefusal !== null) {
        return { outcome: 'refused', reason: resultRefusal };
      }
      return { outcome: 'acted', step: decision.step, key, result: 'refused', reasonCode: 'collect-refused' };
    }
    const commitEditOnlyAttempt = this.deps.commitEditOnlyAttempt;
    if (latest.runner?.kind === 'agy' && commitEditOnlyAttempt !== undefined) {
      const committed = await commitEditOnlyAttempt.commitEditOnlyAttempt({
        attemptId: latest.id,
        nowIso: request.nowIso,
      });
      if (committed.outcome === 'refused') {
        const resultRefusal = await this.appendRunResult(request, key, 'refused', 'edit-only-refused');
        if (resultRefusal !== null) {
          return { outcome: 'refused', reason: resultRefusal };
        }
        return { outcome: 'acted', step: decision.step, key, result: 'refused', reasonCode: 'edit-only-refused' };
      }
      if (committed.outcome === 'unknown') {
        const resultRefusal = await this.appendRunResult(request, key, 'ambiguous', 'edit-only-unknown');
        if (resultRefusal !== null) {
          return { outcome: 'refused', reason: resultRefusal };
        }
        return { outcome: 'acted', step: decision.step, key, result: 'ambiguous', reasonCode: 'edit-only-unknown' };
      }
    }
    const collected = await collect.collectAttemptArtifacts({
      attemptId: latest.id,
      workOrderId: record.workOrderId,
      expectedArtifacts,
      completionReceipt: latest.completionReceipt,
    });
    if (collected.outcome === 'collected') {
      const resultRefusal = await this.appendRunResult(request, key, 'completed', 'collected');
      if (resultRefusal !== null) {
        return { outcome: 'refused', reason: resultRefusal };
      }
      return { outcome: 'acted', step: decision.step, key, result: 'completed', reasonCode: 'collected' };
    }
    const resultRefusal = await this.appendRunResult(request, key, 'refused', 'collect-refused');
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    return { outcome: 'acted', step: decision.step, key, result: 'refused', reasonCode: 'collect-refused' };
  }

  /**
   * The `act gate` decision (K4-6): evaluate the frozen acceptance spec at the
   * collected head through `EvaluateAttemptGatePort`; only the typed verdict
   * decides, never a reason string.
   */
  private async performGate(
    record: LaneRunRecord,
    gathered: GatheredLaneRunFacts,
    decision: Extract<LaneRunDecision, { kind: 'act' }>,
    request: AdvanceLaneRunRequest,
  ): Promise<AdvanceLaneRunResult> {
    const preCheck = await this.gatePreCheck(record, gathered, decision, request);
    if (preCheck !== null) {
      return preCheck;
    }
    const intentRefusal = await this.appendRunIntent(request, decision.key, null);
    if (intentRefusal !== null) {
      return { outcome: 'refused', reason: intentRefusal };
    }
    return this.runGateBody(record, gathered, decision, request, decision.key);
  }

  /** The gate's pre-checks before its intent (K4-6): the wiring, the attempt's artifacts, the sealed collection. */
  private async gatePreCheck(
    record: LaneRunRecord,
    gathered: GatheredLaneRunFacts,
    decision: Extract<LaneRunDecision, { kind: 'act' | 'reconcile' }>,
    request: AdvanceLaneRunRequest,
  ): Promise<AdvanceLaneRunResult | null> {
    if (this.deps.evaluateAttemptGate === undefined) {
      return { outcome: 'not-wired', step: decision.step };
    }
    const latest = gathered.latestAttempt;
    if (latest === null || latest.artifacts === null) {
      return { outcome: 'waiting', reason: 'facts-inconsistent' };
    }
    // Only a sealed collection is gated: a missing or mismatched C1 manifest parks first.
    if (gathered.facts.attempt?.collection?.manifest !== 'sealed') {
      return this.performPark(record, 'artifacts-unsealed', null, gathered.facts.state, request);
    }
    return null;
  }

  /**
   * The gate body after its intent (K4-6): evaluate the frozen acceptance
   * spec at the collected head and record the typed verdict's mapping. A
   * second evaluation returns the first's stored outcome (S2b journals it
   * once), so the gate reconcile (K4-7) runs this same body under the
   * pending key instead of appending a second intent.
   */
  private async runGateBody(
    record: LaneRunRecord,
    gathered: GatheredLaneRunFacts,
    decision: Extract<LaneRunDecision, { kind: 'act' | 'reconcile' }>,
    request: AdvanceLaneRunRequest,
    key: string,
  ): Promise<AdvanceLaneRunResult> {
    const gate = this.deps.evaluateAttemptGate;
    if (gate === undefined) {
      return { outcome: 'not-wired', step: decision.step };
    }
    const latest = gathered.latestAttempt;
    if (latest === null || latest.artifacts === null) {
      return { outcome: 'waiting', reason: 'facts-inconsistent' };
    }
    const verdict = await gate.evaluateAttemptGate({
      attemptId: latest.id,
      candidateHeadSha: latest.artifacts.headCommit,
    });
    if (verdict.verdict === 'passed') {
      const resultRefusal = await this.appendRunResult(request, key, 'completed', 'gate-passed');
      if (resultRefusal !== null) {
        return { outcome: 'refused', reason: resultRefusal };
      }
      return { outcome: 'acted', step: decision.step, key, result: 'completed', reasonCode: 'gate-passed' };
    }
    if (verdict.verdict === 'failed') {
      const resultRefusal = await this.appendRunResult(request, key, 'completed', 'gate-failed');
      if (resultRefusal !== null) {
        return { outcome: 'refused', reason: resultRefusal };
      }
      return { outcome: 'acted', step: decision.step, key, result: 'completed', reasonCode: 'gate-failed' };
    }
    const resultRefusal = await this.appendRunResult(request, key, 'ambiguous', 'gate-unknown');
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    return { outcome: 'acted', step: decision.step, key, result: 'ambiguous', reasonCode: 'gate-unknown' };
  }

  /**
   * The G4e `cancel` decision (K4-5): the record-only cancel of a prepared,
   * never-dispatched attempt, journalled under its stop step key.
   */
  private async performCancel(
    decision: Extract<LaneRunDecision, { kind: 'cancel' }>,
    request: AdvanceLaneRunRequest,
  ): Promise<AdvanceLaneRunResult> {
    const cancel = this.deps.cancelPreparedAttempt;
    if (cancel === undefined) {
      return { outcome: 'not-wired', step: 'stop' };
    }
    const intentRefusal = await this.appendRunIntent(request, decision.key, decision.attemptId);
    if (intentRefusal !== null) {
      return { outcome: 'refused', reason: intentRefusal };
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
    const resultRefusal = await this.appendRunResult(request, decision.key, outcome, reasonCode);
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    return { outcome: 'acted', step: 'stop', key: decision.key, result: outcome, reasonCode };
  }

  /**
   * The `reconcile` decisions (K4-7, §3.5): an intent without a result is
   * reconciled, never repeated. One private handler per step; the result
   * entry is appended under the pending key, and nothing here calls an
   * acting port of a one-way step. A key whose step is `reconcile` is the
   * G4j force reconcile; any other unhandled step stays `not-built`.
   */
  private async performReconcile(
    record: LaneRunRecord,
    gathered: GatheredLaneRunFacts,
    decision: Extract<LaneRunDecision, { kind: 'reconcile' }>,
    request: AdvanceLaneRunRequest,
  ): Promise<AdvanceLaneRunResult> {
    const parsed = parseLaneRunKey(decision.key);
    if (parsed !== null && parsed.kind === 'step' && parsed.step === 'reconcile') {
      return this.reconcileForceStop(gathered, decision, request);
    }
    if (decision.step === 'prepare') {
      return this.reconcilePrepare(record, decision, request);
    }
    if (decision.step === 'dispatch') {
      return this.reconcileDispatch(gathered, decision, request);
    }
    if (decision.step === 'stop') {
      return this.reconcileStop(gathered, decision, request);
    }
    if (decision.step === 'collect') {
      return this.reconcileCollect(record, gathered, decision, request);
    }
    if (decision.step === 'gate') {
      return this.reconcileGate(record, gathered, decision, request);
    }
    return { outcome: 'not-built', decision: 'reconcile', step: decision.step };
  }

  /** The minted id of a key's intent, or null when the key has no intent. */
  private async intentMintedIdOf(key: string): Promise<string | null> {
    const entries = await this.deps.runJournal.listForKey(key);
    for (const entry of entries) {
      if (entry.kind === 'intent') {
        return entry.mintedId;
      }
    }
    return null;
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
  private async reconcilePrepare(
    record: LaneRunRecord,
    decision: Extract<LaneRunDecision, { kind: 'reconcile' }>,
    request: AdvanceLaneRunRequest,
  ): Promise<AdvanceLaneRunResult> {
    const mintedId = await this.intentMintedIdOf(decision.key);
    if (mintedId === null) {
      const resultRefusal = await this.appendRunResult(request, decision.key, 'not-started', 'attempt-absent');
      if (resultRefusal !== null) {
        return { outcome: 'refused', reason: resultRefusal };
      }
      return { outcome: 'acted', step: decision.step, key: decision.key, result: 'not-started', reasonCode: 'attempt-absent' };
    }
    const attempt = await this.deps.attemptRepo.findAttemptById(mintedId);
    const outcome: LaneRunJournalOutcome = attempt !== null ? 'reconciled' : 'not-started';
    const reasonCode: LaneRunResultReasonCode = attempt !== null ? 'prepared' : 'attempt-absent';
    // The ordinal is spent on the run record BEFORE the result is journalled: once a result exists this
    // handler never runs again, so a crash between the two must leave the id on the run, never off it.
    if (!record.attemptIds.includes(mintedId)) {
      const saved = await this.saveOrRefuse(
        { ...record, attemptIds: [...record.attemptIds, mintedId], revision: record.revision + 1 },
        request,
      );
      if (!saved.ok) {
        return { outcome: 'refused', reason: saved.reason };
      }
    }
    const resultRefusal = await this.appendRunResult(request, decision.key, outcome, reasonCode);
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
  private async reconcileDispatch(
    gathered: GatheredLaneRunFacts,
    decision: Extract<LaneRunDecision, { kind: 'reconcile' }>,
    request: AdvanceLaneRunRequest,
  ): Promise<AdvanceLaneRunResult> {
    const mintedId = await this.intentMintedIdOf(decision.key);
    const attempt = mintedId === null ? null : await this.deps.attemptRepo.findAttemptById(mintedId);
    if (
      attempt !== null &&
      (attempt.state === 'running' || attempt.state === 'ended' || attempt.state === 'collected' || attempt.sessionId !== null)
    ) {
      return this.reconcileDispatchStarted(gathered, decision, request, 'dispatch-started');
    }
    if (
      attempt !== null &&
      attempt.state === 'cancelled' &&
      attempt.sessionId === null &&
      !(await this.dispatchEverJournalled(attempt.id))
    ) {
      // Re-entry after a crash between the idle-worktree cancel and its result. DispatchAttempt journals a
      // `dispatch` intent before it contacts any runner, so a cancelled attempt with no such entry never
      // reached a runner, whoever cancelled it; one with an entry did, and stays runner-refused below.
      return this.closeDispatchNotStarted(decision, request);
    }
    if (attempt !== null && attempt.state === 'cancelled') {
      const resultRefusal = await this.appendRunResult(request, decision.key, 'refused', 'runner-refused');
      if (resultRefusal !== null) {
        return { outcome: 'refused', reason: resultRefusal };
      }
      const conductRefusal = await this.conductDispatching(gathered.facts.state, request);
      if (conductRefusal !== null) {
        return { outcome: 'refused', reason: conductRefusal };
      }
      return { outcome: 'acted', step: decision.step, key: decision.key, result: 'refused', reasonCode: 'runner-refused' };
    }
    if (
      attempt !== null &&
      (attempt.state === 'dispatching' || attempt.state === 'reconciling' || attempt.state === 'blocked')
    ) {
      const result = await this.deps.reconcileAttempt.reconcileAttempt({ attemptId: attempt.id, nowIso: request.nowIso });
      if (result.outcome === 'active' || result.outcome === 'ended' || result.outcome === 'cancelled') {
        return this.reconcileDispatchStarted(gathered, decision, request, 'reconciled');
      }
      // unknown, refused, not-found: the next advance parks `ambiguous dispatch`.
      const resultRefusal = await this.appendRunResult(request, decision.key, 'ambiguous', 'dispatch-unknown');
      if (resultRefusal !== null) {
        return { outcome: 'refused', reason: resultRefusal };
      }
      return { outcome: 'acted', step: decision.step, key: decision.key, result: 'ambiguous', reasonCode: 'dispatch-unknown' };
    }
    // The record is still `intent-recorded`, or absent: the worktree decides.
    return this.reconcileDispatchByWorktree(gathered, decision, attempt, mintedId, request);
  }

  /** A dispatch reconcile that found the attempt started (or reconciled): record it and conduct `dispatching`. */
  private async reconcileDispatchStarted(
    gathered: GatheredLaneRunFacts,
    decision: Extract<LaneRunDecision, { kind: 'reconcile' }>,
    request: AdvanceLaneRunRequest,
    reasonCode: LaneRunResultReasonCode,
  ): Promise<AdvanceLaneRunResult> {
    const resultRefusal = await this.appendRunResult(request, decision.key, 'reconciled', reasonCode);
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    const conductRefusal = await this.conductDispatching(gathered.facts.state, request);
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
  private async reconcileDispatchByWorktree(
    gathered: GatheredLaneRunFacts,
    decision: Extract<LaneRunDecision, { kind: 'reconcile' }>,
    attempt: AttemptRecord | null,
    mintedId: string | null,
    request: AdvanceLaneRunRequest,
  ): Promise<AdvanceLaneRunResult> {
    const ambiguous = async (reasonCode: LaneRunResultReasonCode): Promise<AdvanceLaneRunResult> => {
      const resultRefusal = await this.appendRunResult(request, decision.key, 'ambiguous', reasonCode);
      if (resultRefusal !== null) {
        return { outcome: 'refused', reason: resultRefusal };
      }
      return { outcome: 'acted', step: decision.step, key: decision.key, result: 'ambiguous', reasonCode };
    };
    const runnerForAttempt = this.deps.runnerForAttempt;
    if (runnerForAttempt === undefined) {
      return ambiguous('worktree-unknown');
    }
    let runnerRecord: AttemptRunnerRecord | null = attempt?.runner ?? null;
    if (runnerRecord === null && (parseSeatTool(attempt?.seatSelection?.tool) ?? 'opencode') === 'agy') {
      const reservations = await this.deps.executionJournal.listActiveReservations();
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
      const resultRefusal = await this.appendRunResult(request, decision.key, 'ambiguous', 'worktree-running');
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
      const cancel = this.deps.cancelPreparedAttempt;
      if (cancel === undefined) {
        return ambiguous('worktree-unknown');
      }
      const cancelled = await cancel.cancelPreparedAttempt({ attemptId, nowIso: request.nowIso });
      if (cancelled.outcome !== 'cancelled') {
        return ambiguous('worktree-unknown');
      }
    }
    return this.closeDispatchNotStarted(decision, request);
  }

  /** True when the execution journal holds a non-refused `dispatch` entry for the attempt (a runner may have been contacted). */
  private async dispatchEverJournalled(attemptId: string): Promise<boolean> {
    const entries = await this.deps.executionJournal.listJournalEntriesForAttempt(attemptId);
    return entries.some((entry) => entry.action === 'dispatch' && entry.status !== 'refused');
  }

  /** The dispatch key's `not-started` / `worktree-idle` result, once its untouched attempt is cancelled. */
  private async closeDispatchNotStarted(
    decision: Extract<LaneRunDecision, { kind: 'reconcile' }>,
    request: AdvanceLaneRunRequest,
  ): Promise<AdvanceLaneRunResult> {
    const resultRefusal = await this.appendRunResult(request, decision.key, 'not-started', 'worktree-idle');
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
  private async reconcileStop(
    gathered: GatheredLaneRunFacts,
    decision: Extract<LaneRunDecision, { kind: 'reconcile' }>,
    request: AdvanceLaneRunRequest,
  ): Promise<AdvanceLaneRunResult> {
    // The G4e cancel journals under the stop key with its attempt id; a stop intent carries none.
    const cancelAttemptId = await this.intentMintedIdOf(decision.key);
    if (cancelAttemptId !== null) {
      return this.reconcileCancel(cancelAttemptId, decision, request);
    }
    const latest = gathered.latestAttempt;
    const stored = latest === null ? null : await this.deps.attemptRepo.findAttemptById(latest.id);
    const attempt = stored ?? latest;
    const terminal =
      attempt !== null &&
      (attempt.state === 'cancelled' ||
        attempt.state === 'collected' ||
        (attempt.state === 'ended' && attempt.completionReceipt !== null && attempt.completionReceipt.authoritative === true));
    if (!terminal) {
      const resultRefusal = await this.appendRunResult(request, decision.key, 'completed', 'stop-unconfirmed');
      if (resultRefusal !== null) {
        return { outcome: 'refused', reason: resultRefusal };
      }
      return { outcome: 'acted', step: decision.step, key: decision.key, result: 'completed', reasonCode: 'stop-unconfirmed' };
    }
    if (gathered.facts.stopMode === 'force') {
      // §3.8: a slot is never reported released unless the reservation confirmed it.
      const reservations = await this.deps.executionJournal.listActiveReservations();
      const held = attempt !== null && reservations.some((reservation) => reservation.attemptId === attempt.id && reservation.held);
      const reasonCode = held ? 'stop-force-slot-held' : 'stop-force';
      const resultRefusal = await this.appendRunResult(request, decision.key, 'completed', reasonCode);
      if (resultRefusal !== null) {
        return { outcome: 'refused', reason: resultRefusal };
      }
      const appended = await this.appendConduct(request, 'stopped');
      if (!appended.ok) {
        return { outcome: 'refused', reason: appended.reason };
      }
      return { outcome: 'acted', step: decision.step, key: decision.key, result: 'completed', reasonCode };
    }
    const resultRefusal = await this.appendRunResult(request, decision.key, 'completed', 'stop-timeout');
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
  private async reconcileCancel(
    attemptId: string,
    decision: Extract<LaneRunDecision, { kind: 'reconcile' }>,
    request: AdvanceLaneRunRequest,
  ): Promise<AdvanceLaneRunResult> {
    const attempt = await this.deps.attemptRepo.findAttemptById(attemptId);
    let outcome: LaneRunJournalOutcome;
    let reasonCode: LaneRunResultReasonCode;
    if (attempt === null) {
      outcome = 'cancelled-unstarted';
      reasonCode = 'attempt-absent';
    } else if (attempt.state === 'cancelled') {
      const reservations = await this.deps.executionJournal.listActiveReservations();
      const held = reservations.some((reservation) => reservation.attemptId === attemptId && reservation.held);
      outcome = 'cancelled-unstarted';
      reasonCode = held ? 'capacity-held' : 'capacity-none-held';
    } else if (attempt.state === 'intent-recorded') {
      const cancel = this.deps.cancelPreparedAttempt;
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
    const resultRefusal = await this.appendRunResult(request, decision.key, outcome, reasonCode);
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
  private async reconcileCollect(
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
      const resultRefusal = await this.appendRunResult(request, decision.key, 'reconciled', 'collected');
      if (resultRefusal !== null) {
        return { outcome: 'refused', reason: resultRefusal };
      }
      return { outcome: 'acted', step: decision.step, key: decision.key, result: 'reconciled', reasonCode: 'collected' };
    }
    return this.runCollectBody(record, gathered, decision, request, decision.key);
  }

  /**
   * The gate reconcile (§3.5): gate is not one-way, so its reconcile
   * completes it — the K4-6 pre-checks and mapping run again, and the
   * evaluation returns the first's stored outcome.
   */
  private async reconcileGate(
    record: LaneRunRecord,
    gathered: GatheredLaneRunFacts,
    decision: Extract<LaneRunDecision, { kind: 'reconcile' }>,
    request: AdvanceLaneRunRequest,
  ): Promise<AdvanceLaneRunResult> {
    const preCheck = await this.gatePreCheck(record, gathered, decision, request);
    if (preCheck !== null) {
      return preCheck;
    }
    return this.runGateBody(record, gathered, decision, request, decision.key);
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
  private async reconcileForceStop(
    gathered: GatheredLaneRunFacts,
    decision: Extract<LaneRunDecision, { kind: 'reconcile' }>,
    request: AdvanceLaneRunRequest,
  ): Promise<AdvanceLaneRunResult> {
    const latest = gathered.latestAttempt;
    if (latest === null) {
      return { outcome: 'waiting', reason: 'facts-inconsistent' };
    }
    const entries = await this.deps.runJournal.listForKey(decision.key);
    if (!entries.some((entry) => entry.kind === 'intent')) {
      const intentRefusal = await this.appendRunIntent(request, decision.key, latest.id);
      if (intentRefusal !== null) {
        return { outcome: 'refused', reason: intentRefusal };
      }
    }
    if ((latest.runner ?? null) === null && (parseSeatTool(latest.seatSelection?.tool) ?? 'opencode') === 'agy') {
      const resultRefusal = await this.appendRunResult(request, decision.key, 'ambiguous', 'worktree-unknown');
      if (resultRefusal !== null) {
        return { outcome: 'refused', reason: resultRefusal };
      }
      return { outcome: 'acted', step: decision.step, key: decision.key, result: 'ambiguous', reasonCode: 'worktree-unknown' };
    }
    const result = await this.deps.reconcileAttempt.reconcileAttempt({ attemptId: latest.id, nowIso: request.nowIso });
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
    const resultRefusal = await this.appendRunResult(request, decision.key, outcome, reasonCode);
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    return { outcome: 'acted', step: decision.step, key: decision.key, result: outcome, reasonCode };
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
    return saved.outcome === 'saved' ? { ok: true, record: saved.record } : { ok: false, reason: 'save-refused' };
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
    return { facts, deadlineUnknown, latestAttempt: latest, attemptRecords };
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

  /**
   * The `wait admission` hook: reserve once for a prepared attempt, never
   * while halted. A refused admit parks `step-refused dispatch` (the dispatch
   * refusal's park) so the owner sees it; admitted and no-capacity wait.
   */
  private async performAdmissionWait(
    record: LaneRunRecord,
    facts: LaneRunFacts,
    latest: AttemptRecord | null,
    request: AdvanceLaneRunRequest,
  ): Promise<AdvanceLaneRunResult> {
    const attempt = facts.attempt;
    if (!request.halted && attempt !== null && attempt.phase === 'prepared' && latest !== null) {
      const admission = await this.deps.admission.admit({
        attemptId: attempt.attemptId,
        workOrderId: record.workOrderId,
        seatTool: parseSeatTool(latest.seatSelection?.tool) ?? 'opencode',
        worktreePath: latest.worktreePath,
        nowIso: request.nowIso,
      });
      if (admission.outcome === 'refused') {
        return this.performPark(record, 'step-refused', 'dispatch', facts.state, request);
      }
    }
    return { outcome: 'waiting', reason: 'admission' };
  }
}
