/**
 * Operator-coordination supplier composition (SPLIT-1): builds the coordination
 * stack and project-profile access from the shared root inputs; called by the
 * CLI composition root.
 */
import { join } from 'node:path';

import { newUlid } from '../ulid.js';

import {
  AcknowledgeOwnerAnswerUseCase,
  AnswerOwnerQuestionUseCase,
  AskOwnerQuestionUseCase,
  AttentionItemRepositoryAdapter,
  AttentionReadAdapter,
  CheckOwnerDecisionUseCase,
  ClearAttentionItemUseCase,
  CoordinationRequestRepositoryAdapter,
  DecisionTransportAdapter,
  ExpireOwnerQuestionsUseCase,
  InspectConfiguredCapabilitiesUseCase,
  InspectOutstandingCoordinationUseCase,
  InspectProjectProfileUseCase,
  InstallationReferenceAdapter,
  IssuePolicyForgeGrantUseCase,
  ListAttentionItemsUseCase,
  ListOwnerQuestionsUseCase,
  ListProjectProfilesUseCase,
  ObservationPublicationAdapter,
  OwnerQuestionRepositoryAdapter,
  ProjectProfileRepositoryAdapter,
  PublishProjectObservationUseCase,
  ReadOwnerQuestionUseCase,
  ReadProjectAttentionUseCase,
  RecordAttentionItemUseCase,
  RecordAuthorizationConsumptionUseCase,
  RecordProjectProbeUseCase,
  RecordRelayAcknowledgementUseCase,
  RegisterProjectProfileUseCase,
  RelayTransportAdapter,
  RequestScopedDecisionUseCase,
  ResolveActionAuthorizationUseCase,
  RetireProjectProfileUseCase,
  SendFleetRelayUseCase,
  SyncOneWayOwnerQuestionsUseCase,
  UpdateProjectProfileUseCase,
  type AttentionClock,
  type OwnerQuestionClock,
} from '@fleet/operator-coordination';
import {
  type ExecutorForRecordedHostResult,
  executorForInstallationHost,
  ProjectProfileReadAdapter,
  ProjectProbeRecordAdapter,
} from '@fleet/work-execution';

import type { FleetCliRuntimeOptions } from '../composition.js';

export interface ComposeCoordinationInput {
  readonly stateDir?: string;
  readonly ownerPublicKey?: string;
  readonly options?: FleetCliRuntimeOptions;
}

export function composeCoordination(input: ComposeCoordinationInput) {
  const { stateDir, ownerPublicKey, options } = input;

  // --- operator-coordination -------------------------------------------------

  const projectProfileRepository = new ProjectProfileRepositoryAdapter({ stateDir });
  const coordinationRequestRepository = new CoordinationRequestRepositoryAdapter({ stateDir });
  // Owner-recorded decision answers, one `<requestId>.json` per request. An
  // absent or grantless answer stays `awaiting-decision`; nothing is upgraded.
  const decisionTransport = new DecisionTransportAdapter({
    decisionsDir: stateDir === undefined ? undefined : join(stateDir, 'decisions'),
    ownerPublicKey,
  });
  const observationPublication = new ObservationPublicationAdapter({
    outboxDir: stateDir === undefined ? undefined : join(stateDir, 'observation-outbox'),
  });
  const relayTransport = new RelayTransportAdapter({
    outboxDir: stateDir === undefined ? undefined : join(stateDir, 'relay-outbox'),
  });
  // The Waves attention summary reader stays unconfigured; reads report
  // absence. Stored attention items are kept in attentionItemRepository,
  // persisted to `<stateDir>/attention-items.json` and in-memory without a
  // stateDir.
  const attentionRead = new AttentionReadAdapter();
  // Owner questions are their own aggregate beside the coordination requests,
  // persisted to `<stateDir>/owner-questions.json` and in-memory without a
  // stateDir. The clock is the composition root's alone: no request body ever
  // supplies the moment a question is asked, answered, expired or
  // acknowledged.
  const ownerQuestionRepository = new OwnerQuestionRepositoryAdapter({ stateDir });
  const ownerQuestionClock: OwnerQuestionClock = { nowIso: () => new Date().toISOString() };
  const attentionItemRepository = new AttentionItemRepositoryAdapter({ stateDir });
  const attentionClock: AttentionClock = { nowIso: () => new Date().toISOString() };

  // Installation name references for project profiles (P6a): a v2
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

  const coordination = {
    projectProfileRepository,
    coordinationRequestRepository,
    decisionTransport,
    observationPublication,
    relayTransport,
    attentionRead,
    registerProjectProfile: new RegisterProjectProfileUseCase({
      profileRepo: projectProfileRepository,
      ...(installationRefs !== undefined ? { installationRefs } : {}),
    }),
    updateProjectProfile: new UpdateProjectProfileUseCase({
      profileRepo: projectProfileRepository,
      ...(installationRefs !== undefined ? { installationRefs } : {}),
    }),
    retireProjectProfile: new RetireProjectProfileUseCase({ profileRepo: projectProfileRepository }),
    listProjectProfiles: new ListProjectProfilesUseCase({ profileRepo: projectProfileRepository }),
    inspectProjectProfile: new InspectProjectProfileUseCase({ profileRepo: projectProfileRepository }),
    recordProjectProbe: new RecordProjectProbeUseCase({ profileRepo: projectProfileRepository }),
    inspectConfiguredCapabilities: new InspectConfiguredCapabilitiesUseCase({
      profileRepo: projectProfileRepository,
    }),
    requestScopedDecision: new RequestScopedDecisionUseCase({
      requestRepo: coordinationRequestRepository,
      decisionTransport,
    }),
    resolveActionAuthorization: new ResolveActionAuthorizationUseCase({
      requestRepo: coordinationRequestRepository,
      decisionTransport,
    }),
    // One-way doors are answered by the coordination request's own
    // authorization rule, through the application layer: the evidence context
    // never reads this repository directly.
    checkOwnerDecision: new CheckOwnerDecisionUseCase({
      requestRepo: coordinationRequestRepository,
    }),
    recordAuthorizationConsumption: new RecordAuthorizationConsumptionUseCase({
      requestRepo: coordinationRequestRepository,
    }),
    publishProjectObservation: new PublishProjectObservationUseCase({
      publicationPort: observationPublication,
    }),
    readProjectAttention: new ReadProjectAttentionUseCase({ attentionPort: attentionRead }),
    sendFleetRelay: new SendFleetRelayUseCase({
      requestRepo: coordinationRequestRepository,
      relayTransport,
    }),
    recordRelayAcknowledgement: new RecordRelayAcknowledgementUseCase({
      requestRepo: coordinationRequestRepository,
    }),
    inspectOutstandingCoordination: new InspectOutstandingCoordinationUseCase({
      requestRepo: coordinationRequestRepository,
      publicationPort: observationPublication,
    }),
    // Owner questions: two-way questions are answered through the answer use
    // case with `answeredVia 'cli'`; one-way questions are settled only by the
    // signed owner decision their linked request carries, read through the
    // same decision transport that verifies forge-time approvals. An answer
    // unblocks; it grants nothing and writes no coordination request.
    ownerQuestionRepository,
    askOwnerQuestion: new AskOwnerQuestionUseCase({
      ownerQuestionRepo: ownerQuestionRepository,
      requestRepo: coordinationRequestRepository,
      clock: ownerQuestionClock,
    }),
    answerOwnerQuestion: new AnswerOwnerQuestionUseCase({
      ownerQuestionRepo: ownerQuestionRepository,
      clock: ownerQuestionClock,
    }),
    listOwnerQuestions: new ListOwnerQuestionsUseCase({
      ownerQuestionRepo: ownerQuestionRepository,
    }),
    readOwnerQuestion: new ReadOwnerQuestionUseCase({
      ownerQuestionRepo: ownerQuestionRepository,
    }),
    syncOneWayOwnerQuestions: new SyncOneWayOwnerQuestionsUseCase({
      ownerQuestionRepo: ownerQuestionRepository,
      requestRepo: coordinationRequestRepository,
      decisionTransport,
      clock: ownerQuestionClock,
    }),
    expireOwnerQuestions: new ExpireOwnerQuestionsUseCase({
      ownerQuestionRepo: ownerQuestionRepository,
      clock: ownerQuestionClock,
    }),
    acknowledgeOwnerAnswer: new AcknowledgeOwnerAnswerUseCase({
      ownerQuestionRepo: ownerQuestionRepository,
      clock: ownerQuestionClock,
    }),
    attentionItemRepository,
    recordAttentionItem: new RecordAttentionItemUseCase({
      itemRepo: attentionItemRepository,
      clock: attentionClock,
      ids: { newItemId: () => 'att-' + newUlid() },
    }),
    clearAttentionItem: new ClearAttentionItemUseCase({
      itemRepo: attentionItemRepository,
      clock: attentionClock,
    }),
    listAttentionItems: new ListAttentionItemsUseCase({
      itemRepo: attentionItemRepository,
    }),
  };

  // AM5-3: the auto-merge policy-grant use case over the shared coordination
  // request store; the consumer adapters delegate to it through this root. The
  // clock and ids are the root's own, as for every composition here.
  const issuePolicyForgeGrantUseCase = new IssuePolicyForgeGrantUseCase({
    requestRepo: coordinationRequestRepository,
    clock: { nowIso: () => new Date().toISOString() },
    ids: { newRequestId: newUlid, newGrantId: newUlid },
  });

  // --- project profiles and probes (P6b) --------------------------------------
  // The execution context reads profiles and records probe receipts through
  // the operator-coordination use cases, bound here (same delegate pattern as
  // the other cross-context adapters).
  const profileRead = new ProjectProfileReadAdapter({
    inspect: (req) => coordination.inspectProjectProfile.execute(req),
  });
  const probeRecord = new ProjectProbeRecordAdapter({
    record: (req) => coordination.recordProjectProbe.execute(req),
  });
  // One executor per named installation host for the probe's read-only git
  // checks. A v2 installation names its hosts; a v1 or absent installation has
  // no host names, so every name is refused. The shared helper keeps the CLI
  // and API probe rules and reason strings identical.
  const executorForHostName = (name: string): ExecutorForRecordedHostResult =>
    executorForInstallationHost(
      options?.installation?.schemaVersion === 2 ? options.installation.hosts : undefined,
      name,
    );

  return {
    coordination,
    coordinationRequestRepository,
    issuePolicyForgeGrantUseCase,
    profileRead,
    probeRecord,
    executorForHostName,
  };
}
