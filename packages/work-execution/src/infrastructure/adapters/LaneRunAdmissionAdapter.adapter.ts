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
 *   legacy reserve path. Its cap and package-busy checks are re-run after
 *   the reservation is written (KF-34c1). A reservation that comes back at
 *   any other path is released and refused (`worktree-mismatch`): the
 *   fail-closed guard for records created otherwise — a start-created run
 *   never hits it.
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
import { laneRunOwnedPathsOverlap } from '../../domain/lane-run-packages.js';
import type { ForgeReadPort } from '../../application/ports/out/ForgeReadPort.out-port.js';
import type {
  LaneRunAdmissionBlockers,
  LaneRunAdmissionPort,
  LaneRunAdmissionRequest,
  LaneRunAdmissionResult,
} from '../../application/ports/out/LaneRunAdmissionPort.out-port.js';
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
  readonly runJournal: Pick<LaneRunJournalPort, 'listForRun' | 'listForRuns'>;
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
  /** KS5: read whether a parked run's PR has merged; absent reads fail closed (the run keeps blocking). */
  readonly forgeRead?: Pick<ForgeReadPort, 'readPullRequest'>;
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

interface InFlightReservation {
  readonly attemptId: string;
  readonly workOrderId: string | null;
}

export class LaneRunAdmissionAdapter implements LaneRunAdmissionPort, LaneRunStartCapacityPort {
  constructor(private readonly options: LaneRunAdmissionAdapterOptions) {}

  async reserveFirst(request: LaneRunFirstReservationRequest): Promise<LaneRunFirstReservationResult> {
    const verdict = await this.admissionVerdict(request.workOrderId, request.attemptId);
    if (verdict.blocked) {
      return { outcome: 'no-capacity', blockedBy: verdict.blockers };
    }
    const candidateHosts = this.options.candidateHosts ?? [];
    if (candidateHosts.length === 0) {
      return { outcome: 'refused', reason: 'no-host' };
    }
    // KF-14b: a host whose remote review route cannot be built (an ssh host
    // declaring no `runner.authFile`) is never offered to the reserve — a run
    // must never get far enough to park `review-seat-unavailable` at
    // brief-check. The original list was non-empty, so this refusal is
    // distinguishable from `no-host`.
    const routableHosts = candidateHosts.filter((host) => host.reviewRoute !== 'no-auth-file');
    if (routableHosts.length === 0) {
      return { outcome: 'refused', reason: 'no-review-route' };
    }
    const reserved = await this.options.reserve.reserveExecutionCapacity({
      reservationId: this.options.newReservationId(),
      attemptId: request.attemptId,
      workOrderId: request.workOrderId,
      seatTool: request.seatTool,
      candidateHosts: routableHosts,
      nowIso: request.nowIso,
    });
    if (reserved.outcome === 'reserved') {
      // The cap and package-busy checks are re-run after the reservation is
      // written (K7-5b fix round 2): another start may have reserved
      // concurrently between the first check and this one. The re-check
      // excludes this attempt's own reservation from being double-counted;
      // if it now blocks, THIS reservation is released and the start is
      // refused `no-capacity`. Both racers may refuse (safe; the caller
      // retries). A re-check that throws must not leave the reservation
      // held (a duplicate on the next pass parks the run), so the attempt's
      // reservation is released before the throw propagates.
      let stillBlocked: { blocked: boolean; blockers: LaneRunAdmissionBlockers };
      try {
        stillBlocked = await this.admissionVerdict(request.workOrderId, request.attemptId);
      } catch (error) {
        await this.options.executionJournal.releaseCapacityReservation(
          request.attemptId,
          request.nowIso,
        );
        throw error;
      }
      if (stillBlocked.blocked) {
        await this.options.executionJournal.releaseCapacityReservation(
          request.attemptId,
          request.nowIso,
        );
        return { outcome: 'no-capacity', blockedBy: stillBlocked.blockers };
      }
    }
    return this.firstReservationResultOf(reserved, request);
  }

  async admit(request: LaneRunAdmissionRequest): Promise<LaneRunAdmissionResult> {
    const runs = await this.options.runRepo.list();
    const run = runs.find((candidate) => candidate.attemptIds.includes(request.attemptId));
    if (run === undefined) {
      return { outcome: 'refused', reason: 'run-missing' };
    }
    const verdict = await this.admissionVerdict(request.workOrderId, request.attemptId);
    if (verdict.blocked) {
      return { outcome: 'no-capacity', blockedBy: verdict.blockers };
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
    // A later attempt must use the run's first attempt's worktree path. Read
    // the first attempt record and compare it with the request before
    // reserving; different, or the first attempt unreadable, refuse
    // `worktree-mismatch` without reserving.
    const firstAttemptId = run.attemptIds[0];
    const firstAttempt =
      firstAttemptId === undefined
        ? null
        : await this.options.attemptRepo.findAttemptById(firstAttemptId);
    if (firstAttempt === null || firstAttempt.worktreePath !== request.worktreePath) {
      return { outcome: 'refused', reason: 'worktree-mismatch' };
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
      // The cap and package-busy checks are re-run after the reservation is
      // written (KF-34c1): concurrent admissions or starts may have reserved
      // between the first check and this one. If it now blocks, THIS
      // reservation is released and the attempt is refused `no-capacity`;
      // both racers may refuse (safe; the caller retries on its next pass).
      // A re-check that throws must not leave the reservation held (a
      // duplicate on the next pass parks the run), so the attempt's
      // reservation is released before the throw propagates.
      let stillBlocked: { blocked: boolean; blockers: LaneRunAdmissionBlockers };
      try {
        stillBlocked = await this.admissionVerdict(request.workOrderId, request.attemptId);
      } catch (error) {
        await this.options.executionJournal.releaseCapacityReservation(
          request.attemptId,
          request.nowIso,
        );
        throw error;
      }
      if (stillBlocked.blocked) {
        await this.options.executionJournal.releaseCapacityReservation(
          request.attemptId,
          request.nowIso,
        );
        return { outcome: 'no-capacity', blockedBy: stillBlocked.blockers };
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
      const sshAlias = reservation.sshAlias?.trim() || null;
      return {
        outcome: 'reserved',
        hostName: reservation.hostName,
        hostKind: reservation.hostKind,
        worktreePath: reservation.worktreePath,
        // Records persisted before these fields existed read with `null`; a
        // legacy record derives its transport from the trimmed alias it
        // carries (a blank alias is no alias).
        transport: reservation.transport ?? (sshAlias ? 'ssh' : 'local'),
        sshAlias,
        port: reservation.port ?? null,
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
   * Global cap first, then owned-file overlap (K7-D5, KS5). Active runs hold
   * a reservation for one of their attempts and are not terminal; the run
   * that lists `excludeAttemptId` is excluded. A parked run whose PR has
   * merged stays in the cap count but is dropped from the overlap candidates.
   * Work orders are read with `Promise.all`; an unreadable work order counts
   * as overlapping (fail closed) and names its run or attempt.
   */
  private async admissionVerdict(
    workOrderId: string,
    excludeAttemptId: string,
  ): Promise<{ blocked: boolean; blockers: LaneRunAdmissionBlockers }> {
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
    const active = await this.collectActiveRuns(runs, heldByAttempt, excludeAttemptId);
    const inFlight = await this.collectInFlightReservations(heldReservations, runs, excludeAttemptId);
    if (active.length + inFlight.length >= this.options.maxActiveRuns) {
      return {
        blocked: true,
        blockers: {
          runIds: [...new Set(active.map((entry) => entry.run.runId))].sort((left, right) => left.localeCompare(right)),
          attemptIds: [...new Set(inFlight.map((entry) => entry.attemptId))].sort((left, right) => left.localeCompare(right)),
        },
      };
    }
    const thisOrder = await this.options.workOrderRepo.findWorkOrderById(workOrderId);
    if (thisOrder === null) {
      return { blocked: true, blockers: { runIds: [], attemptIds: [] } };
    }
    const candidates: ActiveRun[] = [];
    for (const entry of active) {
      if (entry.state === 'parked' && (await this.parkedPrMergedOf(entry.run))) {
        continue;
      }
      candidates.push(entry);
    }
    const blockers = await this.overlapBlockersOf(candidates, inFlight, thisOrder);
    return { blocked: blockers.runIds.length > 0 || blockers.attemptIds.length > 0, blockers };
  }

  /** Non-terminal runs holding a reservation for one of their attempts, excluding `excludeAttemptId`. */
  private async collectActiveRuns(
    runs: readonly LaneRunRecord[],
    heldByAttempt: ReadonlyMap<string, CapacityReservationRecord>,
    excludeAttemptId: string,
  ): Promise<ActiveRun[]> {
    const considered = runs.filter(
      (run) =>
        !run.attemptIds.includes(excludeAttemptId) &&
        run.attemptIds.some((attemptId) => heldByAttempt.has(attemptId)),
    );
    // One grouped journal read for every run holding a reservation (EX-3a);
    // infrastructure inlines the fallback the application helper implements.
    const entriesByRun = this.options.runJournal.listForRuns
      ? await this.options.runJournal.listForRuns(considered.map((run) => run.runId))
      : new Map(
          await Promise.all(
            considered.map(async (run) => [run.runId, await this.options.runJournal.listForRun(run.runId)] as const),
          ),
        );
    const active: ActiveRun[] = [];
    for (const run of considered) {
      const state = laneRunJournalState(entriesByRun.get(run.runId) ?? [], run.runId);
      if (!isTerminalRunState(state)) {
        active.push({ run, state });
      }
    }
    return active;
  }

  /** In-flight starts: held reservations whose attempt no run lists, with their work order id when readable. */
  private async collectInFlightReservations(
    heldReservations: readonly CapacityReservationRecord[],
    runs: readonly LaneRunRecord[],
    excludeAttemptId: string,
  ): Promise<InFlightReservation[]> {
    const inFlight: InFlightReservation[] = [];
    for (const reservation of heldReservations) {
      if (reservation.attemptId === excludeAttemptId) {
        continue;
      }
      const referenced = runs.some((run) => run.attemptIds.includes(reservation.attemptId));
      if (referenced) {
        continue;
      }
      const attempt = await this.options.attemptRepo.findAttemptById(reservation.attemptId);
      inFlight.push({ attemptId: reservation.attemptId, workOrderId: attempt?.workOrderId ?? null });
    }
    return inFlight;
  }

  /** Whether a parked run's PR has merged; fail closed otherwise (the run keeps blocking). */
  private async parkedPrMergedOf(run: LaneRunRecord): Promise<boolean> {
    if (run.prNumber === null || this.options.forgeRead === undefined) {
      return false;
    }
    try {
      const read = await this.options.forgeRead.readPullRequest({ ref: { kind: 'number', number: run.prNumber } });
      return read.outcome === 'found' && read.pullRequest.state === 'merged';
    } catch {
      return false;
    }
  }

  /** The runs and in-flight attempts whose work order overlaps `thisOrder`, sorted, deduped. */
  private async overlapBlockersOf(
    candidates: readonly ActiveRun[],
    inFlight: readonly InFlightReservation[],
    thisOrder: { readonly repository: string; readonly ownedPaths: readonly string[] },
  ): Promise<LaneRunAdmissionBlockers> {
    const sources: { readonly kind: 'run' | 'flight'; readonly id: string; readonly workOrderId: string | null }[] = [
      ...candidates.map((entry) => ({ kind: 'run' as const, id: entry.run.runId, workOrderId: entry.run.workOrderId })),
      ...inFlight.map((entry) => ({ kind: 'flight' as const, id: entry.attemptId, workOrderId: entry.workOrderId })),
    ];
    const orders = await Promise.all(
      sources.map((source) =>
        source.workOrderId === null
          ? Promise.resolve(null)
          : this.options.workOrderRepo.findWorkOrderById(source.workOrderId),
      ),
    );
    const runIds: string[] = [];
    const attemptIds: string[] = [];
    for (let index = 0; index < sources.length; index += 1) {
      const other = orders[index];
      if (other === null || laneRunOwnedPathsOverlap(other, thisOrder)) {
        if (sources[index].kind === 'run') {
          runIds.push(sources[index].id);
        } else {
          attemptIds.push(sources[index].id);
        }
      }
    }
    return { runIds: [...new Set(runIds)].sort((left, right) => left.localeCompare(right)), attemptIds: [...new Set(attemptIds)].sort((left, right) => left.localeCompare(right)) };
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
