import {
  AttentionReadAdapter,
  CheckOwnerDecisionUseCase,
  CoordinationRequestRepositoryAdapter,
  DecisionTransportAdapter,
  InstallationReferenceAdapter,
  ObservationPublicationAdapter,
  OrchestratorRequestJournalAdapter,
  OrchestratorRequestRepositoryAdapter,
  OrchestratorSessionRepositoryAdapter,
  OwnerItemRepositoryAdapter,
  OwnerQuestionRepositoryAdapter,
  PermissionRequestRepositoryAdapter,
  ProjectProfileRepositoryAdapter,
  RelayTransportAdapter,
  hashOrchestratorRequestDigest,
  resolvePinnedOwnerPublicKey,
  type ChangeSignalPort,
} from "@fleet/operator-coordination";

import type { FleetInstallation } from "@fleet/installation";
import {
  AttemptRepositoryAdapter,
  LaneRunJournalAdapter,
  WorkOrderRepositoryAdapter,
} from "@fleet/work-execution";
import type { LaneRunJournalEntryRecord } from "@fleet/work-execution";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { newUlid } from "../work/ulid.js";

/** The SHA-256 hex digest a shadow import grant's request id is bound by. */
function computeSha256HexDigest(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}
import {
  AcknowledgeOwnerAnswerUseCase,
  AnswerOwnerQuestionUseCase,
  AskOwnerQuestionUseCase,
  ExpireOwnerQuestionsUseCase,
  GiveToolPermissionVerdictUseCase,
  HeartbeatOrchestratorSessionUseCase,
  InspectConfiguredCapabilitiesUseCase,
  InspectOutstandingCoordinationUseCase,
  InspectProjectProfileUseCase,
  ListOrchestratorSessionsUseCase,
  ListOwnerQuestionsUseCase,
  ListProjectProfilesUseCase,
  PublishProjectObservationUseCase,
  ReadOwnerQuestionUseCase,
  ReadProjectAttentionUseCase,
  ReconcileOrchestratorRequestUseCase,
  RecordAuthorizationConsumptionUseCase,
  RecordOwnerItemUseCase,
  RecordProjectProbeUseCase,
  RecordRelayAcknowledgementUseCase,
  RegisterOrchestratorSessionUseCase,
  RegisterProjectProfileUseCase,
  RequestScopedDecisionUseCase,
  RequestToolPermissionUseCase,
  ResolveActionAuthorizationUseCase,
  ResolveOwnerItemUseCase,
  RetireOrchestratorSessionUseCase,
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
  resolveOwnerItem: ResolveOwnerItemUseCase;
  checkOwnerDecision: CheckOwnerDecisionUseCase;
  recordAuthorizationConsumption: RecordAuthorizationConsumptionUseCase;
  recordOwnerItem: RecordOwnerItemUseCase;
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
  registerOrchestratorSession: RegisterOrchestratorSessionUseCase;
  heartbeatOrchestratorSession: HeartbeatOrchestratorSessionUseCase;
  retireOrchestratorSession: RetireOrchestratorSessionUseCase;
  listOrchestratorSessions: ListOrchestratorSessionsUseCase;
  permissionRequestRepository: PermissionRequestRepositoryAdapter;
  requestToolPermission: RequestToolPermissionUseCase;
  giveToolPermissionVerdict: GiveToolPermissionVerdictUseCase;
  orchestratorRequestRepository: OrchestratorRequestRepositoryAdapter;
  reconcileOrchestratorRequest: ReconcileOrchestratorRequestUseCase;
}

export interface OperatorCompositionOptions {
  readonly stateDir?: string;
  readonly installation?: FleetInstallation;
  /** The runtime's own environment object (tests inject a record here); defaults to `process.env`. */
  readonly env?: Record<string, string | undefined>;
  /** Emitter for post-save change signals; the API runtime wires the change feed. */
  readonly changeSignal?: ChangeSignalPort;
  /** The explicit-deny deadline for tool-permission requests, in ms (default 540 000). */
  readonly permissionDeadlineMs?: number;
  /** The clock for orchestrator-request reconciliation; defaults to the system clock. */
  readonly clock?: () => string;
}

let composition: OperatorComposition | undefined;
let configured: OperatorComposition | undefined;

function unconfiguredOperatorComposition(): OperatorComposition {
  const permissionRequestRepository = new PermissionRequestRepositoryAdapter();
  return {
    coordinationRequestRepository: new CoordinationRequestRepositoryAdapter(),
    inspectConfiguredCapabilities: new InspectConfiguredCapabilitiesUseCase(),
    publishProjectObservation: new PublishProjectObservationUseCase(),
    requestScopedDecision: new RequestScopedDecisionUseCase(),
    resolveActionAuthorization: new ResolveActionAuthorizationUseCase(),
    resolveOwnerItem: new ResolveOwnerItemUseCase(),
    checkOwnerDecision: new CheckOwnerDecisionUseCase(),
    recordAuthorizationConsumption: new RecordAuthorizationConsumptionUseCase(),
    recordOwnerItem: new RecordOwnerItemUseCase(),
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
    registerOrchestratorSession: new RegisterOrchestratorSessionUseCase(),
    heartbeatOrchestratorSession: new HeartbeatOrchestratorSessionUseCase(),
    retireOrchestratorSession: new RetireOrchestratorSessionUseCase(),
    listOrchestratorSessions: new ListOrchestratorSessionsUseCase(),
    permissionRequestRepository,
    requestToolPermission: new RequestToolPermissionUseCase({ repository: permissionRequestRepository }),
    giveToolPermissionVerdict: new GiveToolPermissionVerdictUseCase({
      repository: permissionRequestRepository,
    }),
    orchestratorRequestRepository: new OrchestratorRequestRepositoryAdapter(),
    reconcileOrchestratorRequest: new ReconcileOrchestratorRequestUseCase(),
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
  // KEY0b: the owner public key is read ONLY from the pinned
  // installation.owner.publicKey. FLEET_OWNER_PUBLIC_KEY is never an
  // authority: a mismatching value refuses, an equal value only warns once.
  const resolvedOwnerKey = resolvePinnedOwnerPublicKey(
    options?.installation?.owner?.publicKey,
    options?.env ?? process.env,
  );
  const ownerPublicKey =
    resolvedOwnerKey.status === "pinned" ? resolvedOwnerKey.publicKey : undefined;
  const ownerKeyRefusal =
    resolvedOwnerKey.status === "pinned" ? undefined : resolvedOwnerKey.code;
  if (resolvedOwnerKey.status === "pinned" && resolvedOwnerKey.deprecationWarning !== undefined) {
    process.stderr.write(`${resolvedOwnerKey.deprecationWarning}\n`);
  }

  const profileRepo = new ProjectProfileRepositoryAdapter({
    stateDir,
    ...(options?.changeSignal ? { changeSignal: options.changeSignal } : {}),
  });
  const requestRepo = new CoordinationRequestRepositoryAdapter({ stateDir });
  const decisionTransport = new DecisionTransportAdapter({
    decisionsDir: stateDir === undefined ? undefined : join(stateDir, "decisions"),
    ownerPublicKey,
    ...(ownerKeyRefusal !== undefined ? { ownerKeyRefusal } : {}),
  });
  const publicationPort = new ObservationPublicationAdapter(
    stateDir === undefined ? {} : { outboxDir: join(stateDir, "observation-outbox") },
  );
  const attentionPort = new AttentionReadAdapter();
  const relayTransport = new RelayTransportAdapter(
    stateDir === undefined ? {} : { outboxDir: join(stateDir, "relay-outbox") },
  );
  const ownerQuestionRepo = new OwnerQuestionRepositoryAdapter({
    stateDir,
    ...(options?.changeSignal ? { changeSignal: options.changeSignal } : {}),
  });
  const orchestratorSessionRepo = new OrchestratorSessionRepositoryAdapter({
    stateDir,
    ...(options?.changeSignal ? { changeSignal: options.changeSignal } : {}),
  });
  const ownerItemRepo = new OwnerItemRepositoryAdapter({
    stateDir,
    ...(options?.changeSignal ? { changeSignal: options.changeSignal } : {}),
  });
  // Tool-permission requests are in-process memory only: one adapter instance,
  // shared by both use cases so a verdict posted on the route reaches the
  // waiting request. It takes no stateDir and writes no file.
  const permissionRequestRepository = new PermissionRequestRepositoryAdapter();

  // O2c: the orchestrator-request store and the shared run-journal delegate.
  // The journal adapter is a second file-backed `LaneRunJournalAdapter` on the
  // same stateDir, sharing `run-journal.json` with the work composition under
  // the existing lock (the work composition's own adapter stays read-only).
  const orchestratorRequestRepository = new OrchestratorRequestRepositoryAdapter({
    stateDir,
    ...(options?.changeSignal ? { changeSignal: options.changeSignal } : {}),
  });
  const runJournal = new LaneRunJournalAdapter({ stateDir });
  const orchestratorRequestJournal = new OrchestratorRequestJournalAdapter({
    append: (entry) => runJournal.append(entry as unknown as LaneRunJournalEntryRecord),
    listForKey: (key) => runJournal.listForKey(key),
  });
  const reconcileClock = { nowIso: options?.clock ?? (() => new Date().toISOString()) };
  const reconcileOrchestratorRequest = new ReconcileOrchestratorRequestUseCase({
    requestRepo: orchestratorRequestRepository,
    sessionRepo: orchestratorSessionRepo,
    profileRepo,
    journal: orchestratorRequestJournal,
    clock: reconcileClock,
    hashDigest: hashOrchestratorRequestDigest,
    mintEntryId: newUlid,
  });

  // CO24f: the attempt facts the authorization resolve binds owner grants
  // against, read through the execution stack's own repositories.
  const attemptRepo = new AttemptRepositoryAdapter({ stateDir });
  const attemptWorkOrderRepo = new WorkOrderRepositoryAdapter({ stateDir });
  const attemptFactsRead = {
    findAttemptFactsById: async (attemptId: string) => {
      const attempt = await attemptRepo.findAttemptById(attemptId);
      if (attempt === null) {
        return null;
      }
      const workOrder = await attemptWorkOrderRepo.findWorkOrderById(attempt.workOrderId);
      return {
        attemptId,
        projectId: workOrder?.projectId ?? null,
        collectedHeadSha: attempt.artifacts?.headCommit ?? null,
      };
    },
  };

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
      // The shadow import grant's moment is the composition root's clock
      // alone: no request body ever supplies it.
      shadowImportClock: systemClock,
      // The request id a shadow import grant is bound by carries this digest.
      computeDigest: computeSha256HexDigest,
    }),
    resolveActionAuthorization: new ResolveActionAuthorizationUseCase({
      requestRepo,
      decisionTransport,
      attemptFactsRead,
      // The standing shadow import grant resolves head-free: its digest and
      // expiry are re-checked here with the root's own clock and digest.
      shadowImportClock: systemClock,
      computeDigest: computeSha256HexDigest,
    }),
    resolveOwnerItem: new ResolveOwnerItemUseCase({
      itemRepo: ownerItemRepo,
      ownerQuestionRepo,
      clock: systemClock,
    }),
    checkOwnerDecision: new CheckOwnerDecisionUseCase({ requestRepo, decisionTransport }),
    recordAuthorizationConsumption: new RecordAuthorizationConsumptionUseCase({
      requestRepo,
      decisionTransport,
    }),
    readProjectAttention: new ReadProjectAttentionUseCase({ attentionPort }),
    recordOwnerItem: new RecordOwnerItemUseCase({
      itemRepo: ownerItemRepo,
      clock: systemClock,
      ids: { newItemId: () => newUlid() },
    }),
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
    registerOrchestratorSession: new RegisterOrchestratorSessionUseCase({
      sessionRepo: orchestratorSessionRepo,
      clock: systemClock,
    }),
    heartbeatOrchestratorSession: new HeartbeatOrchestratorSessionUseCase({
      sessionRepo: orchestratorSessionRepo,
      clock: systemClock,
    }),
    retireOrchestratorSession: new RetireOrchestratorSessionUseCase({
      sessionRepo: orchestratorSessionRepo,
      clock: systemClock,
    }),
    listOrchestratorSessions: new ListOrchestratorSessionsUseCase({
      sessionRepo: orchestratorSessionRepo,
      clock: systemClock,
    }),
    permissionRequestRepository,
    requestToolPermission: new RequestToolPermissionUseCase({
      repository: permissionRequestRepository,
      ...(options?.permissionDeadlineMs !== undefined
        ? { deadlineMs: options.permissionDeadlineMs }
        : {}),
    }),
    giveToolPermissionVerdict: new GiveToolPermissionVerdictUseCase({
      repository: permissionRequestRepository,
    }),
    orchestratorRequestRepository,
    reconcileOrchestratorRequest,
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
