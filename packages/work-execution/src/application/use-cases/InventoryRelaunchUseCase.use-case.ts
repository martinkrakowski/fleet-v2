// @generated use-case scaffold — refined for lane CO26.
/**
 * InventoryRelaunchUseCase: the read-only relaunch inventory (cutover plan
 * CO26, §4 step 2). It reads the recorded lane runs and attempts, the
 * registered clones' worktree listings, the runner's state per worktree
 * directory and the conductor's status, and classifies every lane into one
 * of the three populations (conducted, attempt-recorded, unrecorded). Risk
 * flags are counts only; worktree paths appear in the local CLI output only.
 * It writes nothing, journals nothing and mutates no worktree. An unreadable
 * listing, a missing runner or a thrown read is reported `unknown` and
 * counted, never guessed (unknown is never true).
 */

import type { AttemptRecord, AttemptRunnerRecord } from '../../domain/execution-records.js';
import { isConductorHalted, isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import { isLeaseLapsed } from '../../domain/lane-run-lease.js';
import { pathUnderPrefix } from '../../domain/lane-diff-check.js';
import type {
  InventoryRelaunchPort,
  InventoryRelaunchRequest,
  InventoryRelaunchResult,
  RelaunchConductorStatus,
  RelaunchHostInventory,
  RelaunchLaneRow,
  RelaunchPopulation,
  RelaunchRiskFlag,
  RelaunchRunnerState,
} from '../ports/in/InventoryRelaunchPort.in-port.js';
import type { LaneRunRepositoryPort } from '../ports/out/LaneRunRepositoryPort.out-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { WorkspacePort } from '../ports/out/WorkspacePort.out-port.js';
import type { ConductorHaltPort } from '../ports/out/ConductorHaltPort.out-port.js';
import type { ConductorDriverLeasePort } from '../ports/out/ConductorDriverLeasePort.out-port.js';
import type { RunnerForAttemptPort } from '../ports/out/RunnerForAttemptPort.out-port.js';

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

/** A row under construction; the public row is produced after the runner state is known. */
interface InternalLaneRow {
  readonly population: RelaunchPopulation;
  readonly laneId: string;
  readonly hostName: string;
  readonly worktreePath: string;
  readonly runId: string | null;
  readonly attemptId: string | null;
  runnerState: RelaunchRunnerState;
}

/** UTF-16 code-unit order: identical to the default sort(), stated explicitly (Sonar S2871). */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The latest attempt of a group: the greatest createdAtIso, ties by the greater id. */
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
    if (!isZonedIsoDateTime(request.nowIso) || !Array.isArray(request.clones)) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }

    // 2. Read the records. A throwing read is not caught: it is a failure of
    //    the read, and the CLI reports it as an error (exit 1).
    const runs = await deps.runRepo.list();
    const attempts = await deps.attemptRepo.listAllAttempts();

    // 3. Map the attempts to runs.
    const runIdByAttemptId = new Map<string, string>();
    for (const run of runs) {
      for (const attemptId of run.attemptIds) {
        runIdByAttemptId.set(attemptId, run.runId);
      }
    }

    // 4. Group the attempts by worktree path; one row per recorded worktree.
    const attemptsByWorktree = new Map<string, AttemptRecord[]>();
    for (const attempt of attempts) {
      const group = attemptsByWorktree.get(attempt.worktreePath);
      if (group === undefined) {
        attemptsByWorktree.set(attempt.worktreePath, [attempt]);
      } else {
        group.push(attempt);
      }
    }
    const rows: InternalLaneRow[] = [];
    // 5. The recorded runner block per worktree directory; never in the result.
    const recordedBlocks = new Map<string, AttemptRunnerRecord | null>();
    for (const [worktreePath, group] of attemptsByWorktree) {
      const latest = latestAttempt(group);
      const conducted = group.some((attempt) => runIdByAttemptId.has(attempt.id));
      const runId = conducted ? (runIdByAttemptId.get(latest.id) ?? null) : null;
      const hostName =
        typeof latest.runner?.hostName === 'string' && latest.runner.hostName.trim() !== ''
          ? latest.runner.hostName
          : 'unknown-host';
      rows.push({
        population: conducted ? 'conducted' : 'attempt-recorded',
        laneId: conducted ? (runId ?? latest.id) : latest.id,
        hostName,
        worktreePath,
        runId,
        attemptId: latest.id,
        runnerState: 'unknown',
      });
      recordedBlocks.set(worktreePath, latest.runner ?? null);
    }

    // 6. Read the registered clones (D18: registered clones only, no host-wide scan).
    const hostClones = new Map<string, number>();
    const hostListed = new Map<string, number>();
    const hostUnknownListings = new Map<string, number>();
    for (const clone of request.clones) {
      if (request.hostName !== null && clone.hostName !== request.hostName) {
        continue;
      }
      hostClones.set(clone.hostName, (hostClones.get(clone.hostName) ?? 0) + 1);
      const listed = await deps.workspace.listWorktrees?.({
        repositoryRoot: clone.clonePath,
        recordedHost: clone.recordedHost ?? undefined,
      });
      if (listed === undefined || listed.outcome !== 'listed') {
        // An unreadable listing is counted and never throws, never guesses.
        hostUnknownListings.set(clone.hostName, (hostUnknownListings.get(clone.hostName) ?? 0) + 1);
        continue;
      }
      hostListed.set(clone.hostName, (hostListed.get(clone.hostName) ?? 0) + listed.worktrees.length);
      for (const entry of listed.worktrees) {
        // The clone's own main checkout is not a lane.
        if (entry.path === clone.clonePath) continue;
        // Only worktrees under the clone's worktree root count.
        if (!pathUnderPrefix(entry.path, clone.worktreeRoot)) continue;
        // Already recorded (conducted or attempt-recorded) worktrees are skipped.
        if (recordedBlocks.has(entry.path)) continue;
        rows.push({
          population: 'unrecorded',
          laneId: `worktree-${deps.computeDigest(entry.path).slice(0, 12)}`,
          hostName: clone.hostName,
          worktreePath: entry.path,
          runId: null,
          attemptId: null,
          runnerState: 'unknown',
        });
        recordedBlocks.set(entry.path, clone.recordedHost);
      }
    }

    // 7. Read the runner state per worktree directory; unknown when the runner
    //    cannot tell, refuses or throws.
    for (const row of rows) {
      const recordedBlock = recordedBlocks.get(row.worktreePath) ?? null;
      const selection = deps.runnerForAttempt?.runnerForAttempt({ runner: recordedBlock });
      if (selection === undefined || !selection.ok || selection.runner.inspectWorktreeRun === undefined) {
        continue;
      }
      try {
        const answer = await selection.runner.inspectWorktreeRun({
          attemptId: row.attemptId ?? '',
          worktreePath: row.worktreePath,
          runner: recordedBlock ?? undefined,
        });
        // The answer's state is idle, running or unknown — copy the worktree
        // run state union, never widen it.
        row.runnerState = answer.state;
      } catch {
        // A throwing inspect is unknown, never the end of the inventory.
      }
    }

    // 8. Group by host: one inventory per host name seen (rows and clones).
    const hostNames = new Set<string>();
    for (const clone of request.clones) {
      if (request.hostName !== null && clone.hostName !== request.hostName) continue;
      hostNames.add(clone.hostName);
    }
    for (const row of rows) {
      hostNames.add(row.hostName);
    }
    const hosts: RelaunchHostInventory[] = [];
    for (const hostName of [...hostNames].sort(byCodeUnit)) {
      const lanes = rows
        .filter((row) => row.hostName === hostName)
        .sort((left, right) => byCodeUnit(left.worktreePath, right.worktreePath));
      const conducted = lanes.filter((row) => row.population === 'conducted').length;
      const attemptRecorded = lanes.filter((row) => row.population === 'attempt-recorded').length;
      const unrecorded = lanes.filter((row) => row.population === 'unrecorded').length;
      const running = lanes.filter((row) => row.runnerState === 'running').length;
      const unknownListings = hostUnknownListings.get(hostName) ?? 0;
      // 9. Risk flags, counts only; omit a flag whose count is 0.
      const riskFlags: RelaunchRiskFlag[] = [];
      if (unrecorded > 0) riskFlags.push({ code: 'unrecorded-worktrees', count: unrecorded });
      if (running > 0) riskFlags.push({ code: 'running-worktrees', count: running });
      if (unknownListings > 0) riskFlags.push({ code: 'unknown-worktree-read', count: unknownListings });
      hosts.push({
        hostName,
        cloneCount: hostClones.get(hostName) ?? 0,
        worktreeCount: hostListed.get(hostName) ?? 0,
        counts: { conducted, attemptRecorded, unrecorded },
        riskFlags,
        lanes: lanes.map((row): RelaunchLaneRow => ({ ...row })),
      });
    }

    // 10. Conductor status.
    const haltState = await deps.halt.read();
    const halted = isConductorHalted(haltState);
    const lease = await deps.driverLease.read();
    const driverLease = lease === null ? 'absent' : isLeaseLapsed(lease, request.nowIso) ? 'lapsed' : 'live';
    const conductor: RelaunchConductorStatus = { halted, driverLease, runCount: runs.length };
    const riskFlags: RelaunchRiskFlag[] = [];
    if (halted) riskFlags.push({ code: 'conductor-halted', count: 1 });
    if (driverLease === 'live') riskFlags.push({ code: 'driver-lease-live', count: 1 });

    // 11. Return.
    return {
      outcome: 'inventoried',
      nowIso: request.nowIso,
      conductor,
      riskFlags,
      hosts,
    };
  }
}
