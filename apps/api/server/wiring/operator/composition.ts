import {
  AttentionReadAdapter,
  CheckOwnerDecisionUseCase,
  CoordinationRequestRepositoryAdapter,
  DecisionTransportAdapter,
  InstallationReferenceAdapter,
  ObservationPublicationAdapter,
  OwnerQuestionRepositoryAdapter,
  ProjectProfileRepositoryAdapter,
  RelayTransportAdapter,
} from "@fleet/operator-coordination";

import type { FleetInstallation } from "@fleet/installation";
import { join } from "node:path";
import {
  AcknowledgeOwnerAnswerUseCase,
  AnswerOwnerQuestionUseCase,
  AskOwnerQuestionUseCase,
  ExpireOwnerQuestionsUseCase,
  InspectConfiguredCapabilitiesUseCase,
  InspectOutstandingCoordinationUseCase,
  InspectProjectProfileUseCase,
  ListOwnerQuestionsUseCase,
  ListProjectProfilesUseCase,
  PublishProjectObservationUseCase,
  ReadOwnerQuestionUseCase,
  ReadProjectAttentionUseCase,
  RecordAuthorizationConsumptionUseCase,
  RecordProjectProbeUseCase,
  RecordRelayAcknowledgementUseCase,
  RegisterProjectProfileUseCase,
  RequestScopedDecisionUseCase,
  ResolveActionAuthorizationUseCase,
  RetireProjectProfileUseCase,
  SendFleetRelayUseCase,
  SyncOneWayOwnerQuestionsUseCase,
  UpdateProjectProfileUseCase,
} from "@fleet/operator-coordination/use-cases";

/** A real clock: the composition root alone supplies "now" to the use cases. */
const systemClock = { nowIso: () => new Date().toISOString() };

export interface OperatorComposition {
  coordinationRequestRepository: CoordinationRequestRepositoryAdapter;
  inspectConfiguredCapabilities: InspectConfiguredCapabilitiesUseCase;
  publishProjectObservation: PublishProjectObservationUseCase;
  requestScopedDecision: RequestScopedDecisionUseCase;
  resolveActionAuthorization: ResolveActionAuthorizationUseCase;
  checkOwnerDecision: CheckOwnerDecisionUseCase;
  recordAuthorizationConsumption: RecordAuthorizationConsumptionUseCase;
  readProjectAttention: ReadProjectAttentionUseCase;
  inspectOutstandingCoordination: InspectOutstandingCoordinationUseCase;
  sendFleetRelay: SendFleetRelayUseCase;
  recordRelayAcknowledgement: RecordRelayAcknowledgementUseCase;
  registerProjectProfile: RegisterProjectProfileUseCase;
  updateProjectProfile: UpdateProjectProfileUseCase;
  retireProjectProfile: RetireProjectProfileUseCase;
  listProjectProfiles: ListProjectProfilesUseCase;
  inspectProjectProfile: InspectProjectProfileUseCase;
  recordProjectProbe: RecordProjectProbeUseCase;
  listOwnerQuestions: ListOwnerQuestionsUseCase;
  readOwnerQuestion: ReadOwnerQuestionUseCase;
  askOwnerQuestion: AskOwnerQuestionUseCase;
  answerOwnerQuestion: AnswerOwnerQuestionUseCase;
  acknowledgeOwnerAnswer: AcknowledgeOwnerAnswerUseCase;
  syncOneWayOwnerQuestions: SyncOneWayOwnerQuestionsUseCase;
  expireOwnerQuestions: ExpireOwnerQuestionsUseCase;
}

export interface OperatorCompositionOptions {
  readonly stateDir?: string;
  readonly ownerPublicKey?: string;
  readonly installation?: FleetInstallation;
}

let composition: OperatorComposition | undefined;
let configured: OperatorComposition | undefined;

function unconfiguredOperatorComposition(): OperatorComposition {
  return {
    coordinationRequestRepository: new CoordinationRequestRepositoryAdapter(),
    inspectConfiguredCapabilities: new InspectConfiguredCapabilitiesUseCase(),
    publishProjectObservation: new PublishProjectObservationUseCase(),
    requestScopedDecision: new RequestScopedDecisionUseCase(),
    resolveActionAuthorization: new ResolveActionAuthorizationUseCase(),
    checkOwnerDecision: new CheckOwnerDecisionUseCase(),
    recordAuthorizationConsumption: new RecordAuthorizationConsumptionUseCase(),
    readProjectAttention: new ReadProjectAttentionUseCase(),
    inspectOutstandingCoordination: new InspectOutstandingCoordinationUseCase(),
    sendFleetRelay: new SendFleetRelayUseCase(),
    recordRelayAcknowledgement: new RecordRelayAcknowledgementUseCase(),
    registerProjectProfile: new RegisterProjectProfileUseCase(),
    updateProjectProfile: new UpdateProjectProfileUseCase(),
    retireProjectProfile: new RetireProjectProfileUseCase(),
    listProjectProfiles: new ListProjectProfilesUseCase(),
    inspectProjectProfile: new InspectProjectProfileUseCase(),
    recordProjectProbe: new RecordProjectProbeUseCase(),
    listOwnerQuestions: new ListOwnerQuestionsUseCase(),
    readOwnerQuestion: new ReadOwnerQuestionUseCase(),
    askOwnerQuestion: new AskOwnerQuestionUseCase(),
    answerOwnerQuestion: new AnswerOwnerQuestionUseCase(),
    acknowledgeOwnerAnswer: new AcknowledgeOwnerAnswerUseCase(),
    syncOneWayOwnerQuestions: new SyncOneWayOwnerQuestionsUseCase(),
    expireOwnerQuestions: new ExpireOwnerQuestionsUseCase(),
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
  const ownerQuestionRepo = new OwnerQuestionRepositoryAdapter({ stateDir });

  // Installation name references for project profiles (P5a): a v2
  // installation enables host and gate-procedure name checks behind profile
  // registration and update; a v1 or absent installation passes no reference
  // port, which keeps the no-install behaviour (no name checks).
  const installationRefs =
    options?.installation?.schemaVersion === 2
      ? new InstallationReferenceAdapter({
          hostNames: Object.keys(options.installation.hosts ?? {}),
          procedureNames: Object.keys(options.installation.verification?.procedures ?? {}),
        })
      : undefined;

  return {
    coordinationRequestRepository: requestRepo,
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
    checkOwnerDecision: new CheckOwnerDecisionUseCase({ requestRepo }),
    recordAuthorizationConsumption: new RecordAuthorizationConsumptionUseCase({ requestRepo }),
    readProjectAttention: new ReadProjectAttentionUseCase({ attentionPort }),
    inspectOutstandingCoordination: new InspectOutstandingCoordinationUseCase({
      requestRepo,
      publicationPort,
    }),
    sendFleetRelay: new SendFleetRelayUseCase({ requestRepo, relayTransport }),
    recordRelayAcknowledgement: new RecordRelayAcknowledgementUseCase({ requestRepo }),
    registerProjectProfile: new RegisterProjectProfileUseCase({
      profileRepo,
      ...(installationRefs !== undefined ? { installationRefs } : {}),
    }),
    updateProjectProfile: new UpdateProjectProfileUseCase({
      profileRepo,
      ...(installationRefs !== undefined ? { installationRefs } : {}),
    }),
    retireProjectProfile: new RetireProjectProfileUseCase({ profileRepo }),
    listProjectProfiles: new ListProjectProfilesUseCase({ profileRepo }),
    inspectProjectProfile: new InspectProjectProfileUseCase({ profileRepo }),
    recordProjectProbe: new RecordProjectProbeUseCase({ profileRepo }),
    listOwnerQuestions: new ListOwnerQuestionsUseCase({ ownerQuestionRepo }),
    readOwnerQuestion: new ReadOwnerQuestionUseCase({ ownerQuestionRepo }),
    askOwnerQuestion: new AskOwnerQuestionUseCase({
      ownerQuestionRepo,
      requestRepo,
      clock: systemClock,
    }),
    answerOwnerQuestion: new AnswerOwnerQuestionUseCase({
      ownerQuestionRepo,
      clock: systemClock,
    }),
    acknowledgeOwnerAnswer: new AcknowledgeOwnerAnswerUseCase({
      ownerQuestionRepo,
      clock: systemClock,
    }),
    syncOneWayOwnerQuestions: new SyncOneWayOwnerQuestionsUseCase({
      ownerQuestionRepo,
      requestRepo,
      decisionTransport,
      clock: systemClock,
    }),
    expireOwnerQuestions: new ExpireOwnerQuestionsUseCase({
      ownerQuestionRepo,
      clock: systemClock,
    }),
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
