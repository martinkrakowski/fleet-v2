import {
  AcceptanceAssessmentAdapter,
  AcceptanceEvidenceAdapter,
  ActionAuthorizationAdapter,
  AttemptArtifactAdapter,
  AttemptRepositoryAdapter,
  BriefAuthoringAdapter,
  BriefKnowledgeAdapter,
  ExecutionJournalAdapter,
  ExecutionObservationAdapter,
  ExecutionRunnerAdapter,
  ForgeActionAdapter,
  OwnerDecisionAdapter,
  AttemptOwnerDecisionAdapter,
  WorkOrderRepositoryAdapter,
  WorkspaceAdapter,
  resolveRoleExecutors,
  type AcceptanceAssessmentDelegate,
  type AcceptanceEvidenceDelegate,
  type ActionAuthorizationDelegate,
  type BriefKnowledgeDelegate,
  type ExecutionObservationDelegate,
  type ForgeActionDelegate,
  type OwnerDecisionDelegate,
  type AttemptOwnerDecisionDelegate,
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
  resolveImplementerSeat,
  type ImplementerSeatResolution,
} from "@fleet/work-execution/use-cases";

/**
 * Reads the seat an attempt was actually implemented on. Absent on a
 * composition that never bound one; a boundary that needs the seat then
 * refuses rather than accepting a caller-supplied model.
 */
export type AttemptImplementerSeatResolver = (
  attemptId: string,
) => Promise<ImplementerSeatResolution>;

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
  /** The attempt's recorded implementer seat; never an operator value. */
  readonly resolveAttemptImplementerSeat?: AttemptImplementerSeatResolver;
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
  readonly acceptanceEvidence?: AcceptanceEvidenceDelegate;
  readonly ownerDecision?: OwnerDecisionDelegate;
  readonly attemptOwnerDecision?: AttemptOwnerDecisionDelegate;
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
    // Unconfigured resolves no seat, and says so the same way the use cases
    // do: the HTTP boundary reports 501 instead of inventing a model.
    resolveAttemptImplementerSeat: async () => {
      throw new Error("Not implemented: AttemptImplementerSeatResolver");
    },
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
    runnerRemotePort,
    ocmRunBin,
    runnerRemoteHost,
  } = resolveWorkRunnerSettings(options);

  // One executor per role: the installation's hosts (v2) or the v1 mapping
  // decides local versus ssh per host; the orchestrator runs where this root
  // runs. runnerRemoteHost/ocmRunBin stay runner settings, separate from the
  // worktree executor's host.
  const roleExecutors = resolveRoleExecutors(options?.installation, {
    worktreeSshHost,
  });

  const workOrderRepo = new WorkOrderRepositoryAdapter({ stateDir });
  const attemptRepo = new AttemptRepositoryAdapter({ stateDir });
  const journal = new ExecutionJournalAdapter({ stateDir });
  const briefAuthoring = new BriefAuthoringAdapter();
  const workspace = new WorkspaceAdapter({ executor: roleExecutors.worktree });
  const artifactPort = new AttemptArtifactAdapter({ executor: roleExecutors.worktree });
  // The worktree locator is resolved from the recorded attempt so a request
  // arriving in a later process addresses the same directory as its dispatch.
  const runner = new ExecutionRunnerAdapter({
    ocmRunBin,
    remotePort: runnerRemotePort,
    remoteHost: runnerRemoteHost,
    executor: roleExecutors.orchestrator,
    resolveWorktreePath: async (attemptId) =>
      (await attemptRepo.findAttemptById(attemptId))?.worktreePath ?? null,
    resolveAttempt: async (attemptId) =>
      await attemptRepo.findAttemptById(attemptId),
  });
  const acceptancePort = new AcceptanceAssessmentAdapter(crossContext?.acceptance);
  const acceptanceEvidencePort = new AcceptanceEvidenceAdapter(crossContext?.acceptanceEvidence);
  const briefKnowledge = new BriefKnowledgeAdapter(crossContext?.briefKnowledge);
  const authorizationPort = new ActionAuthorizationAdapter(crossContext?.authorization);
  const observation = new ExecutionObservationAdapter(crossContext?.observation);
  const forgePort = new ForgeActionAdapter(crossContext?.forge);
  const ownerDecisionPort = new OwnerDecisionAdapter(crossContext?.ownerDecision);
  const attemptOwnerDecisionPort = new AttemptOwnerDecisionAdapter(
    crossContext?.attemptOwnerDecision,
  );

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
      artifactPort,
    }),
    executeAuthorizedForgeAction: new ExecuteAuthorizedForgeActionUseCase({
      attemptRepo,
      workOrderRepo,
      journal,
      authorizationPort,
      forgePort,
      acceptedReceiptByHead: crossContext?.acceptedReceiptByHead,
      acceptanceEvidencePort,
      // Forge actions re-check the attempt's one-way doors through the same
      // owner-decision resolution acceptance uses.
      ownerDecisionPort,
      attemptOwnerDecisionPort,
    }),
    // Independence is a fact about the lane, so any boundary that needs the
    // implementer seat reads it from the recorded attempt, never from the
    // request it is answering.
    resolveAttemptImplementerSeat: async (attemptId: string) => {
      const attempt = await attemptRepo.findAttemptById(attemptId);
      if (attempt === null) {
        return { outcome: "unknown", reason: `Attempt not found: '${attemptId}'` };
      }
      return resolveImplementerSeat(attempt, { artifactPort });
    },
  };
}
