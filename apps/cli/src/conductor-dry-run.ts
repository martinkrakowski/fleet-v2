/**
 * The dry-run's fakes simulate a lane that succeeds; they write only the scratch
 * copy and reach no host. A real lane can fail where these pass. They record
 * every acting port call so a test can prove what the dry-run would have done
 * and that the real ports were never reached.
 */

import type {
  AcceptanceAssessmentPort,
  AttemptArtifactPort,
  AttemptRecord,
  AttemptRepositoryPort,
  AutoMergeAttemptPort,
  CiStatePort,
  CollectedAttemptArtifacts,
  CollectAttemptArtifactsPort,
  CommandCompletionReceipt,
  CommitEditOnlyAttemptPort,
  ConductorForgeGrantPort,
  DispatchAttemptPort,
  EvaluateAttemptGatePort,
  ExecuteAuthorizedForgeActionPort,
  ExecutionJournalPort,
  ForgeReadPort,
  LaneRunAdmissionPort,
  LaneRunParkNoticePort,
  PrepareBriefPackagePort,
  ReconcileAttemptPort,
  ReviewAssessmentPort,
  ReviewRequestPort,
  RunnerForAttemptPort,
  StopAttemptPort,
} from '@fleet/work-execution';

/** Every acting outbound port the dry-run fakes, with the attempt it acted on. */
export interface DryRunRecorder {
  readonly calls: readonly {
    readonly port: string;
    readonly attemptId: string | null;
    /** The minted request id a review act journalled, for the review ports. */
    readonly requestId?: string;
  }[];
}

/** Recording fakes for every acting outbound port of the dry-run driver. */
export interface DryRunFakes {
  readonly recorder: DryRunRecorder;
  readonly admission: LaneRunAdmissionPort;              // admitted; saves a held reservation in the scratch journal
  readonly dispatchAttempt: DispatchAttemptPort;         // saves the scratch attempt running, sessionId 'dry-run-session-' + n; 'started'
  readonly reconcileAttempt: ReconcileAttemptPort;       // a running attempt: saves it ended with an authoritative receipt (exitStatus 0); 'ended'
  readonly stopAttempt: StopAttemptPort;                 // saves it ended, stoppedByRequest true; 'terminated', capacityReleased true
  readonly collectAttemptArtifacts: CollectAttemptArtifactsPort; // saves it collected, headCommit 'd'.repeat(40), one commit, a manifest path; 'collected'
  readonly commitEditOnlyAttempt: CommitEditOnlyAttemptPort;     // 'not-applicable'
  readonly evaluateAttemptGate: EvaluateAttemptGatePort;          // 'passed'
  readonly runnerForAttempt: RunnerForAttemptPort;                // a runner whose inspectWorktreeRun is 'idle' and whose other methods throw 'dry-run: no runner'
  readonly reviewAssessment: ReviewAssessmentPort;                // 'open'
  readonly reviewRequest: ReviewRequestPort;                      // a fixed passed receipt per request; reads answer 'not-found'
  readonly artifactPort: Pick<
    AttemptArtifactPort,
    'readBriefManifest' | 'verifyArtifactManifest' | 'readBriefFile'
  >; // { stepLimit: 100, timeLimitSeconds: 2700, expectedArtifacts: [], acceptanceChecks: ['dry-run-check'] }; 'sealed'; the brief text reads null
  readonly acceptanceAssessment: AcceptanceAssessmentPort;        // 'accepted' at the asked head; 'ar-dry-run-' + n
  readonly ciState: CiStatePort;                                  // 'passed' at the exact head, reason 'read'
  readonly forgeRead: ForgeReadPort;                              // 'not-found' until the push ran; then the PR at the pushed head: 'open' (clean, number 1) and, after the merge, 'merged'
  readonly conductorForgeGrant: ConductorForgeGrantPort;          // 'issued'; 'grant-dry-run-' + n under 'policy:conductor@dry-run'
  readonly executeForgeAction: ExecuteAuthorizedForgeActionPort;  // 'executed' at the expected head; PR number 1
  readonly autoMergeAttempt: AutoMergeAttemptPort;                // 'merged' at the PR head; 'policy:autoMerge@dry-run'
  readonly parkNotice: LaneRunParkNoticePort;                     // 'recorded'; the question id is 'question-dry-run-' + n
  readonly prepareBrief: PrepareBriefPackagePort;                  // 'prepared' with a fixed digest; prosePath '.lane/brief.md'; records the call
}

/** The fixed digest the dry-run's `prepareBrief` fake answers (KF-6). */
export const DRY_RUN_BRIEF_DIGEST = 'f'.repeat(64);

/** The frozen manifest the dry-run fakes read: every field a fix-round brief rebuild needs, the limits, the frozen PR notes and the checks the seeds carry. */
export const DRY_RUN_MANIFEST_JSON = JSON.stringify({
  workOrderId: 'wo-example-1',
  projectId: 'project-example-1',
  taskId: 'task-example-1',
  laneId: 'lane-example-1',
  repository: 'example/repo',
  baseCommit: 'a'.repeat(40),
  policyRevision: 'policy:conductor@dry-run',
  modelAssignment: { model: 'model-example-1', variant: 'default', fallbackModel: 'fallback-model', seatTool: 'opencode' },
  independentReviewer: 'example/dry-run-reviewer',
  ownedPaths: ['packages/example/src'],
  allowedPathPrefixes: ['packages/example/src'],
  permissions: ['filesystem:worktree'],
  acceptanceChecks: ['dry-run-check'],
  acceptanceSpec: { commitRequired: true, diffCheck: true, commands: [{ argv: ['corepack', 'yarn', 'build'] }] },
  stepLimit: 100,
  timeLimitSeconds: 2700,
  resourceBounds: { cpu: '2' },
  expectedArtifacts: [],
  ownerDecisionReferences: [],
  prNotes: { hardToUndo: 'dry run', assumptions: 'dry run', challengeThis: 'dry run' },
});

/** The head commit the collect fake records: one commit since base, 'd' × 40. */
const DRY_RUN_HEAD_COMMIT = 'd'.repeat(40);

/** A fresh attempt-shaped record the fakes can build on when the record is absent. */
function baseAttemptOf(request: { readonly attemptId: string; readonly workOrderId: string; readonly worktreePath: string; readonly baseCommit: string }, nowIso: () => string): AttemptRecord {
  return {
    id: request.attemptId,
    workOrderId: request.workOrderId,
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: request.worktreePath,
    baseCommit: request.baseCommit,
    state: 'intent-recorded',
    outcome: null,
    revision: 0,
    briefDigest: null,
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    createdAtIso: nowIso(),
    updatedAtIso: nowIso(),
  };
}

/** A runner that reads an idle worktree and refuses every session operation. */
function dryRunRunner() {
  const noRunner = (): never => {
    throw new Error('dry-run: no runner');
  };
  return {
    describeCapabilities: noRunner,
    startSession: noRunner,
    inspectSession: noRunner,
    stopSession: noRunner,
    inspectWorktreeRun: async () => ({ state: 'idle' as const }),
  };
}

/**
 * Build the recording fakes over the scratch stores. Every fake writes only
 * through the stores it was given (revision + 1 saves, as the real use cases
 * do) and never imports an executor, runner, workspace or forge adapter.
 */
export function createDryRunFakes(
  stores: {
    readonly attemptRepo: AttemptRepositoryPort;
    readonly executionJournal: ExecutionJournalPort;
  },
  nowIso: () => string,
): DryRunFakes {
  const calls: { readonly port: string; readonly attemptId: string | null; readonly requestId?: string }[] = [];
  const recordCall = (port: string, request?: object): void => {
    const field = (name: string): string | undefined => {
      if (request === undefined || !(name in request)) {
        return undefined;
      }
      const value = (request as Record<string, unknown>)[name];
      return typeof value === 'string' ? value : undefined;
    };
    const attemptId = field('attemptId');
    const requestId = field('requestId');
    calls.push({
      port,
      attemptId: attemptId ?? null,
      ...(requestId !== undefined ? { requestId } : {}),
    });
  };
  let sessionSequence = 0;
  let reservationSequence = 0;
  let reviewSequence = 0;
  let acceptanceSequence = 0;
  let grantSequence = 0;
  let questionSequence = 0;
  // The fake PR's lifecycle: nothing until the push ran, open afterwards,
  // merged after the auto-merge fake ran.
  let prOpened = false;
  let prMerged = false;
  let prHeadSha: string | null = null;
  const PR_NUMBER = 1;

  const findOrCreateAttempt = async (request: {
    readonly attemptId: string;
    readonly workOrderId: string;
    readonly worktreePath: string;
    readonly baseCommit: string;
  }): Promise<AttemptRecord> => {
    const existing = await stores.attemptRepo.findAttemptById(request.attemptId);
    return existing ?? baseAttemptOf(request, nowIso);
  };

  const admission: LaneRunAdmissionPort = {
    admit: async (request) => {
      recordCall('admission', request);
      const held = await stores.executionJournal.listActiveReservations();
      if (!held.some((reservation) => reservation.attemptId === request.attemptId)) {
        reservationSequence += 1;
        await stores.executionJournal.saveCapacityReservation({
          id: 'res-dry-run-' + String(reservationSequence),
          attemptId: request.attemptId,
          hostId: 'lane-example',
          slotIndex: 0,
          held: true,
          seatTool: request.seatTool,
          hostName: 'lane-example',
          hostKind: request.seatTool,
          transport: 'local',
          sshAlias: null,
          port: null,
          worktreePath: request.worktreePath,
          reservedAtIso: nowIso(),
          releasedAtIso: null,
        });
      }
      return { outcome: 'admitted' };
    },
  };

  const dispatchAttempt: DispatchAttemptPort = {
    dispatchAttempt: async (request) => {
      recordCall('dispatch', request);
      sessionSequence += 1;
      const sessionId = 'dry-run-session-' + String(sessionSequence);
      const base = await findOrCreateAttempt(request);
      const running: AttemptRecord = {
        ...base,
        revision: (base.revision ?? 0) + 1,
        state: 'running',
        sessionId,
        updatedAtIso: nowIso(),
      };
      await stores.attemptRepo.saveAttempt(running);
      return { outcome: 'started', attempt: running, sessionId };
    },
  };

  const reconcileAttempt: ReconcileAttemptPort = {
    reconcileAttempt: async (request) => {
      recordCall('reconcile', request);
      const base = await stores.attemptRepo.findAttemptById(request.attemptId);
      const receipt: CommandCompletionReceipt = {
        attemptId: request.attemptId,
        sessionId: base?.sessionId ?? 'dry-run-session-1',
        endedAtIso: nowIso(),
        authoritative: true,
        exitStatus: 0,
        stoppedByRequest: false,
      };
      const ended: AttemptRecord = {
        ...(base ?? baseAttemptOf({ attemptId: request.attemptId, workOrderId: '', worktreePath: '', baseCommit: '' }, nowIso)),
        revision: (base?.revision ?? 0) + 1,
        state: 'ended',
        outcome: 'done',
        completionReceipt: receipt,
        updatedAtIso: nowIso(),
      };
      await stores.attemptRepo.saveAttempt(ended);
      return { outcome: 'ended', attempt: ended, receipt };
    },
  };

  const stopAttempt: StopAttemptPort = {
    stopAttempt: async (request) => {
      recordCall('stop', request);
      const base = await stores.attemptRepo.findAttemptById(request.attemptId);
      const receipt: CommandCompletionReceipt = {
        attemptId: request.attemptId,
        sessionId: base?.sessionId ?? 'dry-run-session-1',
        endedAtIso: nowIso(),
        authoritative: true,
        exitStatus: 0,
        stoppedByRequest: true,
      };
      const ended: AttemptRecord = {
        ...(base ?? baseAttemptOf({ attemptId: request.attemptId, workOrderId: '', worktreePath: '', baseCommit: '' }, nowIso)),
        revision: (base?.revision ?? 0) + 1,
        state: 'ended',
        outcome: 'stopped',
        completionReceipt: receipt,
        updatedAtIso: nowIso(),
      };
      await stores.attemptRepo.saveAttempt(ended);
      return { outcome: 'terminated', attempt: ended, receipt, capacityReleased: true };
    },
  };

  const collectAttemptArtifacts: CollectAttemptArtifactsPort = {
    collectAttemptArtifacts: async (request) => {
      recordCall('collect', request);
      const base = await stores.attemptRepo.findAttemptById(request.attemptId);
      const artifacts: CollectedAttemptArtifacts = {
        headCommit: DRY_RUN_HEAD_COMMIT,
        commitsSinceBase: [DRY_RUN_HEAD_COMMIT],
        collectedArtifactPaths: [],
        notes: 'present',
        manifestPath: '.lane/artifacts-manifest-dddddddddddddd.json',
        manifestSha256: 'e'.repeat(64),
      };
      const collected: AttemptRecord = {
        ...(base ?? baseAttemptOf({ attemptId: request.attemptId, workOrderId: request.workOrderId, worktreePath: '', baseCommit: '' }, nowIso)),
        revision: (base?.revision ?? 0) + 1,
        state: 'collected',
        artifacts,
        updatedAtIso: nowIso(),
      };
      await stores.attemptRepo.saveAttempt(collected);
      return { outcome: 'collected', artifacts };
    },
  };

  const commitEditOnlyAttempt: CommitEditOnlyAttemptPort = {
    commitEditOnlyAttempt: async (request) => {
      recordCall('commitEditOnly', request);
      return { outcome: 'not-applicable' };
    },
  };

  const evaluateAttemptGate: EvaluateAttemptGatePort = {
    evaluateAttemptGate: async (request) => {
      recordCall('gate', request);
      return { verdict: 'passed' };
    },
  };

  const runnerForAttempt: RunnerForAttemptPort = {
    runnerForAttempt: () => {
      recordCall('runnerForAttempt');
      return { ok: true, runner: dryRunRunner() };
    },
  };

  const reviewAssessment: ReviewAssessmentPort = {
    openReviewAssessment: async (request) => {
      recordCall('reviewAssessment', request);
      return { outcome: 'open' };
    },
  };

  const reviewRequest: ReviewRequestPort = {
    requestReview: async (request) => {
      recordCall('reviewRequest', request);
      reviewSequence += 1;
      return {
        outcome: 'receipt',
        receipt: {
          receiptId: 'rr-dry-run-' + String(reviewSequence),
          requestId: request.requestId,
          kind: request.kind,
          reviewerModel: request.reviewerModel,
          candidateHeadSha: request.candidateHeadSha,
          verdict: 'passed',
          findings: [],
        },
      };
    },
    findReviewReceipt: async () => ({ outcome: 'not-found' }),
    // D3: a passed pre-merge receipt at the asked head (manual, requestId
    // null), so a Tier 2 run passes awaiting-premerge; every other kind is
    // absent.
    findLatestReceiptOfKind: async (request) => {
      recordCall('findLatestReceiptOfKind', request);
      if (request.kind !== 'pre-merge') {
        return { outcome: 'not-found' };
      }
      return {
        outcome: 'found',
        receipt: {
          receiptId: 'pm-dry-run-1',
          requestId: null,
          kind: request.kind,
          reviewerModel: 'example/dry-run-reviewer',
          candidateHeadSha: request.candidateHeadSha,
          verdict: 'passed',
          findings: [],
        },
      };
    },
  };

  const artifactPort: Pick<
    AttemptArtifactPort,
    'readBriefManifest' | 'verifyArtifactManifest' | 'readBriefFile'
  > = {
    readBriefManifest: async () => DRY_RUN_MANIFEST_JSON,
    verifyArtifactManifest: async (request) => ({
      outcome: 'sealed',
      manifest: {
        schemaVersion: 1,
        attemptId: request.attemptId,
        files: [],
        total: { files: 0, bytes: 0 },
      },
    }),
    readBriefFile: async () => null,
  };

  // K6-8: the acting fakes for the conductor's acceptance, PR, push, merge
  // and park ports. Every one records its call; none reaches a forge, a
  // transport or a host.
  const acceptanceAssessment: AcceptanceAssessmentPort = {
    assessHeadAcceptance: async (request) => {
      recordCall('acceptanceAssessment', request);
      acceptanceSequence += 1;
      return {
        outcome: 'accepted',
        receiptId: 'ar-dry-run-' + String(acceptanceSequence),
        assessedHeadSha: request.candidateHeadSha,
      };
    },
  };

  const ciState: CiStatePort = {
    readHeadCiState: async (request) => {
      recordCall('ciState', request);
      return { headSha: request.headSha, state: 'passed', reason: 'read' };
    },
  };

  const forgeRead: ForgeReadPort = {
    readPullRequest: async () => {
      recordCall('forgeRead');
      if (!prOpened) {
        return { outcome: 'not-found' };
      }
      return {
        outcome: 'found',
        pullRequest: {
          number: PR_NUMBER,
          state: prMerged ? 'merged' : 'open',
          mergeState: 'clean',
          headSha: prHeadSha ?? DRY_RUN_HEAD_COMMIT,
          headRef: 'lane-example-branch',
          baseRef: 'main',
          mergedAtIso: prMerged ? nowIso() : null,
          closedAtIso: null,
          mergeCommitSha: prMerged ? 'e'.repeat(40) : null,
        },
      };
    },
    isConfigured: () => true,
  };

  const conductorForgeGrant: ConductorForgeGrantPort = {
    issueConductorForgeGrant: async (request) => {
      recordCall('conductorForgeGrant', request);
      grantSequence += 1;
      return {
        outcome: 'issued',
        grantId: 'grant-dry-run-' + String(grantSequence),
        decisionRevision: 'policy:conductor@dry-run',
      };
    },
  };

  const executeForgeAction: ExecuteAuthorizedForgeActionPort = {
    executeAuthorizedForgeAction: async (request) => {
      recordCall('executeForgeAction', request);
      prOpened = true;
      prHeadSha = request.expectedHeadSha;
      return {
        outcome: 'executed',
        pullRequestNumber: PR_NUMBER,
        headSha: request.expectedHeadSha,
      };
    },
  };

  const autoMergeAttempt: AutoMergeAttemptPort = {
    autoMergeAttempt: async (request) => {
      recordCall('autoMergeAttempt', request);
      prMerged = true;
      return {
        outcome: 'merged',
        attemptId: request.attemptId,
        headSha: prHeadSha ?? DRY_RUN_HEAD_COMMIT,
        pullRequestNumber: PR_NUMBER,
        decisionRevision: 'policy:autoMerge@dry-run',
      };
    },
  };

  const parkNotice: LaneRunParkNoticePort = {
    recordParkAttention: async (request) => {
      recordCall('parkNotice', request);
      return { outcome: 'recorded' };
    },
    askParkQuestion: async (request) => {
      recordCall('parkNotice', request);
      questionSequence += 1;
      return { outcome: 'recorded', questionId: 'question-dry-run-' + String(questionSequence) };
    },
    findParkQuestion: async () => ({ outcome: 'not-found' }),
  };

  // KF-6: the dry-run's `prepareBrief` fake answers a fixed digest and the
  // brief package path, writing no file. It records the call so a test can
  // prove a fix round placed its brief package.
  const prepareBrief: PrepareBriefPackagePort = {
    prepareBriefPackage: async (request) => {
      recordCall('prepareBrief', request);
      return {
        outcome: 'prepared',
        prepared: {
          attemptId: (request as { readonly attemptId?: string }).attemptId ?? '',
          briefDigest: DRY_RUN_BRIEF_DIGEST,
          prosePath: '.lane/brief.md',
          manifestPath: '.lane/brief-manifest.json',
          selectedKnowledgeVersions: [],
        },
      };
    },
    previewBriefPackage: async () => ({
      outcome: 'previewed',
      preview: {
        attemptId: '',
        briefDigest: DRY_RUN_BRIEF_DIGEST,
        modelAssignment: { model: 'model-example-1', variant: 'default', seatTool: 'opencode' },
        seatPlan: null,
        acceptance: { commitRequired: true, diffCheck: true, commandCount: 1, commandDigests: [] },
        prNotesPresent: false,
        selectedKnowledgeVersions: [],
      },
    }),
  };

  return {
    recorder: { calls },
    admission,
    dispatchAttempt,
    reconcileAttempt,
    stopAttempt,
    collectAttemptArtifacts,
    commitEditOnlyAttempt,
    evaluateAttemptGate,
    runnerForAttempt,
    reviewAssessment,
    reviewRequest,
    artifactPort,
    acceptanceAssessment,
    ciState,
    forgeRead,
    conductorForgeGrant,
    executeForgeAction,
    autoMergeAttempt,
    parkNotice,
    prepareBrief,
  };
}
