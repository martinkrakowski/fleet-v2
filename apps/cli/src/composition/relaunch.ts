/**
 * Relaunch composition (CO29a-ro): the ONE place `relaunch inventory` and
 * `relaunch plan` are built. Both commands are strictly read-only over the
 * runtime's state, so every state adapter they reach is constructed here with
 * `readOnly: true`: an unreadable state file is a read error (mapped to
 * `unknown`), never a quarantine write. The relaunch plan store is the only
 * writable dependency, and only `planRelaunch` holds it. No store instance
 * from the conductor or execution compositions is passed in; the inputs are
 * the state directory and the two read-only effects (worktree listing and the
 * runner status read).
 */
import { promises as fs } from 'node:fs';

import {
  AttemptRepositoryAdapter,
  ConductorDriverLeaseAdapter,
  ConductorHaltAdapter,
  InventoryRelaunchUseCase,
  LanePlanRepositoryAdapter,
  LaneRunRepositoryAdapter,
  PlanRelaunchUseCase,
  RelaunchPlanRepositoryAdapter,
  WorkOrderRepositoryAdapter,
  type RunnerForAttemptPort,
  type WorkspaceAdapter,
} from '@fleet/work-execution';

export interface ComposeReadOnlyRelaunchInput {
  /** Absent: every store is in memory and the process is disposable. */
  readonly stateDir?: string;
  /** Lists worktrees only (`git worktree list`); writes nothing locally. */
  readonly workspace: Pick<WorkspaceAdapter, 'listWorktrees'>;
  /** Resolves the runner whose `--status` read answers; writes nothing locally. */
  readonly runnerForAttempt: RunnerForAttemptPort;
  readonly computeDigest: (text: string) => string;
  /** The live clock for the plan's deadline check; defaults to the system clock. */
  readonly clock?: () => string;
  /** Whether the state directory existed, as a directory, before any adapter was composed; false refuses both commands. */
  readonly stateDirPresentAtStart?: boolean;
}

/**
 * Read-only probe for the state directory: true when none is configured (in-memory stores) or when
 * it exists and is a directory. A mistyped or unmounted path is never an empty installation, and
 * no relaunch command creates it.
 */
function stateAvailableProbe(
  stateDir: string | undefined,
  presentAtStart: boolean | undefined,
): (() => Promise<boolean>) | undefined {
  if (stateDir === undefined || stateDir.trim().length === 0) return undefined;
  return async () => {
    // Other adapters create the state directory while the runtime is built, so the answer taken
    // before anything was composed is the one that tells a mistyped path from an empty installation.
    if (presentAtStart === false) return false;
    try {
      return (await fs.stat(stateDir)).isDirectory();
    } catch {
      return false;
    }
  };
}

export function composeReadOnlyRelaunch(input: ComposeReadOnlyRelaunchInput) {
  const { stateDir, workspace, runnerForAttempt, computeDigest } = input;

  const runRepo = new LaneRunRepositoryAdapter({ stateDir, readOnly: true });
  const attemptRepo = new AttemptRepositoryAdapter({ stateDir, readOnly: true });
  const workOrderRepo = new WorkOrderRepositoryAdapter({ stateDir, readOnly: true });
  const lanePlanRepo = new LanePlanRepositoryAdapter({ stateDir, readOnly: true });
  const halt = new ConductorHaltAdapter({ stateDir, readOnly: true });
  const driverLease = new ConductorDriverLeaseAdapter({ stateDir, readOnly: true });

  const stateAvailable = stateAvailableProbe(stateDir, input.stateDirPresentAtStart);
  const inventoryRelaunch = new InventoryRelaunchUseCase({
    ...(stateAvailable === undefined ? {} : { stateAvailable }),
    runRepo,
    attemptRepo,
    workspace,
    halt,
    driverLease,
    runnerForAttempt,
    computeDigest,
  });

  // The ordered plan is stored once by digest (relaunch-plans.json): the plan
  // store is the one allowed write, and nothing else holds it.
  const relaunchPlanRepository = new RelaunchPlanRepositoryAdapter({ stateDir });
  const planRelaunch = new PlanRelaunchUseCase({
    ...(stateAvailable === undefined ? {} : { stateAvailable }),
    inventory: inventoryRelaunch,
    runRepo,
    attemptRepo,
    workOrderRepo,
    lanePlanRepo,
    planRepo: relaunchPlanRepository,
    computeDigest,
    clock: input.clock ?? (() => new Date().toISOString()),
  });

  return { inventoryRelaunch, planRelaunch, relaunchPlanRepository };
}
