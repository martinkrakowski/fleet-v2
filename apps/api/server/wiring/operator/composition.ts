import {
  InspectConfiguredCapabilitiesUseCase,
  InspectOutstandingCoordinationUseCase,
  PublishProjectObservationUseCase,
  ReadProjectAttentionUseCase,
  RecordAuthorizationConsumptionUseCase,
  RecordRelayAcknowledgementUseCase,
  RegisterProjectProfileUseCase,
  RequestScopedDecisionUseCase,
  ResolveActionAuthorizationUseCase,
  SendFleetRelayUseCase,
} from "@fleet/operator-coordination/use-cases";

export interface OperatorComposition {
  inspectConfiguredCapabilities: InspectConfiguredCapabilitiesUseCase;
  publishProjectObservation: PublishProjectObservationUseCase;
  requestScopedDecision: RequestScopedDecisionUseCase;
  resolveActionAuthorization: ResolveActionAuthorizationUseCase;
  recordAuthorizationConsumption: RecordAuthorizationConsumptionUseCase;
  readProjectAttention: ReadProjectAttentionUseCase;
  inspectOutstandingCoordination: InspectOutstandingCoordinationUseCase;
  sendFleetRelay: SendFleetRelayUseCase;
  recordRelayAcknowledgement: RecordRelayAcknowledgementUseCase;
  registerProjectProfile: RegisterProjectProfileUseCase;
}

let composition: OperatorComposition | undefined;

export function getOperatorComposition(): OperatorComposition {
  composition ??= {
    inspectConfiguredCapabilities: new InspectConfiguredCapabilitiesUseCase(),
    publishProjectObservation: new PublishProjectObservationUseCase(),
    requestScopedDecision: new RequestScopedDecisionUseCase(),
    resolveActionAuthorization: new ResolveActionAuthorizationUseCase(),
    recordAuthorizationConsumption: new RecordAuthorizationConsumptionUseCase(),
    readProjectAttention: new ReadProjectAttentionUseCase(),
    inspectOutstandingCoordination: new InspectOutstandingCoordinationUseCase(),
    sendFleetRelay: new SendFleetRelayUseCase(),
    recordRelayAcknowledgement: new RecordRelayAcknowledgementUseCase(),
    registerProjectProfile: new RegisterProjectProfileUseCase(),
  };
  return composition;
}
