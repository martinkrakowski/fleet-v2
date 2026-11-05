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
 * own session running there. A record proven not to own the path (another
 * branch, another session) is dropped; a claim nothing proves either way is
 * reported with `ownership: 'unknown'` and counted. A clone whose host is
 * absent from the installation routes no read and is counted as an unknown
 * listing, never read on the local executor.
 *
 * Risk flags are counts only; worktree paths appear in the local CLI output
 * only. It writes nothing, journals nothing and mutates no worktree, and it
 * never throws on a read: unreadable records refuse the inventory, an
 * unreadable listing, runner or lease is reported `unknown` and counted,
 * never guessed (unknown is never true).
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
  /** The claiming attempt's recorded session, used to prove or disprove the claim. */
  readonly claimSessionId: string | null;
  /** The runner block the runner-state read is routed by; never in the result. */
  readonly routing: AttemptRunnerRecord;
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
      for (const attemptId of run.attemptIds) {
        runByAttemptId.set(attemptId, run);
      }
    }
    const attemptsByWorktree = new Map<string, AttemptRecord[]>();
    for (const attempt of attempts) {
      const group = attemptsByWorktree.get(attempt.worktreePath);
      if (group === undefined) {
        attemptsByWorktree.set(attempt.worktreePath, [attempt]);
      } else {
        group.push(attempt);
      }
    }

    // 3. Read the registered clones (D18: registered clones only, no
    //    host-wide scan) of the requested host(s).
    const clones = request.clones.filter(
      (clone) => request.hostName === null || clone.hostName === request.hostName,
    );
    const hostClones = new Map<string, number>();
    const hostListed = new Map<string, number>();
    const hostUnknownListings = new Map<string, number>();
    const listedLanes: ListedLane[] = [];
    const seenLanes = new Set<string>();
    for (const clone of clones) {
      increment(hostClones, clone.hostName);
      const cloneHost = clone.recordedHost;
      if (cloneHost === null) {
        // The clone's host is absent from the installation: nothing routes the
        // read to that host, and a local fallback could inspect the wrong
        // repository. Report the listing as unknown instead.
        increment(hostUnknownListings, clone.hostName);
        continue;
      }
      const listed = await this.listClone(clone, cloneHost);
      if (listed === null) {
        increment(hostUnknownListings, clone.hostName);
        continue;
      }
      increment(hostListed, clone.hostName, listed.length);
      for (const entry of listed) {
        // The clone's own main checkout is not a lane; only worktrees under
        // the clone's worktree root count.
        if (entry.path === clone.clonePath || !pathUnderPrefix(entry.path, clone.worktreeRoot)) continue;
        const key = `${clone.hostName}\u0000${entry.path}`;
        if (seenLanes.has(key)) continue;
        seenLanes.add(key);
        listedLanes.push({ entry, hostName: clone.hostName, cloneHost });
      }
    }

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
    const hosts: RelaunchHostInventory[] = [];
    for (const hostName of [...hostNames].sort(byCodeUnit)) {
      const lanes = rows
        .filter((row) => row.hostName === hostName)
        .sort((left, right) => byCodeUnit(left.worktreePath, right.worktreePath));
      const conducted = lanes.filter((row) => row.population === 'conducted').length;
      const attemptRecorded = lanes.filter((row) => row.population === 'attempt-recorded').length;
      const unrecorded = lanes.filter((row) => row.population === 'unrecorded').length;
      const running = lanes.filter((row) => row.runnerState === 'running').length;
      const unproven = lanes.filter((row) => row.ownership === 'unknown').length;
      const unknownListings = hostUnknownListings.get(hostName) ?? 0;
      // Risk flags, counts only; omit a flag whose count is 0.
      const riskFlags: RelaunchRiskFlag[] = [];
      if (unrecorded > 0) riskFlags.push({ code: 'unrecorded-worktrees', count: unrecorded });
      if (running > 0) riskFlags.push({ code: 'running-worktrees', count: running });
      if (unknownListings > 0) riskFlags.push({ code: 'unknown-worktree-read', count: unknownListings });
      if (unproven > 0) riskFlags.push({ code: 'unproven-lane-records', count: unproven });
      hosts.push({
        hostName,
        cloneCount: hostClones.get(hostName) ?? 0,
        worktreeCount: hostListed.get(hostName) ?? 0,
        counts: { conducted, attemptRecorded, unrecorded },
        riskFlags,
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
      });
    }

    // 7. Conductor status. An unreadable halt marker reads as halted; an
    //    unreadable lease is unknown, never absent.
    const conductor = await this.readConductor(request.nowIso, runs.length);
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
    if (conducted.length > 0) {
      const branch = lane.entry.branch;
      if (branch === null) {
        // Detached: the branch proves nothing either way.
        return this.recordedRow(lane, latestAttempt(conducted), runByAttemptId, 'unknown');
      }
      const matching = conducted.filter((attempt) => {
        const run = runByAttemptId.get(attempt.id);
        return run !== undefined && branchOfRun(run) === branch;
      });
      if (matching.length > 0) {
        return this.recordedRow(lane, latestAttempt(matching), runByAttemptId, 'proven');
      }
      // Another branch is checked out: the conducted records are stale here.
    }
    const unrun = candidates.filter((attempt) => !runByAttemptId.has(attempt.id));
    if (unrun.length > 0) {
      return this.recordedRow(lane, latestAttempt(unrun), runByAttemptId, 'unknown');
    }
    return this.unrecordedRow(lane);
  }

  private recordedRow(
    lane: ListedLane,
    attempt: AttemptRecord,
    runByAttemptId: ReadonlyMap<string, LaneRunRecord>,
    ownership: RelaunchRecordOwnership,
  ): InternalLaneRow {
    // The run of the claiming attempt itself, never of another attempt.
    const run = runByAttemptId.get(attempt.id);
    // The attempt's own runner block routes the read only when it names the
    // host that listed the path; otherwise the clone's block does, so a
    // legacy record never falls back to the local executor.
    const routing = recordedHostName(attempt) === lane.hostName && attempt.runner ? attempt.runner : lane.cloneHost;
    return {
      population: run === undefined ? 'attempt-recorded' : 'conducted',
      laneId: run === undefined ? attempt.id : run.runId,
      hostName: lane.hostName,
      worktreePath: lane.entry.path,
      runId: run === undefined ? null : run.runId,
      attemptId: attempt.id,
      runnerState: 'unknown',
      ownership,
      claimSessionId: isNonBlankString(attempt.sessionId) ? attempt.sessionId : null,
      routing,
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
      claimSessionId: null,
      routing: lane.cloneHost,
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
    if (answer.state !== 'running' || row.ownership !== 'unknown' || row.claimSessionId === null) {
      return;
    }
    if (answer.sessionId === row.claimSessionId) {
      row.ownership = 'proven';
      return;
    }
    // Another session runs in the directory: the record is stale here, and
    // the running lane is one no record claims.
    row.population = 'unrecorded';
    row.laneId = this.unrecordedLaneId(row.worktreePath);
    row.runId = null;
    row.attemptId = null;
    row.ownership = 'none';
  }

  private async readConductor(nowIso: string, runCount: number): Promise<RelaunchConductorStatus> {
    const deps = this.deps;
    let halted = true;
    try {
      if (deps !== undefined) halted = isConductorHalted(await deps.halt.read());
    } catch {
      halted = true;
    }
    let driverLease: RelaunchConductorStatus['driverLease'] = 'unknown';
    try {
      if (deps !== undefined) {
        const lease = await deps.driverLease.read();
        driverLease = lease === null ? 'absent' : isLeaseLapsed(lease, nowIso) ? 'lapsed' : 'live';
      }
    } catch {
      driverLease = 'unknown';
    }
    return { halted, driverLease, runCount };
  }
}
