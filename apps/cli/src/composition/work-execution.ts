/**
 * Work-execution composition (SPLIT-2): builds the execution object and the
 * consumer-side adapters from the shared root inputs; called by the CLI
 * composition root.
 */
import { join } from 'node:path';

import { withFileLock, writeJsonAtomically } from '../file-store.js';
import { newUlid } from '../ulid.js';
import { autoMergeSettingsFromLoad } from '../auto-merge-settings.js';

import {
  AcceptanceAssessmentAdapter,
  AcceptanceEvidenceAdapter,
  ActionAuthorizationAdapter,
  AllowedSeatAdapter,
  AutoMergeAttemptUseCase,
  AutoMergeOwnerRoutingAdapter,
  BriefKnowledgeAdapter,
  CollectAttemptArtifactsUseCase,
  CommitEditOnlyAttemptUseCase,
  DispatchAttemptUseCase,
  ExecuteAuthorizedForgeActionUseCase,
  ExecutionObservationAdapter,
  GatePredicateAdapter,
  InspectAttemptUseCase,
  InspectWorkOrderUseCase,
  LaneDiffCheckAdapter,
  ListUnregisteredProjectsUseCase,
  LocalExecutor,
  PolicyMergeGrantAdapter,
  PrepareBriefPackageUseCase,
  PrepareFixAttemptUseCase,
  ProbeProjectUseCase,
  ProjectProbeAdapter,
  ReconcileAttemptUseCase,
  RegisterWorkOrderUseCase,
  RequestAttemptAcceptanceUseCase,
  ReserveExecutionCapacityUseCase,
  StopAttemptUseCase,
  consumptionId,
  forgeActionScope,
  observationEventKind,
  sha256HexDigest,
  type AgyRunnerAdapter,
  type AttemptArtifactAdapter,
  type AttemptRecord,
  type AttemptRepositoryAdapter,
  type AutoMergeSettingsPort,
  type BriefAuthoringAdapter,
  type ExecutionJournalAdapter,
  type ExecutionRunnerAdapter,
  type ExecutionRunnerHost,
  type ExecutorForHost,
  type ExecutorForRecordedHostResult,
  type ForgeActionAdapter,
  type ForgeReadAdapter,
  type OpencodeDbUsageAdapter,
  type ProjectProfileReadPort,
  type ProjectProbeRecordAdapter,
  type RunnerForAttemptAdapter,
  type RunnerSelectorAdapter,
  type WorkOrderRepositoryAdapter,
  type WorkspaceAdapter,
  type resolveInstallationForgeMode,
  type resolveRunnerCapabilityProfile,
} from '@fleet/work-execution';
import { assessmentIdForAttempt } from '@fleet/evidence-and-acceptance';
import {
  type AttemptOwnerDecisionAdapter,
  type OwnerDecisionAdapter,
} from '@fleet/evidence-and-acceptance';
import {
  type CoordinationRequestRepositoryAdapter,
  type IssuePolicyForgeGrantUseCase,
} from '@fleet/operator-coordination';
import {
  type FleetInstallationModel,
  type LoadResult,
} from '@fleet/installation';

import type { FleetCliRuntime, FleetCliRuntimeOptions } from '../composition.js';
import type { readJsonRecord } from '../composition.js';

/** Grant-to-attempt binding persisted for cross-process forge execution. */
interface AuthorizationCoordinates {
  readonly attemptId: string;
  readonly expectedHeadSha: string;
}

export interface ComposeExecutionInput {
  readonly stateDir?: string;
  readonly options?: FleetCliRuntimeOptions;
  readonly installationModel?: FleetInstallationModel;
  readonly runnerHost?: ExecutionRunnerHost;
  readonly runnerProfile: ReturnType<typeof resolveRunnerCapabilityProfile>;
  readonly forgeMode: ReturnType<typeof resolveInstallationForgeMode>;
  readonly autoMergeLoad: () => LoadResult;
  readonly evidence: FleetCliRuntime['evidence'];
  readonly knowledge: FleetCliRuntime['knowledge'];
  readonly coordination: FleetCliRuntime['coordination'];
  readonly coordinationRequestRepository: CoordinationRequestRepositoryAdapter;
  readonly ownerDecision: OwnerDecisionAdapter;
  readonly attemptOwnerDecision: AttemptOwnerDecisionAdapter;
  readonly attemptLookup: { inspectAttempt?: InspectAttemptUseCase };
  readonly forgeRead: ForgeReadAdapter;
  readonly issuePolicyForgeGrantUseCase: IssuePolicyForgeGrantUseCase;
  readonly profileRead: ProjectProfileReadPort;
  readonly probeRecord: ProjectProbeRecordAdapter;
  readonly executorForHostName: (name: string) => ExecutorForRecordedHostResult;
  readonly workOrderRepository: WorkOrderRepositoryAdapter;
  readonly attemptRepository: AttemptRepositoryAdapter;
  readonly executionJournal: ExecutionJournalAdapter;
  readonly executorForHost: ExecutorForHost;
  readonly workspace: WorkspaceAdapter;
  readonly runner: ExecutionRunnerAdapter;
  readonly runnerForAttempt: RunnerForAttemptAdapter;
  readonly agyRunner?: AgyRunnerAdapter;
  readonly runnerSelector: RunnerSelectorAdapter;
  readonly attemptArtifact: AttemptArtifactAdapter;
  readonly opencodeDbUsage: OpencodeDbUsageAdapter;
  readonly briefAuthoring: BriefAuthoringAdapter;
  readonly forgeAction: ForgeActionAdapter;
  readonly editOnlyModeOf: (
    attempt: AttemptRecord,
    hosts: FleetInstallationModel['hosts'] | undefined,
  ) => 'edit-only' | 'not-edit-only' | 'unknown';
  readonly readJsonRecord: typeof readJsonRecord;
}

export function composeExecution(input: ComposeExecutionInput) {
  const {
    stateDir,
    options,
    installationModel,
    runnerHost,
    runnerProfile,
    forgeMode,
    autoMergeLoad,
    evidence,
    knowledge,
    coordination,
    coordinationRequestRepository,
    ownerDecision,
    attemptOwnerDecision,
    attemptLookup,
    forgeRead,
    issuePolicyForgeGrantUseCase,
    profileRead,
    probeRecord,
    executorForHostName,
    workOrderRepository,
    attemptRepository,
    executionJournal,
    executorForHost,
    workspace,
    runner,
    runnerForAttempt,
    agyRunner,
    runnerSelector,
    attemptArtifact,
    opencodeDbUsage,
    briefAuthoring,
    forgeAction,
    editOnlyModeOf,
    readJsonRecord,
  } = input;

  // Live registry of acceptance receipts per candidate head: the acceptance
  // delegate records entries and the merge gate consumes them, so a merge is
  // only ever authorized for a head whose acceptance receipt exists. With a
  // stateDir the registry is backed by `<stateDir>/accepted-receipts.json`:
  // every read reloads the file first, so a separate CLI process running
  // `forge execute --kind merge-pr` sees receipts recorded by an earlier
  // `attempt accept` / `evidence assess` process.
  const acceptedReceiptsPath =
    stateDir === undefined ? undefined : join(stateDir, 'accepted-receipts.json');
  const acceptedReceiptByHead: Record<string, string> = {};
  const acceptedReceiptByHeadView: Record<string, string> =
    acceptedReceiptsPath === undefined
      ? acceptedReceiptByHead
      : new Proxy(acceptedReceiptByHead, {
          get(target, prop) {
            if (typeof prop === 'string') {
              Object.assign(target, readJsonRecord<string>(acceptedReceiptsPath));
              return target[prop];
            }
            return undefined;
          },
        });

  const acceptanceAssessment = new AcceptanceAssessmentAdapter({
    assess: async (request) => {
      const assessmentId = assessmentIdForAttempt(request.attemptId);
      // Always delegate to the use case: it re-checks the attempt's one-way
      // doors before its idempotent accepted path, so a stored acceptance
      // whose owner decision has been withdrawn still blocks here.
      const result = await evidence.assessHeadAcceptance.assessHeadAcceptance({
        assessmentId,
        candidateHeadSha: request.candidateHeadSha,
        policyRevision: request.policyRevision,
      });
      if (result.outcome === 'accepted') {
        acceptedReceiptByHead[result.candidateHeadSha] = result.receiptId;
        if (acceptedReceiptsPath !== undefined) {
          await withFileLock(`${acceptedReceiptsPath}.lock`, async () => {
            const current = readJsonRecord<string>(acceptedReceiptsPath);
            current[result.candidateHeadSha] = result.receiptId;
            await writeJsonAtomically(acceptedReceiptsPath, current);
          });
        }
        return {
          outcome: 'accepted',
          receiptId: result.receiptId,
          assessedHeadSha: result.candidateHeadSha,
        };
      }
      if (result.outcome === 'blocked') {
        return {
          outcome: 'rejected',
          reason: `Acceptance blocked: ${result.blockers.join('; ')}`,
          blockerDetails: result.blockerDetails.map((blocker) => ({
            kind: blocker.kind,
            text: blocker.text,
          })),
        };
      }
      if (result.outcome === 'stale') {
        return {
          outcome: 'rejected',
          reason: result.reason,
          blockerDetails: [{ kind: 'stale', text: result.reason }],
        };
      }
      // `rejected` and `stale` both leave the action without a pass; the kind says which.
      return {
        outcome: 'rejected',
        reason: result.reason,
        blockerDetails: [{ kind: 'other', text: result.reason }],
      };
    },
  });

  const acceptanceEvidence = new AcceptanceEvidenceAdapter({
    readAcceptance: async (request) => {
      let inspected = await evidence.inspectAcceptanceEvidence.inspectAcceptanceEvidence({
        assessmentId: assessmentIdForAttempt(request.attemptId),
        candidateHeadSha: request.candidateHeadSha,
      });
      if (inspected.outcome === 'not-found') {
        inspected = await evidence.inspectAcceptanceEvidence.inspectAcceptanceEvidence({
          assessmentId: request.attemptId,
          candidateHeadSha: request.candidateHeadSha,
        });
      }
      // No head-only fallback: an assessment that is not bound to this attempt
      // is another attempt's evidence, and this attempt has none.
      if (
        inspected.outcome === 'found' &&
        inspected.assessment.attemptId !== request.attemptId
      ) {
        return {
          outcome: 'not-found',
          reason: `No acceptance assessment found for head ${request.candidateHeadSha}`,
        };
      }
      if (inspected.outcome === 'found') {
        return {
          outcome: 'found',
          assessment: {
            candidateHeadSha: inspected.assessment.candidateHeadSha,
            policyRevision: inspected.assessment.policyRevision,
            state: inspected.assessment.state,
            acceptanceReceiptId: inspected.assessment.acceptanceReceiptId,
          },
        };
      }
      return {
        outcome: 'not-found',
        reason: `No acceptance assessment found for head ${request.candidateHeadSha}`,
      };
    },
  });

  const briefKnowledge = new BriefKnowledgeAdapter({
    propose: async (request) => {
      const result = await knowledge.proposeBriefContext.proposeBriefContext({
        projectId: request.projectId,
        laneId: request.laneId,
        taskSummary: request.taskSummary,
      });
      return result.outcome === 'proposed'
        ? {
            outcome: 'proposed',
            proposals: result.proposals.map((proposal) => ({
              proposalId: proposal.proposalId,
              knowledgeEntryId: proposal.knowledgeEntryId,
              version: proposal.version,
              proposedBecause: proposal.proposedBecause,
            })),
          }
        : { outcome: 'unavailable', reason: result.reason };
    },
    recordSelection: async (request) => {
      const result = await knowledge.recordContextSelection.recordContextSelection({
        attemptId: request.attemptId,
        selections: request.selections.map((selection) => ({
          proposalId: selection.proposalId,
          knowledgeEntryId: selection.knowledgeEntryId,
          version: selection.version,
          accepted: selection.accepted,
          decisionBecause: selection.decisionBecause,
        })),
      });
      return result.outcome === 'recorded'
        ? { outcome: 'recorded' }
        : { outcome: 'refused', reason: result.reason };
    },
    forwardNotes: async (request) => {
      // The consumer-side contract carries no project identity; the work order
      // owns it, so the delegation resolves it before capturing notes.
      const workOrder = await workOrderRepository.findWorkOrderById(request.workOrderId);
      if (workOrder === null) {
        return { outcome: 'refused', reason: `Work order not found: ${request.workOrderId}` };
      }
      const result = await knowledge.captureCompletedAttemptNotes.captureCompletedAttemptNotes({
        projectId: workOrder.projectId,
        attemptId: request.attemptId,
        workOrderId: request.workOrderId,
        headCommitSha: request.headCommit,
        notesMarkdown: request.notes,
      });
      return result.outcome === 'captured'
        ? { outcome: 'forwarded' }
        : { outcome: 'refused', reason: result.reason };
    },
  });

  // Grant-to-attempt coordinates recorded when the authorization delegate
  // resolves a grant. With a stateDir they are mirrored to
  // `<stateDir>/authorization-coordinates.json`, so a separate CLI process
  // running `forge execute` after an earlier `coordination resolve-auth`
  // process finds the grant's bound attempt and expected head.
  const authorizationCoordinatesPath =
    stateDir === undefined ? undefined : join(stateDir, 'authorization-coordinates.json');
  const resolveCoordinates = new Map<string, AuthorizationCoordinates>();

  const actionAuthorization = new ActionAuthorizationAdapter({
    resolveGrant: async (request) => {
      const result = await coordination.resolveActionAuthorization.resolveActionAuthorization({
        projectId: request.projectId,
        actionScope: forgeActionScope(request.actionKind),
        expectedHeadSha: request.expectedHeadSha,
      });
      if (result.outcome === 'authorized') {
        resolveCoordinates.set(result.grantId, {
          attemptId: request.attemptId,
          expectedHeadSha: request.expectedHeadSha,
        });
        if (authorizationCoordinatesPath !== undefined) {
          await withFileLock(`${authorizationCoordinatesPath}.lock`, async () => {
            const current =
              readJsonRecord<AuthorizationCoordinates>(authorizationCoordinatesPath);
            current[result.grantId] = {
              attemptId: request.attemptId,
              expectedHeadSha: request.expectedHeadSha,
            };
            await writeJsonAtomically(authorizationCoordinatesPath, current);
          });
        }
        return { outcome: 'granted', authorizationGrantId: result.grantId };
      }
      return { outcome: 'blocked', reason: result.reason };
    },
    consumeGrant: async (request) => {
      // The consumer-side consumption request carries only grant and action
      // identities; the head and the bound attempt are resolved from the
      // recorded grant so the coordination context can durably bind them.
      const grant = await coordinationRequestRepository.findRequestByGrantId(
        request.authorizationGrantId,
      );
      if (grant === null) {
        return { outcome: 'refused', reason: `Authorization grant not recorded: ${request.authorizationGrantId}` };
      }
      if (grant.expectedHeadSha === null) {
        return {
          outcome: 'refused',
          reason: `Authorization grant ${request.authorizationGrantId} records no expected head`,
        };
      }
      if (grant.actionScope !== forgeActionScope(request.actionKind)) {
        return {
          outcome: 'refused',
          reason: `Authorization grant ${request.authorizationGrantId} was recorded for scope ${grant.actionScope}, not ${forgeActionScope(request.actionKind)}`,
        };
      }
      if (grant.expectedHeadSha !== request.expectedHeadSha) {
        return {
          outcome: 'refused',
          reason: `Authorization grant ${request.authorizationGrantId} was recorded for head ${grant.expectedHeadSha}, not ${request.expectedHeadSha}`,
        };
      }
      // Coordinates recorded at resolve time bind the grant to its attempt;
      // a fresh process reloads them from disk before falling back to the
      // head-matching scan over all recorded attempts.
      if (
        !resolveCoordinates.has(request.authorizationGrantId) &&
        authorizationCoordinatesPath !== undefined
      ) {
        for (const [grantId, coordinates] of Object.entries(
          readJsonRecord<AuthorizationCoordinates>(authorizationCoordinatesPath),
        )) {
          if (
            typeof coordinates.attemptId === 'string' &&
            typeof coordinates.expectedHeadSha === 'string'
          ) {
            resolveCoordinates.set(grantId, {
              attemptId: coordinates.attemptId,
              expectedHeadSha: coordinates.expectedHeadSha,
            });
          }
        }
      }
      const coordinates = resolveCoordinates.get(request.authorizationGrantId);
      const boundAttempt =
        coordinates === undefined
          ? null
          : await attemptRepository.findAttemptById(coordinates.attemptId);
      const attempt =
        boundAttempt !== null && boundAttempt.artifacts?.headCommit === request.expectedHeadSha
          ? boundAttempt
          : (await attemptRepository.listAllAttempts()).find(
              (candidate) => candidate.artifacts?.headCommit === request.expectedHeadSha,
            );
      if (attempt === undefined) {
        return {
          outcome: 'refused',
          reason:
            `No collected attempt matches the head recorded for grant ${request.authorizationGrantId}`,
        };
      }
      const result = await coordination.recordAuthorizationConsumption.recordAuthorizationConsumption({
        consumptionId: consumptionId(request.actionId),
        grantId: request.authorizationGrantId,
        actionId: request.actionId,
        actionScope: forgeActionScope(request.actionKind),
        attemptId: attempt.id,
        expectedHeadSha: grant.expectedHeadSha,
      });
      return result.outcome === 'consumed'
        ? { outcome: 'consumed', actionId: request.actionId }
        : { outcome: 'refused', reason: result.reason };
    },
  });

  const executionObservation = new ExecutionObservationAdapter({
    publish: async (request) => {
      const result = await coordination.publishProjectObservation.publishProjectObservation({
        observationId: request.entry.id,
        projectId: request.projectId,
        eventKind: observationEventKind(request.entry.action, request.entry.status),
        sourceAttemptId: request.entry.attemptId,
        payloadSummary: JSON.stringify(request.entry),
      });
      return result.outcome === 'published'
        ? { outcome: 'published' }
        : { outcome: 'delivery-gap', reason: result.reason };
    },
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

  // GP-wire: the frozen gate for auto-merge and the conductor. It runs the predicates on the attempt's recorded
  // host through the same recorded-host executor as artifact reads, journals each predicate, and checks the
  // frozen brief's digest with the same SHA-256 prepare uses. `attempt accept` keeps its own instance.
  const composedAttemptGate = new RequestAttemptAcceptanceUseCase({
    attemptRepo: attemptRepository,
    workOrderRepo: workOrderRepository,
    acceptancePort: acceptanceAssessment,
    artifactPort: attemptArtifact,
    allowedSeats,
    gatePredicates: new GatePredicateAdapter({
      executorForRecordedHost: (recorded) => executorForHost.executorForRecordedHost(recorded),
    }),
    journal: executionJournal,
    computeDigest: sha256HexDigest,
  });
  const attemptGate = options?.attemptGate ?? composedAttemptGate;

  const execution = {
    workOrderRepository,
    attemptRepository,
    executionJournal,
    workspace,
    runner,
    runnerForAttempt,
    ...(runnerHost !== undefined ? { runnerHost } : {}),
    // The runner entry's lane budget (D4/D6 plan item 4); undefined without a
    // declared lane-runner entry, in which case the request default applies.
    runnerMaxLanes: runnerProfile?.maxLanes,
    attemptArtifact,
    opencodeDbUsage,
    briefAuthoring,
    acceptanceAssessment,
    acceptanceEvidence,
    actionAuthorization,
    briefKnowledge,
    executionObservation,
    forgeAction,
    forgeRead,
    probeProject: new ProbeProjectUseCase({
      profileRead,
      probe: new ProjectProbeAdapter({
        orchestrator: new LocalExecutor(),
        executorForHost: executorForHostName,
      }),
      probeRecord,
      verificationProcedureNames:
        options?.installation?.schemaVersion === 2
          ? Object.keys(options?.installation?.verification?.procedures ?? {})
          : null,
    }),
    listUnregisteredProjects: new ListUnregisteredProjectsUseCase({
      workOrderRepo: workOrderRepository,
      profileRead,
    }),
    registerWorkOrder: new RegisterWorkOrderUseCase({
      workOrderRepo: workOrderRepository,
      profileRead,
    }),
    inspectWorkOrder: new InspectWorkOrderUseCase({
      workOrderRepo: workOrderRepository,
      attemptRepo: attemptRepository,
      journal: executionJournal,
    }),
    inspectAttempt: new InspectAttemptUseCase({
      attemptRepo: attemptRepository,
      runnerForAttempt,
    }),
    prepareBriefPackage: new PrepareBriefPackageUseCase({
      briefAuthoring,
      artifactPort: attemptArtifact,
      briefKnowledge,
      computeDigest: sha256HexDigest,
    }),
    reserveExecutionCapacity: new ReserveExecutionCapacityUseCase({
      journal: executionJournal,
      attemptRepo: attemptRepository,
    }),
    dispatchAttempt: new DispatchAttemptUseCase({
      workOrderRepo: workOrderRepository,
      attemptRepo: attemptRepository,
      journal: executionJournal,
      workspace,
      runner,
      runnerSelector,
      ...(agyRunner !== undefined ? { agyRunner } : {}),
      observation: executionObservation,
      artifactPort: attemptArtifact,
      computeDigest: sha256HexDigest,
      allowedSeats,
    }),
    commitEditOnlyAttempt: new CommitEditOnlyAttemptUseCase({
      attemptRepo: attemptRepository,
      journal: executionJournal,
      workspace,
      artifactPort: attemptArtifact,
      laneDiffCheckFor: (attempt) => {
        const resolved = executorForHost.executorForRecordedHost(attempt.runner ?? null);
        return resolved.ok ? new LaneDiffCheckAdapter(resolved.executor) : null;
      },
      editOnlyModeOf: (attempt) => editOnlyModeOf(attempt, installationModel?.hosts),
      computeDigest: sha256HexDigest,
    }),
    reconcileAttempt: new ReconcileAttemptUseCase({
      attemptRepo: attemptRepository,
      journal: executionJournal,
      runner,
      runnerForAttempt,
    }),
    stopAttempt: new StopAttemptUseCase({
      attemptRepo: attemptRepository,
      journal: executionJournal,
      runner,
      runnerForAttempt,
    }),
    collectAttemptArtifacts: new CollectAttemptArtifactsUseCase({
      attemptRepo: attemptRepository,
      journal: executionJournal,
      artifactPort: attemptArtifact,
      briefKnowledge,
      runnerForAttempt,
      usage: opencodeDbUsage,
    }),
    prepareFixAttempt: new PrepareFixAttemptUseCase({ attemptRepo: attemptRepository }),
    requestAttemptAcceptance: new RequestAttemptAcceptanceUseCase({
      attemptRepo: attemptRepository,
      workOrderRepo: workOrderRepository,
      acceptancePort: acceptanceAssessment,
      artifactPort: attemptArtifact,
      allowedSeats,
    }),
    attemptGate: composedAttemptGate,
    executeAuthorizedForgeAction: new ExecuteAuthorizedForgeActionUseCase({
      attemptRepo: attemptRepository,
      workOrderRepo: workOrderRepository,
      journal: executionJournal,
      authorizationPort: actionAuthorization,
      forgePort: forgeAction,
      acceptedReceiptByHead: acceptedReceiptByHeadView,
      acceptanceEvidencePort: acceptanceEvidence,
      // Forge actions re-check the attempt's one-way doors through the same
      // owner-decision resolution acceptance uses.
      ownerDecisionPort: ownerDecision,
      attemptOwnerDecisionPort: attemptOwnerDecision,
      // Forge mode `none` (D6) refuses every forge action.
      ...(forgeMode === 'none' ? { forgeMode: 'none' as const } : {}),
    }),
    // Assigned after the object closes (AM5-3): it depends on the use cases
    // above, so it cannot be part of the literal.
    autoMergeAttempt: undefined as unknown as AutoMergeAttemptUseCase,
  };

  // AM5-3: compose the auto-merge attempt use case over the consumer adapters
  // and the coordination use cases. The settings are re-read from a fresh
  // installation on every call (A7); a throwing loader is an unreadable answer.
  const autoMergeSettingsPort: AutoMergeSettingsPort = {
    async readAutoMergeSettings() {
      try {
        return autoMergeSettingsFromLoad(autoMergeLoad());
      } catch {
        return { outcome: 'unreadable', reason: 'settings port threw' };
      }
    },
  };
  execution.autoMergeAttempt = new AutoMergeAttemptUseCase({
    settings: autoMergeSettingsPort,
    attemptRepo: attemptRepository,
    workOrderRepo: workOrderRepository,
    journal: executionJournal,
    attemptOwnerDecisionPort: attemptOwnerDecision,
    evaluateAttemptGate: attemptGate,
    acceptancePort: acceptanceAssessment,
    routing: new AutoMergeOwnerRoutingAdapter({
      askOwnerQuestion: coordination.askOwnerQuestion,
      recordAttentionItem: coordination.recordAttentionItem,
      newQuestionId: () => 'question-' + newUlid(),
    }),
    policyMergeGrant: new PolicyMergeGrantAdapter({
      issuePolicyForgeGrant: issuePolicyForgeGrantUseCase,
    }),
    executeForgeAction: execution.executeAuthorizedForgeAction,
    nowIso: () => new Date().toISOString(),
  });

  attemptLookup.inspectAttempt = execution.inspectAttempt;

  return { execution };
}
