/**
 * Conductor composition (SPLIT-2): builds the conductor object from the shared
 * root inputs; called by the CLI composition root.
 */
import { newUlid } from '../ulid.js';
import { autoMergeSettingsFromLoad } from '../auto-merge-settings.js';

import {
  AttemptRepositoryAdapter,
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
  type ProjectProfileReadPort,
  type RunnerForAttemptPort,
} from '@fleet/work-execution';

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
  readonly coordination: Pick<FleetCliRuntime['coordination'], 'recordAttentionItem' | 'askOwnerQuestion'>;
  /** The policy grant issuer behind the conductor's own push grants (K6-2). */
  readonly issuePolicyForgeGrantUseCase: IssuePolicyForgeGrantUseCase;
  /** A fresh installation loader for the auto-merge setting read (AM5-3). */
  readonly autoMergeLoad: () => LoadResult;
  /** The parsed installation the conductor revision is resolved from. */
  readonly installation?: FleetInstallation;
  /** The execution stores the worktree reap reads (EX-2b). */
  readonly workOrderRepository: WorkOrderRepositoryAdapter;
  readonly attemptRepository: AttemptRepositoryAdapter;
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
    issuePolicyForgeGrantUseCase,
    autoMergeLoad,
    installation,
    workOrderRepository,
    attemptRepository,
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
    }),
    // EX-2b: the operator-opt-in worktree reap, built beside the lane-run
    // stores it scans and the execution stores it journals to.
    reapLaneWorktrees: new ReapLaneWorktreesUseCase({
      workOrderRepo: workOrderRepository,
      attemptRepo: attemptRepository,
      runRepo: laneRunRepository,
      runJournal: laneRunJournal,
      executionJournal,
      profileRead,
      workspace,
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
    reviewRequest: new ReviewRequestAdapter({
      requestIndependentReview: (request) =>
        evidence.requestIndependentReview.requestIndependentReview(request),
      inspectAcceptanceEvidence: (request) =>
        evidence.inspectAcceptanceEvidence.inspectAcceptanceEvidence(request),
      // KF-33b2: the review step's out-of-scope dispositions through the
      // evidence context's existing disposition use case, one id per call.
      recordFindingDisposition: (request) =>
        evidence.recordFindingDisposition.recordFindingDisposition(request),
    }),
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
