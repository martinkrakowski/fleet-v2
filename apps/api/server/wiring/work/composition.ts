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
} from "../../../../../packages/work-execution/src/application/use-cases/index";

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

let current: WorkComposition | null = null;

export function workComposition(): WorkComposition {
  if (!current) {
    current = {
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
  return current;
}
