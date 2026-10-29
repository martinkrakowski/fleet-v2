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
 *
 * The acts live in `advance-lane-run/` (step-context, frozen-manifest,
 * prepare-dispatch, stop-cancel, collect-gate, reconcile, facts); the
 * class keeps the decision switch. A new act gets its own module here and
 * one branch in `performDecision`.
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
import type { StopAttemptPort } from '../ports/in/StopAttemptPort.in-port.js';
import type { CollectAttemptArtifactsPort } from '../ports/in/CollectAttemptArtifactsPort.in-port.js';
import type { CommitEditOnlyAttemptPort } from '../ports/in/CommitEditOnlyAttemptPort.in-port.js';
import type { EvaluateAttemptGatePort } from '../ports/in/EvaluateAttemptGatePort.in-port.js';
import type { RunnerForAttemptPort } from '../ports/out/RunnerForAttemptPort.out-port.js';
import { checkLeaseHeld } from '../../domain/lane-run-lease.js';
import type { LeaseRefusal } from '../../domain/lane-run-lease.js';
import { laneRunJournalState } from '../../domain/lane-run-journal.js';
import { laneRunParkedConductCount } from '../../domain/lane-run-step-facts.js';
import { isCalendarDateTime } from '../../domain/plain-record-reads.js';
import type { LaneRunRecord } from '../../domain/lane-run-records.js';
import type { LaneRunDecision } from '../../domain/lane-run-decider.js';
import { nextLaneRunAction } from '../../domain/lane-run-decider.js';
import type { AdvanceStepContext, GatheredLaneRunFacts } from './advance-lane-run/step-context.js';
import {
  appendConduct,
  performEnter,
  performPark,
  saveOrRefuse,
} from './advance-lane-run/step-context.js';
import {
  performDispatch,
  performPrepare,
} from './advance-lane-run/prepare-dispatch.js';
import { performCancel, performStop } from './advance-lane-run/stop-cancel.js';
import { performCollect, performGate } from './advance-lane-run/collect-gate.js';
import { performReconcile } from './advance-lane-run/reconcile.js';
import { gatherFacts, performAdmissionWait } from './advance-lane-run/facts.js';

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

export class AdvanceLaneRunUseCase implements AdvanceLaneRunPort {
  private readonly ctx: AdvanceStepContext;

  constructor(private readonly deps: AdvanceLaneRunDependencies) {
    this.ctx = { deps };
  }

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
        const appended = await appendConduct(this.ctx, request, 'parked');
        if (!appended.ok) {
          return { outcome: 'refused', reason: appended.reason };
        }
        return { outcome: 'repaired', state: 'parked' };
      }
      if (parkedConducts === record.parkCount) {
        const saved = await saveOrRefuse(this.ctx,
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

    const gathered = await gatherFacts(this.ctx, record, entries, request, journalState);
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
      return performAdmissionWait(this.ctx, record, facts, gathered.latestAttempt, request);
    }
    if (decision.kind === 'wait' && decision.reason === 'lane-running' && gathered.deadlineUnknown) {
      return performPark(this.ctx, record, 'ambiguous', 'stop', facts.state, request);
    }
    if (decision.kind === 'wait') {
      return { outcome: 'waiting', reason: decision.reason };
    }
    if (decision.kind === 'act') {
      if (decision.step === 'prepare') {
        return performPrepare(this.ctx, record, gathered, decision, request);
      }
      if (decision.step === 'dispatch') {
        return performDispatch(this.ctx, record, gathered, decision, request);
      }
      if (decision.step === 'stop') {
        return performStop(this.ctx, record, gathered, decision, request);
      }
      if (decision.step === 'collect') {
        return performCollect(this.ctx, record, gathered, decision, request);
      }
      if (decision.step === 'gate') {
        return performGate(this.ctx, record, gathered, decision, request);
      }
      return { outcome: 'not-built', decision: 'act', step: decision.step };
    }
    if (decision.kind === 'reconcile') {
      return performReconcile(this.ctx, record, gathered, decision, request);
    }
    if (decision.kind === 'cancel') {
      return performCancel(this.ctx, decision, request);
    }
    if (decision.kind === 'enter') {
      return performEnter(this.ctx, record, facts.state, decision.to, request);
    }
    return performPark(this.ctx, record, decision.reason, decision.qualifier, decision.parkedFrom, request);
  }

}
