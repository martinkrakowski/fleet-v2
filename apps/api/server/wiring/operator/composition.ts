import {
  AttentionReadAdapter,
  CoordinationRequestRepositoryAdapter,
  DecisionTransportAdapter,
  ObservationPublicationAdapter,
  ProjectProfileRepositoryAdapter,
  RelayTransportAdapter,
} from "@fleet/operator-coordination";

import { join } from "node:path";
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

export interface OperatorCompositionOptions {
  readonly stateDir?: string;
  readonly ownerPublicKey?: string;
}

let composition: OperatorComposition | undefined;
let configured: OperatorComposition | undefined;

function unconfiguredOperatorComposition(): OperatorComposition {
  return {
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
}

export function getOperatorComposition(): OperatorComposition {
  if (configured) {
    return configured;
  }
  composition ??= unconfiguredOperatorComposition();
  return composition;
}

export function createConfiguredOperatorComposition(
  options?: OperatorCompositionOptions,
): OperatorComposition {
  const stateDir = options?.stateDir;
  const ownerPublicKey =
    options?.ownerPublicKey ?? (process.env.FLEET_OWNER_PUBLIC_KEY?.trim() || undefined);

  const profileRepo = new ProjectProfileRepositoryAdapter({ stateDir });
  const requestRepo = new CoordinationRequestRepositoryAdapter({ stateDir });
  const decisionTransport = new DecisionTransportAdapter({
    decisionsDir: stateDir === undefined ? undefined : join(stateDir, "decisions"),
    ownerPublicKey,
  });
  const publicationPort = new ObservationPublicationAdapter(
    stateDir === undefined ? {} : { outboxDir: join(stateDir, "observation-outbox") },
  );
  const attentionPort = new AttentionReadAdapter();
  const relayTransport = new RelayTransportAdapter(
    stateDir === undefined ? {} : { outboxDir: join(stateDir, "relay-outbox") },
  );

  return {
    inspectConfiguredCapabilities: new InspectConfiguredCapabilitiesUseCase({ profileRepo }),
    publishProjectObservation: new PublishProjectObservationUseCase({ publicationPort }),
    requestScopedDecision: new RequestScopedDecisionUseCase({
      requestRepo,
      decisionTransport,
    }),
    resolveActionAuthorization: new ResolveActionAuthorizationUseCase({
      requestRepo,
      decisionTransport,
    }),
    recordAuthorizationConsumption: new RecordAuthorizationConsumptionUseCase({ requestRepo }),
    readProjectAttention: new ReadProjectAttentionUseCase({ attentionPort }),
    inspectOutstandingCoordination: new InspectOutstandingCoordinationUseCase({
      requestRepo,
      publicationPort,
    }),
    sendFleetRelay: new SendFleetRelayUseCase({ requestRepo, relayTransport }),
    recordRelayAcknowledgement: new RecordRelayAcknowledgementUseCase({ requestRepo }),
    registerProjectProfile: new RegisterProjectProfileUseCase({ profileRepo }),
  };
}

function isOperatorComposition(
  value: OperatorComposition | OperatorCompositionOptions,
): value is OperatorComposition {
  return typeof value === "object" && "inspectConfiguredCapabilities" in value;
}

export function configureOperatorComposition(
  custom: OperatorComposition | OperatorCompositionOptions | null,
): void {
  if (custom === null) {
    configured = undefined;
    composition = undefined;
    return;
  }
  configured = isOperatorComposition(custom)
    ? custom
    : createConfiguredOperatorComposition(custom);
  composition = undefined;
}
