/**
 * Conductor composition (SPLIT-2): builds the conductor object from the shared
 * root inputs; called by the CLI composition root.
 */
import { newUlid } from '../ulid.js';
import { autoMergeSettingsFromLoad } from '../auto-merge-settings.js';

import {
  ActionAuthorizationAdapter,
  AttemptRepositoryAdapter,
  AttemptArtifactAdapter,
  ConductorForgeGrantAdapter,
  LaneRunParkNoticeAdapter,
  CiStateAdapter,
  ConductorDriverLeaseAdapter,
  ConductorHaltAdapter,
  ConductorPassTraceAdapter,
  ExecutionJournalAdapter,
  GateReceiptAdapter,
  InspectLaneRunsUseCase,
  LaneRunJournalAdapter,
  LaneRunRepositoryAdapter,
  ListConductorPassesUseCase,
  ListLaneRunsUseCase,
  ReapLaneWorktreesUseCase,
  ReapOrphanSessionsUseCase,
  RequestLaneRunStopUseCase,
  ResumeLaneRunUseCase,
  ReviewAssessmentAdapter,
  ReviewRequestAdapter,
  WorkspaceAdapter,
  WorkOrderRepositoryAdapter,
  sha256HexDigest,
  unsealedWorktreeRemovalActionId,
  unsealedWorktreeRemovalScope,
  consumptionId,
  type AuthorizeUnsealedWorktreeRemovalRequest,
  type AuthorizeUnsealedWorktreeRemovalResult,
  type ForgeReadAdapter,
  type ProjectProfileReadPort,
  type RunnerForAttemptPort,
} from '@fleet/work-execution';
import type { CoordinationRequestRepositoryAdapter } from '@fleet/operator-coordination';

import { conductorRevision, resolveConductorPolicy } from '@fleet/installation';
import { assessmentIdForAttempt } from '@fleet/evidence-and-acceptance';

import type { FleetCliRuntime } from '../composition.js';
import type { FleetInstallation, LoadResult } from '@fleet/installation';
import type {
  AskOwnerQuestionRequest,
  IssuePolicyForgeGrantUseCase,
} from '@fleet/operator-coordination';

export interface ComposeConductorInput {
  readonly stateDir?: string;
  readonly evidence: FleetCliRuntime['evidence'];
  readonly profileRead: ProjectProfileReadPort;
  /** The attention and owner-question use cases the park notices delegate to (K6-3). */
  readonly coordination: Pick<
    FleetCliRuntime['coordination'],
    | 'recordAttentionItem'
    | 'askOwnerQuestion'
    | 'syncOneWayOwnerQuestions'
    | 'listOwnerQuestions'
    | 'resolveActionAuthorization'
    | 'recordAuthorizationConsumption'
  >;
  /** C2': the artifact adapter whose fail-closed manifest check backs the reap. */
  readonly attemptArtifact: AttemptArtifactAdapter;
  /** C2': the coordination requests the `--force-unsealed` approval binds to. */
  readonly coordinationRequestRepository: CoordinationRequestRepositoryAdapter;
  /** The policy grant issuer behind the conductor's own push grants (K6-2). */
  readonly issuePolicyForgeGrantUseCase: IssuePolicyForgeGrantUseCase;
  /** A fresh installation loader for the auto-merge setting read (AM5-3). */
  readonly autoMergeLoad: () => LoadResult;
  /** The parsed installation the conductor revision is resolved from. */
  readonly installation?: FleetInstallation;
  /** The execution stores the worktree reap reads (EX-2b). */
  readonly workOrderRepository: WorkOrderRepositoryAdapter;
  readonly attemptRepository: AttemptRepositoryAdapter;
  /** R4a: the read-only forge read the settled open-pr park's resume re-checks. */
  readonly forgeRead: ForgeReadAdapter;
  readonly executionJournal: ExecutionJournalAdapter;
  readonly workspace: WorkspaceAdapter;
  /** H9b1: resolves the runner addressed by an attempt's recorded host (EX-4). */
  readonly runnerForAttempt: RunnerForAttemptPort;
}

export function composeConductor(input: ComposeConductorInput) {
  const {
    stateDir,
    evidence,
    profileRead,
    coordination,
    attemptArtifact,
    coordinationRequestRepository,
    issuePolicyForgeGrantUseCase,
    autoMergeLoad,
    installation,
    workOrderRepository,
    attemptRepository,
    forgeRead,
    executionJournal,
    workspace,
    runnerForAttempt,
  } = input;

  // K7: the conductor's stores and its record-only controls. Nothing here
  // dispatches.
  const laneRunRepository = new LaneRunRepositoryAdapter({ stateDir });
  const laneRunJournal = new LaneRunJournalAdapter({ stateDir });
  const conductorDriverLease = new ConductorDriverLeaseAdapter({ stateDir });
  const conductorHalt = new ConductorHaltAdapter({ stateDir });
  // The pass-trace ring: the live driver appends to it (with limits) and the
  // read side here has no limits — listing and the schedule's cap read it.
  const conductorPassTraces = new ConductorPassTraceAdapter({ stateDir });
  const conductorNewUlid = () => newUlid();
  // The auto-merge setting is read once at composition; a toggle takes a
  // restart (K6-8). An unreadable setting fails closed.
  let autoMergeEnabled = false;
  try {
    const settings = autoMergeSettingsFromLoad(autoMergeLoad());
    autoMergeEnabled = settings.outcome === 'read' && settings.enabled;
  } catch {
    autoMergeEnabled = false;
  }
  // The review request adapter, shared by the review step and the status view's
  // read-only findings projection (GB2). Hoisted above the conductor literal so
  // today the inspect use case can read the parked head's latest receipt.
  const reviewRequest = new ReviewRequestAdapter({
    requestIndependentReview: (request) =>
      evidence.requestIndependentReview.requestIndependentReview(request),
    inspectAcceptanceEvidence: (request) =>
      evidence.inspectAcceptanceEvidence.inspectAcceptanceEvidence(request),
    // KF-33b2: the review step's out-of-scope dispositions through the
    // evidence context's existing disposition use case, one id per call.
    recordFindingDisposition: (request) =>
      evidence.recordFindingDisposition.recordFindingDisposition(request),
    // RV4: screen and archive a busy-transport diagnostic under the review
    // request id; an archive miss never changes the review outcome.
    archiveEvidence: (request) => evidence.evidenceArchive.archiveEvidence(request),
  });

  // C2': the scoped one-way owner approval behind the reap's
  // `--force-unsealed`, built from the coordination stack.
  const unsealedRemovalAuthorization = new ActionAuthorizationAdapter({
    authorizeUnsealedWorktreeRemoval: unsealedWorktreeRemovalAuthorizer({
      coordination,
      coordinationRequestRepository,
    }),
  });

  const conductor = {
    laneRunRepository,
    laneRunJournal,
    driverLease: conductorDriverLease,
    halt: conductorHalt,
    requestLaneRunStop: new RequestLaneRunStopUseCase({
      runRepo: laneRunRepository,
      runJournal: laneRunJournal,
    }),
    inspectLaneRuns: new InspectLaneRunsUseCase({
      runRepo: laneRunRepository,
      runJournal: laneRunJournal,
      halt: conductorHalt,
      driverLease: conductorDriverLease,
      attemptRepo: attemptRepository,
      reviewReceipts: reviewRequest,
      executionJournal,
    }),
    listLaneRuns: new ListLaneRunsUseCase({
      runRepo: laneRunRepository,
      runJournal: laneRunJournal,
      halt: conductorHalt,
      driverLease: conductorDriverLease,
      attemptRepo: attemptRepository,
      executionJournal,
      workOrderRepo: workOrderRepository,
      passTrace: conductorPassTraces,
    }),
    listConductorPasses: new ListConductorPassesUseCase({ passTrace: conductorPassTraces }),
    resumeLaneRun: new ResumeLaneRunUseCase({
      runRepo: laneRunRepository,
      runJournal: laneRunJournal,
      newUlid: conductorNewUlid,
      forgeRead,
      attemptRepo: attemptRepository,
    }),
    // EX-2b: the operator-opt-in worktree reap, built beside the lane-run
    // stores it scans and the execution stores it journals to. C2': the
    // removal is gated on the sealed artifact manifest, and `--force-unsealed`
    // consumes a scoped one-way owner approval through the coordination stack.
    reapLaneWorktrees: new ReapLaneWorktreesUseCase({
      workOrderRepo: workOrderRepository,
      attemptRepo: attemptRepository,
      runRepo: laneRunRepository,
      runJournal: laneRunJournal,
      executionJournal,
      profileRead,
      workspace,
      attemptArtifact,
      actionAuthorization: unsealedRemovalAuthorization,
    }),
    // EX-4: the operator-opt-in orphan-session reap, built beside the worktree
    // reap from the execution stores it scans and the per-host runner resolver.
    reapOrphanSessions: new ReapOrphanSessionsUseCase({
      attemptRepo: attemptRepository,
      executionJournal,
      runnerForAttempt,
    }),
    newUlid: conductorNewUlid,
    profileRead,
    // Delegates are bound as arrow functions: the use cases read `this.deps`,
    // so an unbound method call would fail every request.
    reviewRequest,
    reviewAssessment: new ReviewAssessmentAdapter({
      openEvidenceAssessment: (request) =>
        evidence.openEvidenceAssessment.openEvidenceAssessment(request),
    }),
    // The conducted gate's verification receipts (KF-13): one per acceptance
    // check at the collected head, into the assessment the gate opens first.
    gateReceipts: new GateReceiptAdapter({
      recordVerificationReceipt: (request) =>
        evidence.recordVerificationReceipt.recordVerificationReceipt(request),
      assessmentIdOf: assessmentIdForAttempt,
    }),
    ciState: new CiStateAdapter({
      inspectHeadCiState: (request) => evidence.inspectHeadCiState.inspectHeadCiState(request),
    }),
    // The conductor's own push grant issuer (K6-2): a `policy:conductor@<rev>`
    // grant through the root's policy grant use case; the merge itself is
    // never a conductor grant.
    conductorForgeGrant: new ConductorForgeGrantAdapter({
      issue: (request) => issuePolicyForgeGrantUseCase.issuePolicyForgeGrant(request),
      conductorRevision: () => conductorRevision(resolveConductorPolicy(installation?.policy)),
    }),
    // Park notices (K6-3): attention items and keyed owner questions through
    // the coordination use cases; no find-by-key use case is composed, so the
    // question read stays unbound.
    parkNotice: new LaneRunParkNoticeAdapter({
      recordAttentionItem: (body, actor) => coordination.recordAttentionItem.recordAttentionItem(body, actor),
      askOwnerQuestion: (request) =>
        coordination.askOwnerQuestion.askOwnerQuestion(request as AskOwnerQuestionRequest),
    }),
    autoMergeEnabled,
  };

  return { conductor };
}

/** The coordination surface the `--force-unsealed` approval is built from. */
export interface UnsealedRemovalAuthorizerDeps {
  readonly coordination: Pick<
    FleetCliRuntime['coordination'],
    | 'syncOneWayOwnerQuestions'
    | 'listOwnerQuestions'
    | 'resolveActionAuthorization'
    | 'recordAuthorizationConsumption'
  >;
  readonly coordinationRequestRepository: CoordinationRequestRepositoryAdapter;
}

/**
 * C2': the scoped one-way owner approval behind the reap's
 * `--force-unsealed`. The delegate matches an answered one-way owner question
 * to a coordination request bound to the exact project, action scope
 * (attempt + worktree-path digest) and head, then consumes its grant exactly
 * once; a prior consumption of the same action id and attempt is the crash
 * recovery, not a second authorization. Nothing here logs a request, grant or
 * filesystem path.
 */
export function unsealedWorktreeRemovalAuthorizer(
  deps: UnsealedRemovalAuthorizerDeps,
): (
  request: AuthorizeUnsealedWorktreeRemovalRequest,
) => Promise<AuthorizeUnsealedWorktreeRemovalResult> {
  const { coordination, coordinationRequestRepository } = deps;
  return async (request) => {
    const { projectId, runId, attemptId, worktreePath, expectedHeadSha, nowIso } = request;
    const actionScope = unsealedWorktreeRemovalScope(attemptId, sha256HexDigest(worktreePath));
    const actionId = unsealedWorktreeRemovalActionId(runId, attemptId);
    try {
      await coordination.syncOneWayOwnerQuestions.syncOneWayOwnerQuestions();
      const listed = await coordination.listOwnerQuestions.listOwnerQuestions();
      const questions = Array.isArray(listed?.questions) ? listed.questions : [];
      for (const question of questions) {
        if (
          question.doorKind !== 'one-way' ||
          question.state !== 'answered' ||
          question.linkedRequestId === null ||
          question.answer === null ||
          question.answer.shape !== 'accept' ||
          question.answer.answeredVia !== 'signed-decision'
        ) {
          continue;
        }
        const coordReq = await coordinationRequestRepository.findRequestById(
          question.linkedRequestId,
        );
        if (
          coordReq === null ||
          coordReq.projectId !== projectId ||
          coordReq.actionScope !== actionScope ||
          coordReq.expectedHeadSha !== expectedHeadSha ||
          coordReq.policyGrant !== undefined
        ) {
          continue;
        }
        // Crash recovery: a grant already consumed by exactly this action id
        // and attempt re-answers approved without a second owner signature.
        const consumption = coordReq.consumptions[0];
        if (
          coordReq.consumptions.length === 1 &&
          consumption !== undefined &&
          consumption.actionId === actionId &&
          consumption.attemptId === attemptId &&
          coordReq.grantId !== null
        ) {
          return {
            outcome: 'approved',
            approvalReference: `${question.questionId}:${coordReq.id}:${coordReq.grantId}`,
          };
        }
        const resolved = await coordination.resolveActionAuthorization.resolveActionAuthorization({
          projectId,
          actionScope,
          expectedHeadSha,
        });
        if (resolved.outcome !== 'authorized' || resolved.requestId !== coordReq.id) {
          continue;
        }
        const consumed = await coordination.recordAuthorizationConsumption.recordAuthorizationConsumption(
          {
            consumptionId: consumptionId(actionId),
            grantId: resolved.grantId,
            actionId,
            actionScope,
            attemptId,
            expectedHeadSha,
            nowIso,
          },
        );
        if (consumed.outcome !== 'consumed') {
          return { outcome: 'blocked', reason: 'consumption-refused' };
        }
        return {
          outcome: 'approved',
          approvalReference: `${question.questionId}:${coordReq.id}:${resolved.grantId}`,
        };
      }
      return { outcome: 'blocked', reason: 'no-scoped-owner-approval' };
    } catch {
      return { outcome: 'unknown', reason: 'owner-question-sync-failed' };
    }
  };
}
