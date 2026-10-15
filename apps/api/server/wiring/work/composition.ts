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
import {
  CollectAttemptArtifactsUseCase,
  DispatchAttemptUseCase,
  ExecuteAuthorizedForgeActionUseCase,
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
  value: WorkComposition | { stateDir?: string },
): value is WorkComposition {
  return typeof value === "object" && "registerWorkOrder" in value;
}

export function configureWorkComposition(
  custom: WorkComposition | { stateDir?: string } | null,
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

  const workOrderRepo = new WorkOrderRepositoryAdapter({ stateDir });
  const attemptRepo = new AttemptRepositoryAdapter({ stateDir });
  const journal = new ExecutionJournalAdapter({ stateDir });
  const briefAuthoring = new BriefAuthoringAdapter();
  const workspace = new WorkspaceAdapter();
  const artifactPort = new AttemptArtifactAdapter();
  const runner = new ExecutionRunnerAdapter();
  const acceptancePort = new AcceptanceAssessmentAdapter(crossContext?.acceptance);
  const briefKnowledge = new BriefKnowledgeAdapter(crossContext?.briefKnowledge);
  const authorizationPort = new ActionAuthorizationAdapter(crossContext?.authorization);
  const observation = new ExecutionObservationAdapter(crossContext?.observation);
  const forgePort = new ForgeActionAdapter(crossContext?.forge);

  return {
    registerWorkOrder: new RegisterWorkOrderUseCase({ workOrderRepo }),
    inspectWorkOrder: new InspectWorkOrderUseCase({ workOrderRepo, attemptRepo, journal }),
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
