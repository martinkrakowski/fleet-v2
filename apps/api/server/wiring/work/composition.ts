import {
  AcceptanceAssessmentAdapter,
  AcceptanceEvidenceAdapter,
  ActionAuthorizationAdapter,
  AllowedSeatAdapter,
  AttemptArtifactAdapter,
  AttemptRepositoryAdapter,
  BriefAuthoringAdapter,
  BriefKnowledgeAdapter,
  ExecutionJournalAdapter,
  ExecutionObservationAdapter,
  ExecutionRunnerAdapter,
  ForgeActionAdapter,
  ConductorHaltAdapter,
  ConductorDriverLeaseAdapter,
  ConductorPassTraceAdapter,
  LaneRunJournalAdapter,
  LaneRunRepositoryAdapter,
  LocalExecutor,
  OwnerDecisionAdapter,
  AttemptOwnerDecisionAdapter,
  ProjectProbeAdapter,
  ProjectProbeRecordAdapter,
  ProjectProfileReadAdapter,
  RunnerForAttemptAdapter,
  WorkOrderRepositoryAdapter,
  WorkspaceAdapter,
  ExecutorForHost,
  executorForInstallationHost,
  resolveExecutionRunnerHost,
  resolveInstallationForgeMode,
  resolveRoleExecutors,
  resolveRunnerCapabilityProfile,
  sha256HexDigest,
  type AcceptanceAssessmentDelegate,
  type AcceptanceEvidenceDelegate,
  type CancelPreparedAttemptRequest,
  type ActionAuthorizationDelegate,
  type BriefKnowledgeDelegate,
  type ExecutionObservationDelegate,
  type ExecutionRunnerHost,
  type ForgeActionDelegate,
  type ChangeSignalPort,
  type OwnerDecisionDelegate,
  type AttemptOwnerDecisionDelegate,
} from "@fleet/work-execution";
import { requireValidInstallationModel, type FleetInstallation } from "@fleet/installation";
import {
  CancelPreparedAttemptUseCase,
  CollectAttemptArtifactsUseCase,
  DispatchAttemptUseCase,
  ExecuteAuthorizedForgeActionUseCase,
  InspectAttemptUseCase,
  InspectWorkOrderUseCase,
  ListLaneRunsUseCase,
  ListAttemptsUseCase,
  ListAttemptJournalUseCase,
  ListConductorPassesUseCase,
  ListUnregisteredProjectsUseCase,
  PrepareBriefPackageUseCase,
  PrepareFixAttemptUseCase,
  ProbeProjectUseCase,
  ReconcileAttemptUseCase,
  RegisterWorkOrderUseCase,
  RequestAttemptAcceptanceUseCase,
  ReserveExecutionCapacityUseCase,
  StopAttemptUseCase,
  resolveImplementerSeat,
  type ImplementerSeatResolution,
} from "@fleet/work-execution/use-cases";
import { ProbeLimiter } from "./probe-limiter";
import { withPendingFixLimit } from "./pending-fix-guard";
import { withRunActiveRefusal, type GuardedCancelPreparedResult } from "./cancel-prepared-guard";

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
  listAttempts: ListAttemptsUseCase;
  // GET /v1/runs: the read-only conductor schedule (A-R-1)
  listLaneRuns: ListLaneRunsUseCase;
  // GET /v1/runs/passes: the recorded conductor pass traces (VZ6)
  listConductorPasses: ListConductorPassesUseCase;
  listAttemptJournal: ListAttemptJournalUseCase;
  probeProject: ProbeProjectUseCase;
  /**
   * Throttles HTTP probe requests: one in-flight probe per project and a
   * small global cap. Owned by this composition root, not the route.
   */
  probeLimiter: ProbeLimiter;
  listUnregisteredProjects: ListUnregisteredProjectsUseCase;
  prepareBriefPackage: PrepareBriefPackageUseCase;
  reserveExecutionCapacity: ReserveExecutionCapacityUseCase;
  dispatchAttempt: DispatchAttemptUseCase;
  reconcileAttempt: ReconcileAttemptUseCase;
  stopAttempt: StopAttemptUseCase;
  collectAttemptArtifacts: CollectAttemptArtifactsUseCase;
  prepareFixAttempt: Pick<PrepareFixAttemptUseCase, "execute">;
  requestAttemptAcceptance: RequestAttemptAcceptanceUseCase;
  /**
   * Throttles HTTP attempt actions (stop, reconcile, fix): one in-flight
   * action per attempt id and a small global cap. Owned by this composition
   * root, not the route.
   */
  attemptLimiter: ProbeLimiter;
  /**
   * Throttles HTTP cancel-prepared actions: one in-flight cancel per attempt
   * id and a small global cap. A cancel is a pure record write, so it is kept
   * apart from attemptLimiter (stop, reconcile, fix) and never waits behind a
   * probe. Owned by this composition root, not the route.
   */
  cancelPreparedLimiter: ProbeLimiter;
  cancelPreparedAttempt: {
    cancelPreparedAttempt(
      request: CancelPreparedAttemptRequest,
    ): Promise<GuardedCancelPreparedResult>;
  };
  executeAuthorizedForgeAction: ExecuteAuthorizedForgeActionUseCase;
  /** The attempt's recorded implementer seat; never an operator value. */
  readonly resolveAttemptImplementerSeat?: AttemptImplementerSeatResolver;
}

export interface WorkCompositionOptions {
  readonly stateDir?: string;
  /** Emitter for post-save change signals; the API runtime wires the change feed. */
  readonly changeSignal?: ChangeSignalPort;
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
  /**
   * Cross-context project-profile read and probe-record delegates: the API
   * runtime binds the operator-coordination inspect/record use cases. Without
   * them the probe and the work-order guard refuse.
   */
  readonly projectProfile?: {
    readonly inspect: (req: { projectId: string }) => Promise<unknown>;
    readonly record: (req: unknown) => Promise<unknown>;
  };
}

let current: WorkComposition | null = null;
let configured: WorkComposition | null = null;

function unconfiguredWorkComposition(): WorkComposition {
  return {
    registerWorkOrder: new RegisterWorkOrderUseCase(),
    inspectWorkOrder: new InspectWorkOrderUseCase(),
    inspectAttempt: new InspectAttemptUseCase(),
    listAttempts: new ListAttemptsUseCase(),
    listLaneRuns: new ListLaneRunsUseCase(),
    listConductorPasses: new ListConductorPassesUseCase(),
    listAttemptJournal: new ListAttemptJournalUseCase(),
    probeProject: new ProbeProjectUseCase(),
    probeLimiter: new ProbeLimiter(),
    attemptLimiter: new ProbeLimiter(4),
    cancelPreparedLimiter: new ProbeLimiter(),
    cancelPreparedAttempt: new CancelPreparedAttemptUseCase(),
    listUnregisteredProjects: new ListUnregisteredProjectsUseCase(),
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
  crossContext?: WorkCrossContextDelegates,
): void {
  if (custom === null) {
    configured = null;
    current = null;
    return;
  }
  configured = isWorkComposition(custom)
    ? custom
    : createConfiguredWorkComposition(custom, crossContext);
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

  const workOrderRepo = new WorkOrderRepositoryAdapter({
    stateDir,
    ...(options?.changeSignal ? { changeSignal: options.changeSignal } : {}),
  });
  const attemptRepo = new AttemptRepositoryAdapter({
    stateDir,
    ...(options?.changeSignal ? { changeSignal: options.changeSignal } : {}),
  });
  const journal = new ExecutionJournalAdapter({
    stateDir,
    ...(options?.changeSignal ? { changeSignal: options.changeSignal } : {}),
  });
  // EX-1c: the cancel-prepared guard reads lane runs and their journal; the
  // route only ever reads them, so both adapters are opened read-only.
  const laneRunRepo = new LaneRunRepositoryAdapter({ stateDir, readOnly: true });
  const laneRunJournal = new LaneRunJournalAdapter({ stateDir, readOnly: true });
  // A-R-1: the schedule read is the only caller of the halt and driver-lease
  // `read()`; open both read-only so a malformed marker reads as unreadable
  // / null and is never quarantined (moved) by a GET.
  const conductorHalt = new ConductorHaltAdapter({ stateDir, readOnly: true });
  const conductorDriverLease = new ConductorDriverLeaseAdapter({ stateDir, readOnly: true });
  // VZ6: the pass list is a read-only GET; open the trace ring read-only so a
  // malformed ring is reported unreadable and never quarantined by a GET.
  const conductorPassTrace = new ConductorPassTraceAdapter({ stateDir, readOnly: true });
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
  // Free-seat policy (plan F3/F5): the adapter reads the installation's seat
  // catalogue and policy as a structural subset. A seat mapped from a v1 file
  // carries no cost class, so it stays out of the catalogue: with the flag
  // off it cannot be proven non-free and is refused as not in the catalogue.
  // An absent installation keeps the flag on (every seat allowed).
  const allowedSeats = new AllowedSeatAdapter({
    seats: (installationModel?.seats ?? []).flatMap((seat) =>
      seat.costClass === undefined
        ? []
        : [
            {
              id: seat.id,
              tool: seat.tool,
              model: seat.model,
              ...(seat.variant !== undefined ? { variant: seat.variant } : {}),
              costClass: seat.costClass,
            },
          ],
    ),
    policy: installationModel?.policy,
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
  // The probe and the work-order guard read profiles through the operator
  // context and record probe receipts there. The guard is on for every
  // installation kind; without a projectProfile delegate the adapters refuse.
  const profileRead = new ProjectProfileReadAdapter(crossContext?.projectProfile);
  const probeRecord = new ProjectProbeRecordAdapter(crossContext?.projectProfile);

  return {
    installation: options?.installation,
    ...(runnerHost !== undefined ? { runnerHost } : {}),
    probeProject: new ProbeProjectUseCase({
      profileRead,
      probe: new ProjectProbeAdapter({
        orchestrator: new LocalExecutor(),
        executorForHost: (name) =>
          executorForInstallationHost(
            options?.installation?.schemaVersion === 2 ? options.installation.hosts : undefined,
            name,
          ),
      }),
      probeRecord,
      verificationProcedureNames:
        options?.installation?.schemaVersion === 2
          ? Object.keys(options?.installation?.verification?.procedures ?? {})
          : null,
    }),
    probeLimiter: new ProbeLimiter(),
    attemptLimiter: new ProbeLimiter(4),
    cancelPreparedLimiter: new ProbeLimiter(),
    cancelPreparedAttempt: withRunActiveRefusal(
      new CancelPreparedAttemptUseCase({ attemptRepo, journal }),
      laneRunRepo,
      laneRunJournal,
    ),
    listUnregisteredProjects: new ListUnregisteredProjectsUseCase({
      workOrderRepo,
      profileRead,
    }),
    registerWorkOrder: new RegisterWorkOrderUseCase({ workOrderRepo, profileRead }),
    inspectWorkOrder: new InspectWorkOrderUseCase({ workOrderRepo, attemptRepo, journal }),
    inspectAttempt: new InspectAttemptUseCase({ attemptRepo, runnerForAttempt }),
    listAttempts: new ListAttemptsUseCase({ attemptRepo, workOrderRepo, journal }),
    listLaneRuns: new ListLaneRunsUseCase({
      runRepo: laneRunRepo,
      runJournal: laneRunJournal,
      halt: conductorHalt,
      driverLease: conductorDriverLease,
      attemptRepo,
      executionJournal: journal,
      workOrderRepo,
    }),
    listConductorPasses: new ListConductorPassesUseCase({ passTrace: conductorPassTrace }),
    listAttemptJournal: new ListAttemptJournalUseCase({ attemptRepo, journal }),
    prepareBriefPackage: new PrepareBriefPackageUseCase({
      briefAuthoring,
      artifactPort,
      briefKnowledge,
      computeDigest: sha256HexDigest,
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
      computeDigest: sha256HexDigest,
      allowedSeats,
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
    prepareFixAttempt: withPendingFixLimit(
      new PrepareFixAttemptUseCase({ attemptRepo }),
      attemptRepo,
    ),
    requestAttemptAcceptance: new RequestAttemptAcceptanceUseCase({
      attemptRepo,
      workOrderRepo,
      acceptancePort,
      artifactPort,
      allowedSeats,
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
