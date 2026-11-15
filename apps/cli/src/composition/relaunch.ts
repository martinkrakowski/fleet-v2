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
}

export function composeReadOnlyRelaunch(input: ComposeReadOnlyRelaunchInput) {
  const { stateDir, workspace, runnerForAttempt, computeDigest } = input;

  const runRepo = new LaneRunRepositoryAdapter({ stateDir, readOnly: true });
  const attemptRepo = new AttemptRepositoryAdapter({ stateDir, readOnly: true });
  const workOrderRepo = new WorkOrderRepositoryAdapter({ stateDir, readOnly: true });
  const lanePlanRepo = new LanePlanRepositoryAdapter({ stateDir, readOnly: true });
  const halt = new ConductorHaltAdapter({ stateDir, readOnly: true });
  const driverLease = new ConductorDriverLeaseAdapter({ stateDir, readOnly: true });

  const inventoryRelaunch = new InventoryRelaunchUseCase({
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
