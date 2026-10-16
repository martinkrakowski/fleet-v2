import {
  AcceptanceAssessmentAdapter,
  ActionAuthorizationAdapter,
  AttemptArtifactAdapter,
  AttemptRepositoryAdapter,
  BriefAuthoringAdapter,
  BriefKnowledgeAdapter,
  ExecutionJournalAdapter,
  ExecutionObservationAdapter,
  ExecutionRunnerAdapter,
  ForgeActionAdapter,
  WorkOrderRepositoryAdapter,
  WorkspaceAdapter,
  type AcceptanceAssessmentDelegate,
  type ActionAuthorizationDelegate,
  type BriefKnowledgeDelegate,
  type ExecutionObservationDelegate,
  type ForgeActionDelegate,
} from "@fleet/work-execution";
import type { FleetInstallation } from "@fleet/installation";
import {
  CollectAttemptArtifactsUseCase,
  DispatchAttemptUseCase,
  ExecuteAuthorizedForgeActionUseCase,
  InspectAttemptUseCase,
  InspectWorkOrderUseCase,
  PrepareBriefPackageUseCase,
  PrepareFixAttemptUseCase,
  ReconcileAttemptUseCase,
  RegisterWorkOrderUseCase,
  RequestAttemptAcceptanceUseCase,
  ReserveExecutionCapacityUseCase,
  StopAttemptUseCase,
} from "@fleet/work-execution/use-cases";

export interface WorkComposition {
  registerWorkOrder: RegisterWorkOrderUseCase;
  inspectWorkOrder: InspectWorkOrderUseCase;
  inspectAttempt: InspectAttemptUseCase;
  prepareBriefPackage: PrepareBriefPackageUseCase;
  reserveExecutionCapacity: ReserveExecutionCapacityUseCase;
  dispatchAttempt: DispatchAttemptUseCase;
  reconcileAttempt: ReconcileAttemptUseCase;
  stopAttempt: StopAttemptUseCase;
  collectAttemptArtifacts: CollectAttemptArtifactsUseCase;
  prepareFixAttempt: PrepareFixAttemptUseCase;
  requestAttemptAcceptance: RequestAttemptAcceptanceUseCase;
  executeAuthorizedForgeAction: ExecuteAuthorizedForgeActionUseCase;
}

export interface WorkCompositionOptions {
  readonly stateDir?: string;
  readonly installation?: FleetInstallation;
  /** Live runner subprocess configuration; environment is the fallback. */
  readonly runnerAgent?: string;
  readonly runnerModel?: string;
  readonly runnerVariant?: string;
  readonly runnerRemotePort?: number;
  readonly ocmRunBin?: string;
  readonly runnerRemoteHost?: string;
  /** SSH host alias holding the worktree when it is not on this host. */
  readonly worktreeSshHost?: string;
}

export interface ResolvedWorkRunnerSettings {
  readonly worktreeSshHost?: string;
  readonly runnerAgent?: string;
  readonly runnerModel?: string;
  readonly runnerVariant?: string;
  readonly runnerRemotePort?: number;
  readonly ocmRunBin?: string;
  readonly runnerRemoteHost?: string;
}

/**
 * Resolves runner and worktree host configuration.
 * Resolution precedence: options.<x> ?? installation.<x> ?? <env read>.
 */
export function resolveWorkRunnerSettings(
  options?: WorkCompositionOptions,
  installation?: FleetInstallation,
  env: Record<string, string | undefined> = process.env,
): ResolvedWorkRunnerSettings {
  const inst = options?.installation ?? installation;
  const parsedPort = env.OCM_REMOTE_PORT ? Number(env.OCM_REMOTE_PORT) : Number.NaN;
  return {
    worktreeSshHost:
      options?.worktreeSshHost ??
      inst?.worktree?.sshHost ??
      (env.FLEET_WORKTREE_SSH_HOST?.trim() || undefined),
    runnerAgent:
      options?.runnerAgent ??
      inst?.runner?.agent ??
      (env.FLEET_RUNNER_AGENT?.trim() || undefined),
    runnerModel:
      options?.runnerModel ??
      inst?.runner?.model ??
      (env.FLEET_RUNNER_MODEL?.trim() || undefined),
    runnerVariant:
      options?.runnerVariant ??
      inst?.runner?.variant ??
      (env.FLEET_RUNNER_VARIANT?.trim() || undefined),
    runnerRemotePort:
      options?.runnerRemotePort ??
      inst?.runner?.remotePort ??
      (Number.isFinite(parsedPort) ? parsedPort : undefined),
    ocmRunBin:
      options?.ocmRunBin ??
      inst?.runner?.ocmRunBin ??
      (env.FLEET_OCM_RUN_BIN?.trim() || undefined),
    runnerRemoteHost:
      options?.runnerRemoteHost ??
      inst?.runner?.host ??
      (env.OCM_HOST?.trim() || undefined),
  };
}

/**
 * Delegates for the cross-context adapters; the API runtime binds the real
 * supplier use cases, standalone configuration leaves the adapters refusing
 * until `configureFleetApiRuntime` wires them.
 */
export interface WorkCrossContextDelegates {
  readonly acceptance?: AcceptanceAssessmentDelegate;
  readonly briefKnowledge?: BriefKnowledgeDelegate;
  readonly authorization?: ActionAuthorizationDelegate;
  readonly observation?: ExecutionObservationDelegate;
  readonly forge?: ForgeActionDelegate;
  /** Accepted-receipt id per head; a merge without a receipt is refused. */
  readonly acceptedReceiptByHead?: Readonly<Record<string, string>>;
}

let current: WorkComposition | null = null;
let configured: WorkComposition | null = null;

function unconfiguredWorkComposition(): WorkComposition {
  return {
    registerWorkOrder: new RegisterWorkOrderUseCase(),
    inspectWorkOrder: new InspectWorkOrderUseCase(),
    inspectAttempt: new InspectAttemptUseCase(),
    prepareBriefPackage: new PrepareBriefPackageUseCase(),
    reserveExecutionCapacity: new ReserveExecutionCapacityUseCase(),
    dispatchAttempt: new DispatchAttemptUseCase(),
    reconcileAttempt: new ReconcileAttemptUseCase(),
    stopAttempt: new StopAttemptUseCase(),
    collectAttemptArtifacts: new CollectAttemptArtifactsUseCase(),
    prepareFixAttempt: new PrepareFixAttemptUseCase(),
    requestAttemptAcceptance: new RequestAttemptAcceptanceUseCase(),
    executeAuthorizedForgeAction: new ExecuteAuthorizedForgeActionUseCase(),
  };
}

export function workComposition(): WorkComposition {
  if (configured) {
    return configured;
  }
  current ??= unconfiguredWorkComposition();
  return current;
}

function isWorkComposition(
  value: WorkComposition | WorkCompositionOptions,
): value is WorkComposition {
  return typeof value === "object" && "registerWorkOrder" in value;
}

export function configureWorkComposition(
  custom: WorkComposition | WorkCompositionOptions | null,
): void {
  if (custom === null) {
    configured = null;
    current = null;
    return;
  }
  configured = isWorkComposition(custom)
    ? custom
    : createConfiguredWorkComposition(custom);
  current = null;
}

export function createConfiguredWorkComposition(
  options?: WorkCompositionOptions,
  crossContext?: WorkCrossContextDelegates,
): WorkComposition {
  const stateDir = options?.stateDir;

  const {
    worktreeSshHost,
    runnerAgent,
    runnerModel,
    runnerVariant,
    runnerRemotePort,
    ocmRunBin,
    runnerRemoteHost,
  } = resolveWorkRunnerSettings(options);

  const workOrderRepo = new WorkOrderRepositoryAdapter({ stateDir });
  const attemptRepo = new AttemptRepositoryAdapter({ stateDir });
  const journal = new ExecutionJournalAdapter({ stateDir });
  const briefAuthoring = new BriefAuthoringAdapter();
  const workspace = new WorkspaceAdapter({ sshHost: worktreeSshHost });
  const artifactPort = new AttemptArtifactAdapter({ sshHost: worktreeSshHost });
  // The worktree locator is resolved from the recorded attempt so a request
  // arriving in a later process addresses the same directory as its dispatch.
  const runner = new ExecutionRunnerAdapter({
    ocmRunBin,
    agent: runnerAgent,
    model: runnerModel,
    variant: runnerVariant,
    remotePort: runnerRemotePort,
    remoteHost: runnerRemoteHost,
    resolveWorktreePath: async (attemptId) =>
      (await attemptRepo.findAttemptById(attemptId))?.worktreePath ?? null,
    resolveAttempt: async (attemptId) =>
      await attemptRepo.findAttemptById(attemptId),
  });
  const acceptancePort = new AcceptanceAssessmentAdapter(crossContext?.acceptance);
  const briefKnowledge = new BriefKnowledgeAdapter(crossContext?.briefKnowledge);
  const authorizationPort = new ActionAuthorizationAdapter(crossContext?.authorization);
  const observation = new ExecutionObservationAdapter(crossContext?.observation);
  const forgePort = new ForgeActionAdapter(crossContext?.forge);

  return {
    registerWorkOrder: new RegisterWorkOrderUseCase({ workOrderRepo }),
    inspectWorkOrder: new InspectWorkOrderUseCase({ workOrderRepo, attemptRepo, journal }),
    inspectAttempt: new InspectAttemptUseCase({ attemptRepo }),
    prepareBriefPackage: new PrepareBriefPackageUseCase({
      briefAuthoring,
      artifactPort,
      briefKnowledge,
    }),
    reserveExecutionCapacity: new ReserveExecutionCapacityUseCase({ journal, attemptRepo }),
    dispatchAttempt: new DispatchAttemptUseCase({
      workOrderRepo,
      attemptRepo,
      journal,
      workspace,
      runner,
      observation,
      artifactPort,
    }),
    reconcileAttempt: new ReconcileAttemptUseCase({ attemptRepo, journal, runner }),
    stopAttempt: new StopAttemptUseCase({ attemptRepo, journal, runner }),
    collectAttemptArtifacts: new CollectAttemptArtifactsUseCase({
      attemptRepo,
      journal,
      artifactPort,
      briefKnowledge,
    }),
    prepareFixAttempt: new PrepareFixAttemptUseCase({ attemptRepo }),
    requestAttemptAcceptance: new RequestAttemptAcceptanceUseCase({
      attemptRepo,
      workOrderRepo,
      acceptancePort,
    }),
    executeAuthorizedForgeAction: new ExecuteAuthorizedForgeActionUseCase({
      attemptRepo,
      workOrderRepo,
      journal,
      authorizationPort,
      forgePort,
      acceptedReceiptByHead: crossContext?.acceptedReceiptByHead,
    }),
  };
}
