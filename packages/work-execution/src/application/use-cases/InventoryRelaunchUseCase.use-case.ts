// @generated use-case scaffold — refined for lane CO26.
/**
 * InventoryRelaunchUseCase: the read-only relaunch inventory (cutover plan
 * CO26, §4 step 2). It reads the recorded lane runs and attempts, the
 * registered clones' worktree listings, the runner's state per worktree
 * directory and the conductor's status, and classifies every listed lane
 * into one of the three populations (conducted, attempt-recorded,
 * unrecorded).
 *
 * The listing is the truth for what exists: a recorded attempt is a lane
 * only while its worktree appears in the current listing of a clone on the
 * attempt's own host, so a reaped worktree keeps no lane. A path match alone
 * never proves that a record owns the worktree, because a reaped path can be
 * reused: a conducted record is proven by the listed branch (`fleet/<runId>`
 * or the run's recorded branch), and any record by the runner reporting its
 * own session running there. A record disproved (another branch with no
 * own session running, or another session running) is dropped; a claim
 * nothing proves, or that the facts contradict (the run's branch checked
 * out with another session running), is reported with `ownership:
 * 'unknown'` and counted. A clone whose host is
 * absent from the installation routes no read and is counted as an unknown
 * listing, never read on the local executor.
 *
 * Risk flags are counts only; worktree paths appear in the local CLI output
 * only. It writes nothing, journals nothing and mutates no worktree, and it
 * never throws on a read: unreadable records refuse the inventory, an
 * unreadable listing, runner or lease is reported `unknown` and counted,
 * never guessed (unknown is never true). CO29a-ro2: an unreadable halt
 * marker or driver lease file makes the whole inventory answer `unknown`
 * with `halt-unreadable` / `lease-unreadable`, never a value.
 */

import type { AttemptRecord, AttemptRunnerRecord } from '../../domain/execution-records.js';
import type { LaneRunRecord } from '../../domain/lane-run-records.js';
import { isConductorHalted, isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import { isLeaseLapsed } from '../../domain/lane-run-lease.js';
import { pathUnderPrefix } from '../../domain/lane-diff-check.js';
import type {
  InventoryRelaunchPort,
  InventoryRelaunchRequest,
  InventoryRelaunchResult,
  RelaunchCloneRef,
  RelaunchConductorStatus,
  RelaunchHostInventory,
  RelaunchInventoryUnknownReason,
  RelaunchLaneRow,
  RelaunchPopulation,
  RelaunchRecordOwnership,
  RelaunchRiskFlag,
  RelaunchRunnerState,
} from '../ports/in/InventoryRelaunchPort.in-port.js';
import type { LaneRunRepositoryPort } from '../ports/out/LaneRunRepositoryPort.out-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { ListedWorktree, WorkspacePort } from '../ports/out/WorkspacePort.out-port.js';
import type { ConductorHaltPort } from '../ports/out/ConductorHaltPort.out-port.js';
import type { ConductorDriverLeasePort } from '../ports/out/ConductorDriverLeasePort.out-port.js';
import type { RunnerForAttemptPort } from '../ports/out/RunnerForAttemptPort.out-port.js';
import type { WorktreeRunState } from '../ports/out/ExecutionRunnerPort.out-port.js';

export interface InventoryRelaunchDependencies {
  readonly runRepo: Pick<LaneRunRepositoryPort, 'list'>;
  readonly attemptRepo: Pick<AttemptRepositoryPort, 'listAllAttempts'>;
  readonly workspace: Pick<WorkspacePort, 'listWorktrees'>;
  readonly halt: Pick<ConductorHaltPort, 'read'>;
  readonly driverLease: Pick<ConductorDriverLeasePort, 'read'>;
  readonly runnerForAttempt?: RunnerForAttemptPort;
  /** The digest used for an unrecorded worktree's lane id (12 hex of the path's digest). */
  readonly computeDigest: (text: string) => string;
}

/** One worktree a registered clone listed, on the host that listed it. */
interface ListedLane {
  readonly entry: ListedWorktree;
  readonly hostName: string;
  /** The clone's runner block: it routes reads to the host that listed the path. */
  readonly cloneHost: AttemptRunnerRecord;
}

/** A row under construction; the public row is produced after the runner state is known. */
interface InternalLaneRow {
  population: RelaunchPopulation;
  laneId: string;
  readonly hostName: string;
  readonly worktreePath: string;
  runId: string | null;
  attemptId: string | null;
  runnerState: RelaunchRunnerState;
  ownership: RelaunchRecordOwnership;
  /**
   * The recorded sessions of the claiming attempts (for a branch-proven
   * conducted row, every attempt of that run at this path), used to prove or
   * disprove the claim against the session the runner reports running.
   */
  readonly claimSessions: ReadonlySet<string>;
  /** The runner block the runner-state read is routed by; never in the result. */
  readonly routing: AttemptRunnerRecord;
  /**
   * Conducted attempts the listed branch disproved. The runner reporting one
   * of their own sessions running in the directory still proves that claim
   * (the direct fact wins over the branch).
   */
  readonly branchDisproved: readonly { readonly attempt: AttemptRecord; readonly run: LaneRunRecord }[];
}

/** UTF-16 code-unit order: identical to the default sort(), stated explicitly (Sonar S2871). */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The latest attempt of a non-empty group: the greatest createdAtIso, ties by the greater id. */
function latestAttempt(group: readonly AttemptRecord[]): AttemptRecord {
  let latest = group[0];
  for (let index = 1; index < group.length; index += 1) {
    const candidate = group[index];
    if (
      candidate.createdAtIso > latest.createdAtIso ||
      (candidate.createdAtIso === latest.createdAtIso && candidate.id > latest.id)
    ) {
      latest = candidate;
    }
  }
  return latest;
}

/** The attempt's recorded host name, or null when the record names none (legacy). */
function recordedHostName(attempt: AttemptRecord): string | null {
  const name = attempt.runner?.hostName;
  return typeof name === 'string' && name.trim() !== '' ? name : null;
}

/** The run's worktree branch: its recorded branch, else `fleet/<runId>` (K7-D7). */
function branchOfRun(run: LaneRunRecord): string {
  return typeof run.branchName === 'string' && run.branchName !== '' ? run.branchName : `fleet/${run.runId}`;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isValidClone(clone: unknown): clone is RelaunchCloneRef {
  if (clone === null || typeof clone !== 'object') return false;
  const ref = clone as Partial<RelaunchCloneRef>;
  return isNonBlankString(ref.hostName) && isNonBlankString(ref.clonePath) && isNonBlankString(ref.worktreeRoot);
}

function isValidRequest(request: InventoryRelaunchRequest | null | undefined): request is InventoryRelaunchRequest {
  if (request === null || typeof request !== 'object') return false;
  if (!isZonedIsoDateTime(request.nowIso)) return false;
  if (request.hostName !== null && !isNonBlankString(request.hostName)) return false;
  return Array.isArray(request.clones) && request.clones.every(isValidClone);
}

function increment(counts: Map<string, number>, key: string, by = 1): void {
  counts.set(key, (counts.get(key) ?? 0) + by);
}

/**
 * The typed unreadable state-file errors, recognised by their stable `name`
 * so the application layer stays free of infrastructure imports. A read-only
 * store read throws `StateFileUnreadableReadOnlyError`; a writable one throws
 * `StateFileUnreadableError` after quarantining.
 */
function isUnreadableStateError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'StateFileUnreadableError' || error.name === 'StateFileUnreadableReadOnlyError')
  );
}

/** The listing facts of the requested clones, per host. */
interface CloneListing {
  readonly lanes: readonly ListedLane[];
  readonly clones: ReadonlyMap<string, number>;
  readonly listed: ReadonlyMap<string, number>;
  readonly unknown: ReadonlyMap<string, number>;
}

function groupByWorktree(attempts: readonly AttemptRecord[]): Map<string, AttemptRecord[]> {
  const groups = new Map<string, AttemptRecord[]>();
  for (const attempt of attempts) {
    const group = groups.get(attempt.worktreePath);
    if (group === undefined) groups.set(attempt.worktreePath, [attempt]);
    else group.push(attempt);
  }
  return groups;
}

/** One host's inventory; risk flags are counts only, and a flag whose count is 0 is omitted. */
function hostInventory(
  hostName: string,
  rows: readonly InternalLaneRow[],
  listing: CloneListing,
): RelaunchHostInventory {
  const lanes = rows
    .filter((row) => row.hostName === hostName)
    .sort((left, right) => byCodeUnit(left.worktreePath, right.worktreePath));
  const count = (predicate: (row: InternalLaneRow) => boolean): number => lanes.filter(predicate).length;
  const conducted = count((row) => row.population === 'conducted');
  const attemptRecorded = count((row) => row.population === 'attempt-recorded');
  const unrecorded = count((row) => row.population === 'unrecorded');
  const flagCounts: readonly (readonly [RelaunchRiskFlag['code'], number])[] = [
    ['unrecorded-worktrees', unrecorded],
    ['running-worktrees', count((row) => row.runnerState === 'running')],
    ['unknown-worktree-read', listing.unknown.get(hostName) ?? 0],
    ['unproven-lane-records', count((row) => row.ownership === 'unknown')],
    ['unknown-runner-state', count((row) => row.runnerState === 'unknown')],
  ];
  return {
    hostName,
    cloneCount: listing.clones.get(hostName) ?? 0,
    worktreeCount: listing.listed.get(hostName) ?? 0,
    counts: { conducted, attemptRecorded, unrecorded },
    riskFlags: flagCounts.filter(([, n]) => n > 0).map(([code, n]) => ({ code, count: n })),
    lanes: lanes.map(
      (row): RelaunchLaneRow => ({
        population: row.population,
        laneId: row.laneId,
        hostName: row.hostName,
        worktreePath: row.worktreePath,
        runId: row.runId,
        attemptId: row.attemptId,
        runnerState: row.runnerState,
        ownership: row.ownership,
      }),
    ),
  };
}

export class InventoryRelaunchUseCase implements InventoryRelaunchPort {
  constructor(private readonly deps?: InventoryRelaunchDependencies) {}

  async execute(input: unknown): Promise<InventoryRelaunchResult> {
    if (!this.deps) {
      throw new Error('Not implemented: InventoryRelaunchUseCase');
    }
    const request = (input ?? {}) as InventoryRelaunchRequest;
    return this.inventoryRelaunch(request);
  }

  async inventoryRelaunch(request: InventoryRelaunchRequest): Promise<InventoryRelaunchResult> {
    if (!this.deps) {
      throw new Error('Not implemented: InventoryRelaunchUseCase');
    }
    const deps = this.deps;
    if (!isValidRequest(request)) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }

    // 1. Read the records. Without them no population can be told, so an
    //    unreadable store refuses the inventory instead of guessing every
    //    listed worktree unrecorded. Nothing is thrown out of the use case.
    let runs: readonly LaneRunRecord[];
    let attempts: readonly AttemptRecord[];
    try {
      runs = await deps.runRepo.list();
      attempts = await deps.attemptRepo.listAllAttempts();
    } catch {
      return { outcome: 'refused', reason: 'records-unreadable' };
    }

    // 2. Map the attempts to runs and group them by worktree path.
    const runByAttemptId = new Map<string, LaneRunRecord>();
    for (const run of runs) {
      for (const attemptId of run.attemptIds) runByAttemptId.set(attemptId, run);
    }
    const attemptsByWorktree = groupByWorktree(attempts);

    // 3. Read the registered clones (D18: registered clones only, no
    //    host-wide scan) of the requested host(s).
    const clones = request.clones.filter(
      (clone) => request.hostName === null || clone.hostName === request.hostName,
    );
    const listing = await this.readListings(clones);
    const listedLanes = listing.lanes;

    // 4. One row per listed lane, claimed by a record only where nothing
    //    disproves the claim.
    const rows = listedLanes.map((lane) =>
      this.classify(lane, attemptsByWorktree.get(lane.entry.path) ?? [], runByAttemptId),
    );

    // 5. Read the runner state per worktree directory; unknown when the runner
    //    cannot tell, refuses or throws. The record's own session running
    //    there proves its claim; another session running there disproves it.
    for (const row of rows) {
      await this.readRunnerState(row);
    }

    // 6. Group by host: one inventory per host of the requested clones.
    const hostNames = new Set<string>(clones.map((clone) => clone.hostName));
    const hosts = [...hostNames].sort(byCodeUnit).map((hostName) => hostInventory(hostName, rows, listing));

    // 7. Conductor status. An unreadable halt marker or driver lease is never
    //    a value (unknown is never true): the inventory answers `unknown`
    //    with the reason code instead of reporting halted or absent.
    const { conductor, unknownReasons } = await this.readConductor(request.nowIso, runs.length);
    if (unknownReasons.length > 0) {
      return { outcome: 'unknown', reasons: unknownReasons };
    }
    const riskFlags: RelaunchRiskFlag[] = [];
    if (conductor.halted) riskFlags.push({ code: 'conductor-halted', count: 1 });
    if (conductor.driverLease === 'live') riskFlags.push({ code: 'driver-lease-live', count: 1 });
    if (conductor.driverLease === 'unknown') riskFlags.push({ code: 'driver-lease-unknown', count: 1 });

    return {
      outcome: 'inventoried',
      nowIso: request.nowIso,
      conductor,
      riskFlags,
      hosts,
    };
  }

  /** Read every requested clone's listing; a clone whose host is absent from the installation is never read. */
  private async readListings(clones: readonly RelaunchCloneRef[]): Promise<CloneListing> {
    const cloneCounts = new Map<string, number>();
    const listedCounts = new Map<string, number>();
    const unknownCounts = new Map<string, number>();
    const lanes: ListedLane[] = [];
    const seen = new Set<string>();
    for (const clone of clones) {
      increment(cloneCounts, clone.hostName);
      // A null host block means the host is absent from the installation:
      // nothing routes the read there, and a local fallback could inspect
      // the wrong repository, so the listing is unknown.
      const cloneHost = clone.recordedHost;
      const listed = cloneHost === null ? null : await this.listClone(clone, cloneHost);
      if (cloneHost === null || listed === null) {
        increment(unknownCounts, clone.hostName);
        continue;
      }
      increment(listedCounts, clone.hostName, listed.length);
      for (const entry of listed) {
        // The clone's own main checkout is not a lane; only worktrees under
        // the clone's worktree root count.
        const key = `${clone.hostName}\u0000${entry.path}`;
        if (entry.path === clone.clonePath || !pathUnderPrefix(entry.path, clone.worktreeRoot) || seen.has(key)) {
          continue;
        }
        seen.add(key);
        lanes.push({ entry, hostName: clone.hostName, cloneHost });
      }
    }
    return { lanes, clones: cloneCounts, listed: listedCounts, unknown: unknownCounts };
  }

  /** One clone's listing, or null when it is unknown (missing method, unknown answer or a throw). */
  private async listClone(
    clone: RelaunchCloneRef,
    cloneHost: AttemptRunnerRecord,
  ): Promise<readonly ListedWorktree[] | null> {
    const workspace = this.deps?.workspace;
    if (workspace?.listWorktrees === undefined) return null;
    try {
      const listed = await workspace.listWorktrees({ repositoryRoot: clone.clonePath, recordedHost: cloneHost });
      return listed.outcome === 'listed' ? listed.worktrees : null;
    } catch {
      return null;
    }
  }

  /**
   * Classify one listed lane. An attempt recorded on another host never
   * claims it (the same path on another host is another worktree). A
   * conducted claim is proven by the listed branch; a listed branch that is
   * no claiming run's branch disproves every conducted claim. An attempt
   * with no run is only a claim until the runner proves it.
   */
  private classify(
    lane: ListedLane,
    group: readonly AttemptRecord[],
    runByAttemptId: ReadonlyMap<string, LaneRunRecord>,
  ): InternalLaneRow {
    const candidates = group.filter((attempt) => {
      const host = recordedHostName(attempt);
      return host === null || host === lane.hostName;
    });
    const conducted = candidates.filter((attempt) => runByAttemptId.has(attempt.id));
    let branchDisproved: InternalLaneRow['branchDisproved'] = [];
    if (conducted.length > 0) {
      const branch = lane.entry.branch;
      if (branch === null) {
        // Detached: the branch proves nothing either way.
        return this.recordedRow(lane, conducted, runByAttemptId, 'unknown');
      }
      const matching = conducted.filter((attempt) => {
        const run = runByAttemptId.get(attempt.id);
        return run !== undefined && branchOfRun(run) === branch;
      });
      if (matching.length > 0) {
        return this.recordedRow(lane, matching, runByAttemptId, 'proven');
      }
      // Another branch is checked out: the conducted records are stale here
      // unless the runner later reports one of their own sessions running.
      branchDisproved = conducted.flatMap((attempt) => {
        const run = runByAttemptId.get(attempt.id);
        return run === undefined ? [] : [{ attempt, run }];
      });
    }
    const unrun = candidates.filter((attempt) => !runByAttemptId.has(attempt.id));
    const row =
      unrun.length > 0
        ? this.recordedRow(lane, unrun, runByAttemptId, 'unknown')
        : this.unrecordedRow(lane);
    return { ...row, branchDisproved };
  }

  /** The row of the latest claiming attempt; `claims` is non-empty and shares one population. */
  private recordedRow(
    lane: ListedLane,
    claims: readonly AttemptRecord[],
    runByAttemptId: ReadonlyMap<string, LaneRunRecord>,
    ownership: RelaunchRecordOwnership,
  ): InternalLaneRow {
    const attempt = latestAttempt(claims);
    // The run of the claiming attempt itself, never of another attempt.
    const run = runByAttemptId.get(attempt.id);
    // The attempt's own runner block routes the read only when it names the
    // host that listed the path; otherwise the clone's block does, so a
    // legacy record never falls back to the local executor.
    const routing = recordedHostName(attempt) === lane.hostName && attempt.runner ? attempt.runner : lane.cloneHost;
    // A branch-proven run claims with all its attempts here; any other claim
    // is the latest attempt alone.
    const sessionOwners = ownership === 'proven' ? claims : [attempt];
    const claimSessions = new Set(
      sessionOwners.map((claim) => claim.sessionId).filter((id): id is string => isNonBlankString(id)),
    );
    return {
      population: run === undefined ? 'attempt-recorded' : 'conducted',
      laneId: run === undefined ? attempt.id : run.runId,
      hostName: lane.hostName,
      worktreePath: lane.entry.path,
      runId: run === undefined ? null : run.runId,
      attemptId: attempt.id,
      runnerState: 'unknown',
      ownership,
      claimSessions,
      routing,
      branchDisproved: [],
    };
  }

  private unrecordedRow(lane: ListedLane): InternalLaneRow {
    return {
      population: 'unrecorded',
      laneId: this.unrecordedLaneId(lane.entry.path),
      hostName: lane.hostName,
      worktreePath: lane.entry.path,
      runId: null,
      attemptId: null,
      runnerState: 'unknown',
      ownership: 'none',
      claimSessions: new Set<string>(),
      routing: lane.cloneHost,
      branchDisproved: [],
    };
  }

  private unrecordedLaneId(path: string): string {
    return `worktree-${this.deps?.computeDigest(path).slice(0, 12) ?? ''}`;
  }

  private async readRunnerState(row: InternalLaneRow): Promise<void> {
    let answer: WorktreeRunState;
    try {
      const selection = this.deps?.runnerForAttempt?.runnerForAttempt({ runner: row.routing });
      if (selection === undefined || !selection.ok || selection.runner.inspectWorktreeRun === undefined) {
        return;
      }
      answer = await selection.runner.inspectWorktreeRun({
        attemptId: row.attemptId ?? '',
        worktreePath: row.worktreePath,
        runner: row.routing,
      });
    } catch {
      // A throwing runner is unknown, never the end of the inventory.
      return;
    }
    // Copy the worktree run state union, never widen it.
    row.runnerState = answer.state;
    if (answer.state === 'running') this.applyRunningSession(row, answer.sessionId);
  }

  /**
   * The session running in the directory is the direct fact: it proves the
   * claim whose own session it is, reclaims a conducted claim the branch
   * disproved, and otherwise contradicts the row's claim. A contradicted
   * claim with a recorded session is stale and the lane is unrecorded; a
   * branch-proven claim that is contradicted is reported unknown, never
   * dropped, because the run's branch is still checked out there.
   */
  private applyRunningSession(row: InternalLaneRow, runningSession: string): void {
    if (row.claimSessions.has(runningSession)) {
      row.ownership = 'proven';
      return;
    }
    const reclaimed = row.branchDisproved.filter(({ attempt }) => attempt.sessionId === runningSession);
    if (isNonBlankString(runningSession) && reclaimed.length > 0) {
      const attempt = latestAttempt(reclaimed.map((claim) => claim.attempt));
      const runId = reclaimed.find((claim) => claim.attempt.id === attempt.id)?.run.runId ?? null;
      if (runId !== null) {
        row.population = 'conducted';
        row.laneId = runId;
        row.runId = runId;
        row.attemptId = attempt.id;
        row.ownership = 'proven';
        return;
      }
    }
    if (row.ownership === 'proven') {
      row.ownership = 'unknown';
      return;
    }
    if (row.ownership !== 'unknown' || row.claimSessions.size === 0) return;
    row.population = 'unrecorded';
    row.laneId = this.unrecordedLaneId(row.worktreePath);
    row.runId = null;
    row.attemptId = null;
    row.ownership = 'none';
  }

  private async readConductor(
    nowIso: string,
    runCount: number,
  ): Promise<{ conductor: RelaunchConductorStatus; unknownReasons: RelaunchInventoryUnknownReason[] }> {
    const deps = this.deps;
    const unknownReasons: RelaunchInventoryUnknownReason[] = [];
    let halted = true;
    try {
      if (deps !== undefined) {
        const state = await deps.halt.read();
        halted = isConductorHalted(state);
        if (state.state === 'unreadable') unknownReasons.push('halt-unreadable');
      }
    } catch {
      halted = true;
    }
    let driverLease: RelaunchConductorStatus['driverLease'] = 'unknown';
    try {
      if (deps !== undefined) {
        const lease = await deps.driverLease.read();
        driverLease = lease === null ? 'absent' : isLeaseLapsed(lease, nowIso) ? 'lapsed' : 'live';
      }
    } catch (error: unknown) {
      driverLease = 'unknown';
      if (isUnreadableStateError(error)) unknownReasons.push('lease-unreadable');
    }
    return { conductor: { halted, driverLease, runCount }, unknownReasons };
  }
}
