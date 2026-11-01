// Implemented for lane K7-5b (owner decision K7-D7, "Start reserves first").
/**
 * StartLaneRunUseCase: start a lane run in the owner's order — (1) reserve
 * capacity for the first attempt (global cap and package-busy first, then
 * the reserve, which chooses host and worktree path), (2) prepare the run's
 * worktree at the reserved path, (3) prepare and place the brief there,
 * (4) record the first attempt `intent-recorded`, (5) record the run. It
 * runs no model and dispatches nothing.
 *
 * Crash and refusal table (every row is tested in
 * `__tests__/start-lane-run.test.ts`):
 *
 * | Stopped after | What exists | A retry with the same ids | `abandonStart` | The reaper (K10/K11) |
 * |---|---|---|---|---|
 * | 1 reserve | a held reservation, its attempt absent | reuses the reservation, then 2–5 | releases it | `leaked-slot`, **report only** (§3.9.2: an absent attempt is never released by the reaper) |
 * | 2 worktree | + the worktree on `fleet/<runId>` at the base | `already-prepared`, then 3–5 | releases the reservation; the worktree stays | as above; the worktree is not removed (D15) |
 * | 3 brief | + the brief files in the worktree | prepares and places again (overwrite), then 4–5 | as above | as above |
 * | 4 attempt | + the `intent-recorded` attempt | keeps or updates the attempt, then 5 | cancels the attempt record-only, which releases the reservation | a prepared attempt no run names: reported; never dispatched (no run) |
 * | 5 run | the run | `started` | `refused run-exists` | — |
 *
 * Which releases a held reservation with no run: start's own retry (it
 * completes the run) or `abandonStart` (it releases). The reaper never
 * does: with this order a held reservation with an absent attempt is
 * exactly a start in progress, which the reaper cannot tell from a crashed
 * one. The prepare notes D7 are K6's and are not placed here.
 */

import { LANE_RUN_ID_PATTERN } from '../../domain/lane-run-records.js';
import type { LaneRunRecord } from '../../domain/lane-run-records.js';
import { resolveWorkOrderBaseBranch } from '../../domain/base-branch.js';
import { laneRunJournalState } from '../../domain/lane-run-journal.js';
import type { SeatHistoryEntry } from '../../domain/seat-selection.js';
import { selectSeat, seatMatchesAssignment, seatSelectionRecord } from '../../domain/seat-selection.js';
import { isCalendarDateTime } from '../../domain/plain-record-reads.js';
import { LANE_RUN_TERMINAL_STATES } from '../../domain/value-objects/LaneRunState.vo.js';
import type { LaneRunStateValue } from '../../domain/value-objects/LaneRunState.vo.js';
import type { AttemptStateValue } from '../../domain/value-objects/AttemptState.vo.js';
import { SeatPlan } from '../../domain/value-objects/SeatPlan.vo.js';
import { WorkOrderState } from '../../domain/value-objects/WorkOrderState.vo.js';
import type { AttemptRecord, AttemptRunnerRecord, CapacityReservationRecord } from '../../domain/execution-records.js';
import type {
  AbandonStartRequest,
  AbandonStartResult,
  StartLaneRunPort,
  StartLaneRunRefusal,
  StartLaneRunRequest,
  StartLaneRunResult,
  StartLaneRunStep,
} from '../ports/in/StartLaneRunPort.in-port.js';
import type { CancelPreparedAttemptPort } from '../ports/in/CancelPreparedAttemptPort.in-port.js';
import type { PrepareBriefPackagePort } from '../ports/in/PrepareBriefPackagePort.in-port.js';
import type { PrepareBriefPackageUseCaseRequest } from './PrepareBriefPackageUseCase.use-case.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../ports/out/ExecutionJournalPort.out-port.js';
import type { LaneRunJournalPort } from '../ports/out/LaneRunJournalPort.out-port.js';
import type { LaneRunRepositoryPort } from '../ports/out/LaneRunRepositoryPort.out-port.js';
import type { ProjectProfileReadPort } from '../ports/out/ProjectProfileReadPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../ports/out/WorkOrderRepositoryPort.out-port.js';
import type { WorkspacePort } from '../ports/out/WorkspacePort.out-port.js';
import { journalsForRuns } from './run-journal-reads.js';
import type {
  LaneRunStartCapacityPort,
} from '../ports/out/LaneRunStartCapacityPort.out-port.js';

export interface StartLaneRunDependencies {
  readonly workOrderRepo: Pick<WorkOrderRepositoryPort, 'findWorkOrderById'>;
  readonly profileRead: ProjectProfileReadPort;
  readonly capacity: LaneRunStartCapacityPort;
  readonly executionJournal: Pick<
    ExecutionJournalPort,
    'listActiveReservations' | 'releaseCapacityReservation'
  >;
  readonly workspace: Pick<WorkspacePort, 'prepareLaneWorktree'>;
  readonly prepareBrief: PrepareBriefPackagePort;
  readonly attemptRepo: AttemptRepositoryPort;
  readonly runRepo: Pick<LaneRunRepositoryPort, 'get' | 'create' | 'list'>;
  readonly runJournal: Pick<LaneRunJournalPort, 'listForRun' | 'listForRuns'>;
  readonly cancelPreparedAttempt: CancelPreparedAttemptPort;
  readonly computeDigest: (content: string) => string;
}

/** `attempt-` followed by a short, key-safe id; a ULID in production. */
const ATTEMPT_ID_PATTERN = /^attempt-[0-9A-Za-z][0-9A-Za-z-]{0,63}$/;

/** The run's worktree branch (K7-5b default under K7-D7): `fleet/<runId>`. */
function branchForRun(runId: string): string {
  return 'fleet/' + runId;
}

/** The fixed reason codes an `incomplete` may carry, never a host's text. */
export type StartLaneRunIncompleteReason =
  | 'worktree-path-exists-other'
  | 'worktree-branch-exists-other'
  | 'worktree-git-refused'
  | 'worktree-unknown'
  | 'no-clone-on-host'
  | 'brief-rejected'
  | 'attempt-differs'
  | 'attempt-save-failed'
  | 'run-exists'
  | 'reservation-incomplete'
  | 'attempt-incomplete';

const WORKTREE_REFUSAL_REASONS: Record<string, StartLaneRunIncompleteReason> = {
  'path-exists-other': 'worktree-path-exists-other',
  'branch-exists-other': 'worktree-branch-exists-other',
  'git-refused': 'worktree-git-refused',
  'invalid-request': 'worktree-unknown',
};

/**
 * The recorded host of one reservation (KF-8): the ssh alias decides the
 * transport, so an ssh host records its alias on `host` and a local host
 * records `null`; agy runs no port (D7).
 */
function recordedHostOf(reservation: {
  readonly hostKind: 'opencode' | 'agy';
  readonly hostName: string;
  readonly transport: 'local' | 'ssh';
  readonly sshAlias: string | null;
  readonly port: number | null;
}): AttemptRunnerRecord {
  return {
    kind: reservation.hostKind,
    hostName: reservation.hostName,
    host: reservation.transport === 'ssh' ? reservation.sshAlias : null,
    remotePort: reservation.hostKind === 'agy' ? null : reservation.port,
    agent: null,
    model: null,
    variant: null,
  };
}

function incomplete(
  runId: string,
  attemptId: string,
  step: StartLaneRunStep,
  reason: StartLaneRunIncompleteReason,
): StartLaneRunResult {
  return { outcome: 'incomplete', runId, attemptId, step, reason };
}

/** Non-terminal journal states of the runs the scan saw, excluding `excludeRunId`. */
async function activeJournalStatesOf(
  runs: readonly LaneRunRecord[],
  runJournal: StartLaneRunDependencies['runJournal'],
  excludeRunId: string,
): Promise<readonly { readonly runId: string; readonly state: LaneRunStateValue }[]> {
  const considered = runs.filter((run) => run.runId !== excludeRunId);
  const entriesByRun = await journalsForRuns(
    runJournal,
    considered.map((run) => run.runId),
  );
  return considered.map((run) => ({
    runId: run.runId,
    state: laneRunJournalState(entriesByRun.get(run.runId) ?? [], run.runId),
  }));
}

function isTerminalRunState(state: LaneRunStateValue): boolean {
  return (LANE_RUN_TERMINAL_STATES as readonly LaneRunStateValue[]).includes(state);
}

function attemptShapeError(request: StartLaneRunRequest): StartLaneRunRefusal | null {
  if (!LANE_RUN_ID_PATTERN.test(request.runId)) {
    return 'invalid-request';
  }
  if (typeof request.attemptId !== 'string' || !ATTEMPT_ID_PATTERN.test(request.attemptId)) {
    return 'invalid-request';
  }
  if (request.tier !== 1 && request.tier !== 2) {
    return 'invalid-request';
  }
  if (
    typeof request.runPolicyRevision !== 'string' ||
    request.runPolicyRevision.trim().length === 0
  ) {
    return 'invalid-request';
  }
  const brief: unknown = request.brief;
  if (typeof brief !== 'object' || brief === null || Array.isArray(brief)) {
    return 'invalid-request';
  }
  const workOrderId = (brief as { workOrderId?: unknown }).workOrderId;
  if (typeof workOrderId !== 'string' || workOrderId.trim().length === 0) {
    return 'invalid-request';
  }
  if (typeof request.nowIso !== 'string' || !isCalendarDateTime(request.nowIso)) {
    return 'invalid-request';
  }
  return null;
}

/** The lane's history is empty on a first pass: selection starts at seat 0. */
function firstPassSeatOf(plan: SeatPlan): { readonly ok: true; readonly seatIndex: number } | { readonly ok: false } {
  const selection = selectSeat({ plan, role: 'first-pass', history: [] as readonly SeatHistoryEntry[] });
  return selection.ok ? { ok: true, seatIndex: selection.seatIndex } : { ok: false };
}

export class StartLaneRunUseCase implements StartLaneRunPort {
  constructor(private readonly deps?: StartLaneRunDependencies) {}

  async startLaneRun(request: StartLaneRunRequest): Promise<StartLaneRunResult> {
    if (this.deps === undefined) {
      throw new Error('Not implemented: StartLaneRunUseCase');
    }
    const deps = this.deps;

    // Step 0: checks, no write.
    const shapeError = attemptShapeError(request);
    if (shapeError !== null) {
      return { outcome: 'refused', reason: shapeError };
    }
    const existingRun = await deps.runRepo.get(request.runId);
    if (existingRun !== null) {
      if (existingRun.attemptIds[0] === request.attemptId) {
        return this.startedAfterCompletion(request, existingRun);
      }
      return { outcome: 'refused', reason: 'run-exists' };
    }
    const workOrder = await deps.workOrderRepo.findWorkOrderById(request.brief.workOrderId);
    if (workOrder === null) {
      return { outcome: 'refused', reason: 'work-order-missing' };
    }
    const workOrderState = WorkOrderState.create(workOrder.state);
    if (workOrderState.value === undefined) {
      // Unreadable work-order state refuses exactly like a missing work order;
      // never proceed to reserve.
      return { outcome: 'refused', reason: 'work-order-missing' };
    }
    if (workOrderState.value.isTerminal()) {
      return { outcome: 'refused', reason: 'work-order-not-open' };
    }
    const otherRuns = await deps.runRepo.list();
    const otherStates = await activeJournalStatesOf(otherRuns, deps.runJournal, request.runId);
    const activeForWorkOrder = otherStates.some(
      (other) =>
        !isTerminalRunState(other.state) &&
        runsSameWorkOrder(otherRuns, other.runId, request.brief.workOrderId),
    );
    if (activeForWorkOrder) {
      return { outcome: 'refused', reason: 'run-active-for-work-order' };
    }
    const profile = await deps.profileRead.readProjectProfile(request.brief.projectId);
    if (profile === null || profile.status === 'retired') {
      return { outcome: 'refused', reason: 'project-not-active' };
    }
    if (request.brief.seatPlan === undefined) {
      return { outcome: 'refused', reason: 'no-seat-plan' };
    }
    const plan = SeatPlan.create(request.brief.seatPlan);
    const planValue = plan.success === true ? plan.value : undefined;
    if (planValue === undefined) {
      return { outcome: 'refused', reason: 'no-seat-plan' };
    }
    if (request.brief.acceptanceSpec === undefined) {
      return { outcome: 'refused', reason: 'no-acceptance-spec' };
    }
    // D7: a conducted run refuses a brief without frozen PR notes. They are
    // optional at prepare time (manual prepare works without them) but
    // required to start, exactly like the seat plan and the acceptance spec.
    if (request.brief.prNotes === undefined) {
      return { outcome: 'refused', reason: 'pr-notes-missing' };
    }
    const seat = firstPassSeatOf(planValue);
    if (!seat.ok) {
      return { outcome: 'refused', reason: 'no-first-pass-seat' };
    }
    // The model assignment must be the selected first-pass seat (K7-5b fix
    // round 2): any difference between the brief's frozen assignment (model,
    // seat tool, variant) and the seat selection chose is refused before any
    // write, exactly like a malformed request.
    const selectedSeat = planValue.getSeats('first-pass')[seat.seatIndex];
    if (
      selectedSeat === undefined ||
      !seatMatchesAssignment(selectedSeat, {
        model: request.brief.modelAssignment.model,
        tool: request.brief.modelAssignment.seatTool,
        variant: request.brief.modelAssignment.variant,
        agent: request.brief.modelAssignment.agent,
      })
    ) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }

    // An attempt that is no longer prepared is never re-reserved (K7-5b fix
    // round 2): a retry with the ids of a spent attempt (not
    // `intent-recorded`, or naming another work order) reports
    // `incomplete attempt attempt-differs` without reserving, preparing the
    // worktree or writing the brief.
    const attempt = await deps.attemptRepo.findAttemptById(request.attemptId);
    if (
      attempt !== null &&
      (attempt.state !== ('intent-recorded' satisfies AttemptStateValue) ||
        attempt.workOrderId !== request.brief.workOrderId)
    ) {
      return incomplete(request.runId, request.attemptId, 'attempt', 'attempt-differs');
    }

    // Step 1: reserve (a retry reuses the held reservation).
    const held = await this.heldReservationFor(request.attemptId);
    let hostName: string;
    let hostKind: 'opencode' | 'agy';
    let worktreePath: string;
    let transport: 'local' | 'ssh';
    let sshAlias: string | null;
    let port: number | null;
    if (held !== null && held.hostName != null && held.worktreePath != null && held.hostKind != null) {
      hostName = held.hostName;
      hostKind = held.hostKind;
      worktreePath = held.worktreePath;
      // KF-8: the reservation record carries the host's transport, alias and
      // port; a legacy record (fields absent) derives its transport from the
      // alias it carries.
      // A blank alias is no alias (the same trim the completeness check applies).
      transport = held.transport ?? (held.sshAlias?.trim() ? 'ssh' : 'local');
      sshAlias = held.sshAlias ?? null;
      port = held.port ?? null;
    } else if (held !== null) {
      // A held but incomplete reservation is released, never re-reserved over.
      // Both release outcomes report `incomplete reserve`: a confirmed release
      // lets the operator's retry start clean; an unconfirmed one keeps the run
      // absent and the abandon path can still release it later.
      await deps.executionJournal.releaseCapacityReservation(request.attemptId, request.nowIso);
      return incomplete(request.runId, request.attemptId, 'reserve', 'reservation-incomplete');
    } else {
      const reserved = await deps.capacity.reserveFirst({
        attemptId: request.attemptId,
        workOrderId: request.brief.workOrderId,
        seatTool: request.brief.modelAssignment.seatTool,
        nowIso: request.nowIso,
      });
      if (reserved.outcome === 'no-capacity') {
        return { outcome: 'no-capacity' };
      }
      if (reserved.outcome === 'refused') {
        // `reservation-incomplete` never reaches the caller as a start
        // refusal: the reserve released it, so nothing is held and the
        // caller may retry or choose another work order.
        const reason: StartLaneRunRefusal =
          reserved.reason === 'reservation-incomplete' ? 'reserve-refused' : reserved.reason;
        return { outcome: 'refused', reason };
      }
      hostName = reserved.hostName;
      hostKind = reserved.hostKind;
      worktreePath = reserved.worktreePath;
      transport = reserved.transport;
      sshAlias = reserved.sshAlias;
      port = reserved.port;
    }
    // KF-8: a blank alias is no alias (matching `confirmRecordedHost`'s
    // trim), and the incomplete check runs once after both branches: an ssh
    // reservation without an alias, or an opencode host without a port, can
    // never be confirmed against the installation (H9b2). Such a reservation
    // is released like any other incomplete reservation, never a null-host
    // record.
    sshAlias = sshAlias?.trim() || null;
    if (
      (transport === 'ssh' && sshAlias === null) ||
      (hostKind === 'opencode' && port === null)
    ) {
      await deps.executionJournal.releaseCapacityReservation(request.attemptId, request.nowIso);
      return incomplete(request.runId, request.attemptId, 'reserve', 'reservation-incomplete');
    }
    const reservation = { hostName, hostKind, worktreePath };
    const recordedHost = recordedHostOf({ hostKind, hostName, transport, sshAlias, port });

    // Step 2: worktree at the reserved path. Every non-success from here on
    // leaves the reservation held.
    const clone = profile.clones[hostName];
    if (clone === undefined) {
      return incomplete(request.runId, request.attemptId, 'worktree', 'no-clone-on-host');
    }
    const prepared = await deps.workspace.prepareLaneWorktree?.({
      clonePath: clone.path,
      worktreePath,
      branch: branchForRun(request.runId),
      baseCommit: workOrder.baseCommit,
      recordedHost,
    });
    if (prepared === undefined) {
      return incomplete(request.runId, request.attemptId, 'worktree', 'worktree-unknown');
    }
    if (prepared.outcome === 'unknown') {
      return incomplete(request.runId, request.attemptId, 'worktree', 'worktree-unknown');
    }
    if (prepared.outcome === 'refused') {
      const reason = WORKTREE_REFUSAL_REASONS[prepared.reason] ?? 'worktree-unknown';
      return incomplete(request.runId, request.attemptId, 'worktree', reason);
    }

    // Step 3: brief (a retry prepares and places again; the files are
    // overwritten and the digest recomputed, which is safe because no
    // attempt names a digest yet).
    const briefRequest: PrepareBriefPackageUseCaseRequest = {
      ...request.brief,
      attemptId: request.attemptId,
      worktreePath,
      // KF-8: the placement goes to the reservation's recorded host, so a
      // worktree on an ssh host writes its brief on that host.
      recordedHost,
    };
    const briefResult = await deps.prepareBrief.prepareBriefPackage(briefRequest);
    if (briefResult.outcome === 'rejected') {
      return incomplete(request.runId, request.attemptId, 'brief', 'brief-rejected');
    }
    const briefDigest = briefResult.prepared.briefDigest;
    const briefPackagePath = briefResult.prepared.prosePath;

    // Step 4: the first attempt, intent-recorded.
    const attemptSave = await this.saveFirstAttempt(
      request,
      workOrder.baseCommit,
      planValue,
      seat.seatIndex,
      reservation,
      briefDigest,
      briefPackagePath,
      recordedHost,
    );
    if (attemptSave !== null) {
      return attemptSave;
    }

    // Step 5: the run. A throwing store (a crash at this step) is read the
    // same way as a refusal: re-read; the run listing the attempt first is a
    // completed retry, anything else is `incomplete run run-exists`.
    let created: Awaited<ReturnType<typeof deps.runRepo.create>>;
    try {
      created = await deps.runRepo.create({
        version: 1,
        runId: request.runId,
        workOrderId: request.brief.workOrderId,
        tier: request.tier,
        seatPlanRef: deps.computeDigest(JSON.stringify(planValue.toJSON())),
        cursors: { 'first-pass': null, fix: null, review: null },
        round: 0,
        attemptIds: [request.attemptId],
        prNumber: null,
        parked: null,
        parkCount: 0,
        lease: null,
        revision: 1,
        runPolicyRevision: request.runPolicyRevision,
        branchName: branchForRun(request.runId),
        baseBranch: resolveWorkOrderBaseBranch(workOrder),
      });
    } catch {
      created = { outcome: 'refused', reason: 'run-exists' };
    }
    if (created.outcome !== 'saved') {
      const reread = await deps.runRepo.get(request.runId);
      if (reread !== null && reread.attemptIds[0] === request.attemptId) {
        return this.startedResult(request, reservation);
      }
      return incomplete(request.runId, request.attemptId, 'run', 'run-exists');
    }

    // Step 6: started.
    return this.startedResult(request, reservation);
  }

  async abandonStart(request: AbandonStartRequest): Promise<AbandonStartResult> {
    if (this.deps === undefined) {
      throw new Error('Not implemented: StartLaneRunUseCase');
    }
    const deps = this.deps;
    if (
      typeof request.runId !== 'string' ||
      !LANE_RUN_ID_PATTERN.test(request.runId) ||
      typeof request.attemptId !== 'string' ||
      request.attemptId.trim().length === 0 ||
      typeof request.nowIso !== 'string' ||
      !isCalendarDateTime(request.nowIso)
    ) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
    // A run exists: the start completed (or another driver completed it);
    // stop the run instead. The worktree and the brief stay (D15: nothing
    // removes a worktree; the reaper reports it under its kinds).
    const run = await deps.runRepo.get(request.runId);
    if (run !== null) {
      return { outcome: 'refused', reason: 'run-exists' };
    }
    const attempt = await deps.attemptRepo.findAttemptById(request.attemptId);
    if (attempt !== null) {
      if (attempt.state !== 'intent-recorded') {
        // Even a spent attempt's held reservation is released (K7-5b fix
        // round 2): abandon can always release, otherwise a cancelled or
        // completed attempt would leak its slot forever. The worktree the
        // attempt may name is never touched (D15: nothing removes a
        // worktree).
        const released = await deps.executionJournal.releaseCapacityReservation(
          request.attemptId,
          request.nowIso,
        );
        return {
          outcome: 'abandoned',
          capacity: released ? 'released' : 'none-held',
          attemptCancelled: false,
        };
      }
      const cancelled = await deps.cancelPreparedAttempt.cancelPreparedAttempt({
        attemptId: request.attemptId,
        nowIso: request.nowIso,
      });
      if (cancelled.outcome !== 'cancelled') {
        return { outcome: 'refused', reason: 'attempt-not-prepared' };
      }
      return { outcome: 'abandoned', capacity: cancelled.capacity, attemptCancelled: true };
    }
    const released = await deps.executionJournal.releaseCapacityReservation(
      request.attemptId,
      request.nowIso,
    );
    return {
      outcome: 'abandoned',
      capacity: released ? 'released' : 'none-held',
      attemptCancelled: false,
    };
  }

  /** A run already lists the attempt first: a retry after completion. */
  private async startedAfterCompletion(
    request: StartLaneRunRequest,
    run: LaneRunRecord,
  ): Promise<StartLaneRunResult> {
    const attempt = await this.deps!.attemptRepo.findAttemptById(request.attemptId);
    const held = await this.heldReservationFor(request.attemptId);
    const hostName = attempt?.runner?.hostName ?? held?.hostName ?? '';
    const worktreePath = attempt?.worktreePath ?? held?.worktreePath ?? '';
    if (hostName === '' || worktreePath === '') {
      // Neither the attempt's runner host nor a held reservation gives a host
      // and worktree path: incomplete, never `started` with an empty host or
      // path.
      return incomplete(request.runId, request.attemptId, 'attempt', 'attempt-incomplete');
    }
    return { outcome: 'started', runId: run.runId, attemptId: request.attemptId, hostName, worktreePath };
  }

  private startedResult(
    request: StartLaneRunRequest,
    reservation: { hostName: string; worktreePath: string },
  ): StartLaneRunResult {
    return {
      outcome: 'started',
      runId: request.runId,
      attemptId: request.attemptId,
      hostName: reservation.hostName,
      worktreePath: reservation.worktreePath,
    };
  }

  private async heldReservationFor(attemptId: string): Promise<CapacityReservationRecord | null> {
    const held = (await this.deps!.executionJournal.listActiveReservations()).find(
      (reservation) => reservation.attemptId === attemptId && reservation.held,
    );
    return held ?? null;
  }

  /**
   * Save the first attempt: a fresh `intent-recorded` record, or an existing
   * `intent-recorded` record at the same path and work order whose digest
   * and brief path are overwritten when they differ; any other record is
   * `attempt-differs`. The reservation's recorded host is stamped on the
   * attempt as `runner` (KF-10) so the first dispatch reads the frozen
   * manifest through that host before any runner is contacted. Returns null
   * on success.
   */
  private async saveFirstAttempt(
    request: StartLaneRunRequest,
    baseCommit: string,
    plan: SeatPlan,
    seatIndex: number,
    reservation: { hostName: string; hostKind: 'opencode' | 'agy'; worktreePath: string },
    briefDigest: string,
    briefPackagePath: string,
    recordedHost: AttemptRunnerRecord,
  ): Promise<StartLaneRunResult | null> {
    const deps = this.deps!;
    const selectedSeat = plan.getSeats('first-pass')[seatIndex];
    if (selectedSeat === undefined) {
      return incomplete(request.runId, request.attemptId, 'attempt', 'attempt-differs');
    }
    const existing = await deps.attemptRepo.findAttemptById(request.attemptId);
    if (existing !== null) {
      const sameIdentity =
        existing.state === ('intent-recorded' satisfies AttemptStateValue) &&
        existing.worktreePath === reservation.worktreePath &&
        existing.workOrderId === request.brief.workOrderId;
      if (!sameIdentity) {
        return incomplete(request.runId, request.attemptId, 'attempt', 'attempt-differs');
      }
      if (existing.briefDigest === briefDigest && existing.briefPackagePath === briefPackagePath) {
        // Same digest and path: nothing to rewrite unless the record has no
        // runner yet, in which case the recorded host is stamped (KF-10).
        if (existing.runner != null) {
          return null;
        }
        const stamped: AttemptRecord = {
          ...existing,
          revision: (existing.revision ?? 0) + 1,
          runner: recordedHost,
          updatedAtIso: request.nowIso,
        };
        try {
          await deps.attemptRepo.saveAttempt(stamped);
        } catch {
          return incomplete(request.runId, request.attemptId, 'attempt', 'attempt-save-failed');
        }
        return null;
      }
      const updated: AttemptRecord = {
        ...existing,
        revision: (existing.revision ?? 0) + 1,
        briefDigest,
        briefPackagePath,
        ...(existing.runner == null ? { runner: recordedHost } : {}),
        updatedAtIso: request.nowIso,
      };
      try {
        await deps.attemptRepo.saveAttempt(updated);
      } catch {
        return incomplete(request.runId, request.attemptId, 'attempt', 'attempt-save-failed');
      }
      return null;
    }
    const record: AttemptRecord = {
      id: request.attemptId,
      workOrderId: request.brief.workOrderId,
      kind: 'initial',
      fixNumber: 0,
      priorAttemptId: null,
      worktreePath: reservation.worktreePath,
      baseCommit,
      state: 'intent-recorded',
      outcome: null,
      briefDigest,
      briefPackagePath,
      sessionId: null,
      completionReceipt: null,
      artifacts: null,
      seatPlan: plan.toJSON(),
      seatSelection: seatSelectionRecord('first-pass', seatIndex, selectedSeat),
      // `reviewerSeat: null`: dispatch binds its fallback reviewer (K4-5).
      reviewerSeat: null,
      // The reservation's recorded host rides the first attempt as `runner`
      // (KF-10): the frozen-manifest reads before the first dispatch resolve
      // the reserved host instead of falling back to the local executor.
      runner: recordedHost,
      createdAtIso: request.nowIso,
      updatedAtIso: request.nowIso,
    };
    try {
      await deps.attemptRepo.saveAttempt(record);
    } catch {
      return incomplete(request.runId, request.attemptId, 'attempt', 'attempt-save-failed');
    }
    return null;
  }
}

/** Whether the run `runId` belongs to the work order `workOrderId`. */
function runsSameWorkOrder(
  runs: readonly LaneRunRecord[],
  runId: string,
  workOrderId: string,
): boolean {
  const run = runs.find((candidate) => candidate.runId === runId);
  return run !== undefined && run.workOrderId === workOrderId;
}
