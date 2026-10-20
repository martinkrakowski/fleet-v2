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
  RunnerForAttemptAdapter,
  WorkOrderRepositoryAdapter,
  WorkspaceAdapter,
  ExecutorForHost,
  resolveExecutionRunnerHost,
  resolveInstallationForgeMode,
  resolveRoleExecutors,
  resolveRunnerCapabilityProfile,
  type AcceptanceAssessmentDelegate,
  type AcceptanceEvidenceDelegate,
  type ActionAuthorizationDelegate,
  type BriefKnowledgeDelegate,
  type ExecutionObservationDelegate,
  type ExecutionRunnerHost,
  type ForgeActionDelegate,
  type OwnerDecisionDelegate,
  type AttemptOwnerDecisionDelegate,
} from "@fleet/work-execution";
import { requireValidInstallationModel, type FleetInstallation } from "@fleet/installation";
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
  /** The parsed installation the composition was configured with, if any. */
  readonly installation?: FleetInstallation;
  /**
   * The installation's selected lane-runner host (v2 mode); undefined for
   * a v1 or absent installation, which keeps the adapter in legacy mode.
   */
  readonly runnerHost?: ExecutionRunnerHost;
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
 *
 * A v2 installation's own hosts section is the only routing source (plan
 * section 3, "Runtime reads the selected host, never the environment"): the
 * environment variables that redirect a legacy run (`OCM_REMOTE_PORT`,
 * `OCM_HOST`, `FLEET_WORKTREE_SSH_HOST`, `FLEET_RUNNER_*`) are ignored, the
 * `worktreeSshHost` override is dropped, and only the ocm-run binary path
 * (`FLEET_OCM_RUN_BIN`) stays environmental. The selected lane-runner host is
 * passed to the runner adapter separately through `resolveExecutionRunnerHost`.
 * A v1 or absent installation keeps today's behaviour byte-for-byte.
 */
export function resolveWorkRunnerSettings(
  options?: WorkCompositionOptions,
  installation?: FleetInstallation,
  env: Record<string, string | undefined> = process.env,
): ResolvedWorkRunnerSettings {
  const inst = options?.installation ?? installation;
  if (inst?.schemaVersion === 2) {
    return {
      ocmRunBin:
        options?.ocmRunBin ??
        inst?.runner?.ocmRunBin ??
        (env.FLEET_OCM_RUN_BIN?.trim() || undefined),
    };
  }
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

  // an invalid installation throws here, never runs
  const installationModel = options?.installation
    ? requireValidInstallationModel(options.installation)
    : undefined;
  const runnerProfile = resolveRunnerCapabilityProfile(installationModel?.hosts);
  const forgeMode = resolveInstallationForgeMode(options?.installation);
  // The installation's selected lane-runner host (v2): its presence routes the
  // runner from the host entry and ignores the routing environment (plan
  // section 3). Undefined for v1 and absent installations keeps legacy mode.
  const runnerHost = resolveExecutionRunnerHost(options?.installation);
  // One executor per role: the installation's hosts (v2) or the v1 mapping
  // decides local versus ssh per host; the orchestrator runs where this root
  // runs. runnerRemoteHost/ocmRunBin stay runner settings, separate from the
  // worktree executor's host. For v2 the worktreeSshHost override is never
  // set (resolveWorkRunnerSettings drops it), so the hosts section decides.
  const roleExecutors = resolveRoleExecutors(options?.installation, {
    worktreeSshHost,
  });

  const workOrderRepo = new WorkOrderRepositoryAdapter({ stateDir });
  const attemptRepo = new AttemptRepositoryAdapter({ stateDir });
  const journal = new ExecutionJournalAdapter({ stateDir });
  const briefAuthoring = new BriefAuthoringAdapter();
  // H9b2: workspace and artifact reads for an attempt recorded on a named
  // host run through that recorded host's executor (the recorded host is the
  // truth); legacy records keep the worktree-role executor exactly as before.
  const executorForHost = new ExecutorForHost({
    hosts: options?.installation?.hosts,
    legacyExecutor: roleExecutors.worktree,
  });
  const workspace = new WorkspaceAdapter({
    executor: roleExecutors.worktree,
    executorForRecordedHost: (recorded) => executorForHost.executorForRecordedHost(recorded),
  });
  const artifactPort = new AttemptArtifactAdapter({
    executor: roleExecutors.worktree,
    executorForRecordedHost: (recorded) => executorForHost.executorForRecordedHost(recorded),
  });
  // The worktree locator is resolved from the recorded attempt so a request
  // arriving in a later process addresses the same directory as its dispatch.
  const runner = new ExecutionRunnerAdapter({
    ocmRunBin,
    remotePort: runnerRemotePort,
    remoteHost: runnerRemoteHost,
    // A v2 installation routes the runner from its selected lane-runner host;
    // the host's presence switches the adapter to v2 mode (no env fallbacks,
    // OCM_HOST/OCM_REMOTE_PORT/OPENCODE_AUTH_FILE set from the host alone).
    ...(runnerHost !== undefined ? { host: runnerHost } : {}),
    executor: roleExecutors.orchestrator,
    // The capability report comes from the installation's lane-runner entry
    // with the loader-derived source (D4); the transport trims the runner
    // environment on a single machine (D5).
    ...(runnerProfile !== undefined ? { capabilities: runnerProfile.capabilities } : {}),
    ...(runnerProfile !== undefined ? { runnerTransport: runnerProfile.transport } : {}),
    resolveWorktreePath: async (attemptId) =>
      (await attemptRepo.findAttemptById(attemptId))?.worktreePath ?? null,
    resolveAttempt: async (attemptId) =>
      await attemptRepo.findAttemptById(attemptId),
  });
  // H9b1: inspect, reconcile, stop and collect act through the attempt's
  // recorded host. One adapter per host name is built and cached from the
  // installation's hosts with the same options as the single runner above;
  // legacy attempts (no recorded hostName) keep this single runner.
  const runnerForAttempt = new RunnerForAttemptAdapter({
    hosts: options?.installation?.hosts,
    legacyRunner: runner,
    ocmRunBin,
    executor: roleExecutors.orchestrator,
    ...(runnerProfile !== undefined ? { capabilities: runnerProfile.capabilities } : {}),
    ...(runnerProfile !== undefined ? { runnerTransport: runnerProfile.transport } : {}),
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
    installation: options?.installation,
    ...(runnerHost !== undefined ? { runnerHost } : {}),
    registerWorkOrder: new RegisterWorkOrderUseCase({ workOrderRepo }),
    inspectWorkOrder: new InspectWorkOrderUseCase({ workOrderRepo, attemptRepo, journal }),
    inspectAttempt: new InspectAttemptUseCase({ attemptRepo, runnerForAttempt }),
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
    reconcileAttempt: new ReconcileAttemptUseCase({
      attemptRepo,
      journal,
      runner,
      runnerForAttempt,
    }),
    stopAttempt: new StopAttemptUseCase({
      attemptRepo,
      journal,
      runner,
      runnerForAttempt,
    }),
    collectAttemptArtifacts: new CollectAttemptArtifactsUseCase({
      attemptRepo,
      journal,
      artifactPort,
      briefKnowledge,
      runnerForAttempt,
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
      // Forge mode `none` (D6) refuses every forge action.
      ...(forgeMode === "none" ? { forgeMode: "none" as const } : {}),
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
