// Implemented for lane K7-5b (owner decision K7-D7, "Start reserves first").
/**
 * LaneRunAdmissionAdapter implements both conductor admission ports:
 *
 * - `LaneRunStartCapacityPort.reserveFirst` — the first attempt of a new
 *   run: the global cap and package-busy checks run first (K7-D5), then the
 *   reserve chooses host and worktree path among the installation's
 *   lane-runner hosts (`candidateHosts`).
 * - `LaneRunAdmissionPort.admit` (K4-4a) — a later attempt of a run (a
 *   round-0 seat pivot): pinned to the run's own host and worktree, on the
 *   legacy reserve path. A reservation that comes back at any other path is
 *   released and refused (`worktree-mismatch`): the fail-closed guard for
 *   records created otherwise — a start-created run never hits it.
 *
 * Active runs (both checks): non-terminal runs (`laneRunJournalState`)
 * holding a reservation for one of their attempts. A run that lists the
 * excluded attempt never counts against itself.
 */

import type { CapacityReservationRecord } from '../../domain/execution-records.js';
import { laneRunJournalState } from '../../domain/lane-run-journal.js';
import { LANE_RUN_TERMINAL_STATES } from '../../domain/value-objects/LaneRunState.vo.js';
import type { LaneRunStateValue } from '../../domain/value-objects/LaneRunState.vo.js';
import type { LaneRunRecord } from '../../domain/lane-run-records.js';
import { laneRunPackagesOverlap } from '../../domain/lane-run-packages.js';
import type { LaneRunAdmissionPort, LaneRunAdmissionRequest, LaneRunAdmissionResult } from '../../application/ports/out/LaneRunAdmissionPort.out-port.js';
import type { ExecutionJournalPort } from '../../application/ports/out/ExecutionJournalPort.out-port.js';
import type {
  ReserveExecutionCapacityHost,
  ReserveExecutionCapacityPort,
  ReserveExecutionCapacityResult,
  ReserveExecutionCapacityCandidateHost,
} from '../../application/ports/in/ReserveExecutionCapacityPort.in-port.js';
import type {
  LaneRunStartCapacityPort,
  LaneRunFirstReservationRequest,
  LaneRunFirstReservationResult,
} from '../../application/ports/out/LaneRunStartCapacityPort.out-port.js';
import type { AttemptRepositoryPort } from '../../application/ports/out/AttemptRepositoryPort.out-port.js';
import type { LaneRunJournalPort } from '../../application/ports/out/LaneRunJournalPort.out-port.js';
import type { LaneRunRepositoryPort } from '../../application/ports/out/LaneRunRepositoryPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../../application/ports/out/WorkOrderRepositoryPort.out-port.js';

export interface LaneRunAdmissionAdapterOptions {
  readonly reserve: ReserveExecutionCapacityPort;
  readonly runRepo: Pick<LaneRunRepositoryPort, 'list'>;
  readonly runJournal: Pick<LaneRunJournalPort, 'listForRun'>;
  readonly workOrderRepo: Pick<WorkOrderRepositoryPort, 'findWorkOrderById'>;
  readonly attemptRepo: Pick<AttemptRepositoryPort, 'findAttemptById'>;
  readonly executionJournal: Pick<
    ExecutionJournalPort,
    'listActiveReservations' | 'releaseCapacityReservation'
  >;
  /** K7-D5: `conductor run --max-active-runs <n>`, default 1 at the CLI. */
  readonly maxActiveRuns: number;
  /** The installation's lane-runner hosts (K7-D7: the reserve chooses host and path). */
  readonly candidateHosts?: readonly ReserveExecutionCapacityCandidateHost[];
  readonly newReservationId: () => string;
}

/** Non-terminal per `laneRunJournalState`. */
function isTerminalRunState(state: LaneRunStateValue): boolean {
  return (LANE_RUN_TERMINAL_STATES as readonly LaneRunStateValue[]).includes(state);
}

interface ActiveRun {
  readonly run: LaneRunRecord;
  readonly state: LaneRunStateValue;
}

export class LaneRunAdmissionAdapter implements LaneRunAdmissionPort, LaneRunStartCapacityPort {
  constructor(private readonly options: LaneRunAdmissionAdapterOptions) {}

  async reserveFirst(request: LaneRunFirstReservationRequest): Promise<LaneRunFirstReservationResult> {
    const blocked = await this.admissionBlocked(request.workOrderId, request.attemptId);
    if (blocked) {
      return { outcome: 'no-capacity' };
    }
    const candidateHosts = this.options.candidateHosts ?? [];
    if (candidateHosts.length === 0) {
      return { outcome: 'refused', reason: 'no-host' };
    }
    const reserved = await this.options.reserve.reserveExecutionCapacity({
      reservationId: this.options.newReservationId(),
      attemptId: request.attemptId,
      workOrderId: request.workOrderId,
      seatTool: request.seatTool,
      candidateHosts,
      nowIso: request.nowIso,
    });
    return this.firstReservationResultOf(reserved, request);
  }

  async admit(request: LaneRunAdmissionRequest): Promise<LaneRunAdmissionResult> {
    const runs = await this.options.runRepo.list();
    const run = runs.find((candidate) => candidate.attemptIds.includes(request.attemptId));
    if (run === undefined) {
      return { outcome: 'refused', reason: 'run-missing' };
    }
    const blocked = await this.admissionBlocked(request.workOrderId, request.attemptId);
    if (blocked) {
      return { outcome: 'no-capacity' };
    }
    const pinnedHost = await this.pinnedHostNameOf(run);
    if (pinnedHost === null) {
      return { outcome: 'refused', reason: 'run-host-unknown' };
    }
    const candidateHosts = this.options.candidateHosts ?? [];
    const candidate = candidateHosts.find((host) => host.name === pinnedHost);
    if (candidate === undefined) {
      return { outcome: 'refused', reason: 'run-host-unknown' };
    }
    if (candidate.kind !== request.seatTool) {
      // A seat of another tool cannot run in this host's worktree; K5's fix
      // rounds decide this case.
      return { outcome: 'refused', reason: 'host-kind-differs' };
    }
    const host: ReserveExecutionCapacityHost = {
      hostName: candidate.name,
      hostKind: candidate.kind,
      transport: candidate.transport,
      sshAlias: candidate.sshAlias,
      port: candidate.port,
    };
    const reserved = await this.options.reserve.reserveExecutionCapacity({
      reservationId: this.options.newReservationId(),
      attemptId: request.attemptId,
      workOrderId: request.workOrderId,
      seatTool: request.seatTool,
      hostId: candidate.name,
      worktreePath: request.worktreePath,
      maxSlots: candidate.maxLanes ?? 1,
      host,
      nowIso: request.nowIso,
    });
    if (reserved.outcome === 'reserved') {
      if (reserved.reservation.worktreePath !== request.worktreePath) {
        await this.options.executionJournal.releaseCapacityReservation(
          request.attemptId,
          request.nowIso,
        );
        return { outcome: 'refused', reason: 'worktree-mismatch' };
      }
      return { outcome: 'admitted' };
    }
    if (reserved.outcome === 'no-free-slot' || reserved.outcome === 'no-capacity' || reserved.outcome === 'busy-worktree') {
      return { outcome: 'no-capacity' };
    }
    return { outcome: 'refused', reason: 'reserve-refused' };
  }

  private async firstReservationResultOf(
    reserved: ReserveExecutionCapacityResult,
    request: LaneRunFirstReservationRequest,
  ): Promise<LaneRunFirstReservationResult> {
    if (reserved.outcome === 'reserved') {
      const reservation = reserved.reservation;
      if (
        reservation.hostName == null ||
        reservation.hostKind == null ||
        reservation.worktreePath == null
      ) {
        await this.options.executionJournal.releaseCapacityReservation(
          request.attemptId,
          request.nowIso,
        );
        return { outcome: 'refused', reason: 'reservation-incomplete' };
      }
      return {
        outcome: 'reserved',
        hostName: reservation.hostName,
        hostKind: reservation.hostKind,
        worktreePath: reservation.worktreePath,
      };
    }
    if (
      reserved.outcome === 'no-free-slot' ||
      reserved.outcome === 'no-capacity' ||
      reserved.outcome === 'busy-worktree'
    ) {
      return { outcome: 'no-capacity' };
    }
    // Never the reserve's own text (K7-5b).
    return { outcome: 'refused', reason: 'reserve-refused' };
  }

  /**
   * Global cap first, then package-busy (K7-D5). Active runs hold a
   * reservation for one of their attempts and are not terminal; the run
   * that lists `excludeAttemptId` is excluded. Work orders are read with
   * `Promise.all`; an unreadable work order counts as overlapping (fail
   * closed).
   */
  private async admissionBlocked(workOrderId: string, excludeAttemptId: string): Promise<boolean> {
    const [runs, heldReservations] = await Promise.all([
      this.options.runRepo.list(),
      this.options.executionJournal.listActiveReservations(),
    ]);
    const heldByAttempt = new Map<string, CapacityReservationRecord>();
    for (const reservation of heldReservations) {
      if (reservation.held) {
        heldByAttempt.set(reservation.attemptId, reservation);
      }
    }
    const active: ActiveRun[] = [];
    for (const run of runs) {
      if (run.attemptIds.includes(excludeAttemptId)) {
        continue;
      }
      if (!run.attemptIds.some((attemptId) => heldByAttempt.has(attemptId))) {
        continue;
      }
      const state = laneRunJournalState(await this.options.runJournal.listForRun(run.runId), run.runId);
      if (!isTerminalRunState(state)) {
        active.push({ run, state });
      }
    }
    if (active.length >= this.options.maxActiveRuns) {
      return true;
    }
    const thisOrder = await this.options.workOrderRepo.findWorkOrderById(workOrderId);
    if (thisOrder === null) {
      return true;
    }
    const workOrders = await Promise.all(
      active.map((activeRun) => this.options.workOrderRepo.findWorkOrderById(activeRun.run.workOrderId)),
    );
    return workOrders.some(
      (other) => other === null || laneRunPackagesOverlap(other, thisOrder),
    );
  }

  /**
   * The host of the run's first attempt: its recorded `runner.hostName`,
   * else the `hostName` of any held reservation for the run's attempts. The
   * journal lists held reservations only, so released ones are not read.
   */
  private async pinnedHostNameOf(run: LaneRunRecord): Promise<string | null> {
    const firstAttemptId = run.attemptIds[0];
    if (firstAttemptId !== undefined) {
      const firstAttempt = await this.options.attemptRepo.findAttemptById(firstAttemptId);
      const runnerHost = firstAttempt?.runner?.hostName;
      if (typeof runnerHost === 'string' && runnerHost.length > 0) {
        return runnerHost;
      }
    }
    const held = await this.options.executionJournal.listActiveReservations();
    for (const reservation of held) {
      if (run.attemptIds.includes(reservation.attemptId) && reservation.hostName != null) {
        return reservation.hostName;
      }
    }
    return null;
  }
}
