/**
 * RV3: review outcomes derive from finding severities, minor/nit findings are
 * carried, and park records never carry `findings: []`. Includes the verbatim
 * `WB5a-store-c` saved minor-only FAIL receipt fixture (F148, 2026-11-06) and
 * the F96 named robustness tests. Every store is in-memory; no runner, no
 * subprocess, no network.
 */

import { describe, expect, it } from 'vitest';

import {
  AssessHeadAcceptanceUseCase,
  decideReviewReceiptOutcome,
  EvidenceAssessment,
  type EvidenceAssessmentRecord,
  type EvidenceAssessmentRepositoryPort,
  type ReviewReceiptRecord,
} from '@fleet/evidence-and-acceptance';
import { decideConductorReviewOutcome } from '../../../domain/lane-run-decider.js';

import type {
  AttemptRecord,
  CollectedAttemptArtifacts,
  WorkOrderRecord,
} from '../../../domain/execution-records.js';
import { LaneRun } from '../../../domain/entities/LaneRun.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import { buildLaneRunStepKey } from '../../../domain/lane-run-keys.js';
import {
  laneRunConductEntry,
  laneRunIntentEntry,
  laneRunResultEntry,
} from '../../../domain/lane-run-step-facts.js';
import { causingParkFindingsView, PARK_FINDINGS_MAX_COUNT } from '../../../domain/park-findings-view.js';
import { renderPrBody } from '../../../domain/lane-run-pr-body.js';
import type { SameModelFamily } from '../../../domain/seat-selection.js';
import { ReviewRequestAdapter } from '../../../infrastructure/adapters/ReviewRequestAdapter.adapter.js';
import { LaneRunRepositoryAdapter } from '../../../infrastructure/adapters/LaneRunRepositoryAdapter.adapter.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { AttemptRepositoryAdapter } from '../../../infrastructure/adapters/AttemptRepositoryAdapter.adapter.js';
import { ExecutionJournalAdapter } from '../../../infrastructure/adapters/ExecutionJournalAdapter.adapter.js';
import { AdvanceLaneRunUseCase } from '../AdvanceLaneRunUseCase.use-case.js';
import type { AdvanceLaneRunDependencies } from '../AdvanceLaneRunUseCase.use-case.js';
import { simpleDeterministicHexDigest } from '../PrepareBriefPackageUseCase.use-case.js';
import type {
  FindLatestReceiptOfKindRequest,
  FindLatestReceiptOfKindResult,
  FindReviewReceiptRequest,
  FindReviewReceiptResult,
  ReviewRequest,
  ReviewRequestFinding,
  ReviewRequestResult,
} from '../../ports/out/ReviewRequestPort.out-port.js';
import type {
  AcceptanceAssessmentResult,
  AcceptanceReceiptsResult,
} from '../../ports/out/AcceptanceAssessmentPort.out-port.js';
import type {
  ConductorForgeGrantRequest,
  ConductorForgeGrantResult,
} from '../../ports/out/ConductorForgeGrantPort.out-port.js';
import type {
  ExecuteAuthorizedForgeActionRequest,
  ExecuteAuthorizedForgeActionResult,
} from '../../ports/in/ExecuteAuthorizedForgeActionPort.in-port.js';
import type { OpenReviewAssessmentRequest, OpenReviewAssessmentResult } from '../../ports/out/ReviewAssessmentPort.out-port.js';

// ---------------------------------------------------------------------------
// The verbatim WB5a-store-c fixture (F148, 2026-11-06).
// ---------------------------------------------------------------------------

const WB5A_STORE_C_FIXTURE = {
  note: 'saved minor-only FAIL review receipt, WB5a-store-c, 2026-11-06 (F148)',
  receipt: {
    result: 'fail',
    findings: [
      {
        findingId: 'rr-assessment-attempt-01M6RGFD841EW0K31KY6Z9PRKQ-fe520fe2-review-01M6RH29P27AP4SQ8EA4E5GC02:review-1',
        severity: 'minor',
        summary:
          'If the unreadable store changes to a symlink or oversized file while the reader waits for the lock, this branch throws without marking quarantine as unattempted. The error then says the bytes could not be copied and advises manual repair, even though no copy was attempted.',
        filePath: 'packages/work-execution/src/infrastructure/adapters/file-store.ts',
        line: 840,
        state: 'unresolved',
        dispositionReason: null,
        dispositionEvidenceRef: null,
      },
    ],
    reviewerModel: 'openrouter/openai/gpt-6-luna',
    implementerModel: 'openrouter/inception/mercury-3',
    readOnlyVerified: true,
  },
  assessmentBlockers: [
    "finding 'rr-assessment-attempt-01M6RGFD841EW0K31KY6Z9PRKQ-fe520fe2-review-01M6RH29P27AP4SQ8EA4E5GC02:review-1' is unresolved",
  ],
} as const;

const WB5A_FINDING_ID =
  'rr-assessment-attempt-01M6RGFD841EW0K31KY6Z9PRKQ-fe520fe2-review-01M6RH29P27AP4SQ8EA4E5GC02:review-1';
const WB5A_FILE_PATH = 'packages/work-execution/src/infrastructure/adapters/file-store.ts';

// ---------------------------------------------------------------------------
// Shared fixtures.
// ---------------------------------------------------------------------------

const RUN_ID = 'run-01JB0000000000000000000000';
const NOW = '2026-10-27T10:00:00.000Z';
const LATER = '2026-10-27T10:01:00.000Z';
const LEASE_UNTIL = '2026-10-27T10:05:00.000Z';
const HOLDER = 'driver';
const COMMIT_A = 'a'.repeat(40);
const HEAD12_A = 'a'.repeat(12);
const WORKTREE = '/tmp/opencode/wo-example-1/wt-example-1';
const GRANT_ID = 'grant-conductor-example-1';
const DECISION_REVISION = 'policy:conductor@0123456789ab';
const RECEIPT_ID = 'rcp-example-1';

const HARD_TO_UNDO = 'hard-to-undo text example 1';
const ASSUMPTIONS = 'assumptions text example 1';
const CHALLENGE_THIS = 'challenge this text example 1';

const BASE_RECORD = {
  version: 1,
  runId: RUN_ID,
  workOrderId: 'wo-example-1',
  tier: 2,
  seatPlanRef: 'a'.repeat(64),
  cursors: { 'first-pass': 0, fix: null, review: null },
  round: 0,
  attemptIds: ['attempt-example-1'],
  prNumber: null,
  parked: null,
  parkCount: 0,
  lease: null,
  revision: 1,
  runPolicyRevision: 'policy-example-1',
};

const SEAT_PLAN = {
  version: 1 as const,
  'first-pass': [{ id: 'fp-1', model: 'model-example-1', tool: 'opencode' }],
  fix: [{ id: 'fx-1', model: 'model-example-1', tool: 'opencode' }],
  review: [
    { id: 'rev-1', model: 'review-model-1', tool: 'opencode' },
    { id: 'rev-2', model: 'review-model-2', tool: 'opencode' },
  ],
};

const WORK_ORDER: WorkOrderRecord = {
  id: 'wo-example-1',
  projectId: 'project-example-1',
  taskId: 'task-example-1',
  laneId: 'lane-example-1',
  repository: 'example/repo',
  baseCommit: COMMIT_A,
  ownedPaths: [],
  policyRevision: 'policy-example-1',
  prerequisiteWorkOrderIds: [],
  state: 'reviewing',
  revision: 1,
  createdAtIso: NOW,
  updatedAtIso: NOW,
};

const PROSE = '# brief\n';
const DEFAULT_MANIFEST_JSON = JSON.stringify({
  acceptanceChecks: ['check-1'],
  prNotes: { hardToUndo: HARD_TO_UNDO, assumptions: ASSUMPTIONS, challengeThis: CHALLENGE_THIS },
});
const digestFor = (json: string): string => simpleDeterministicHexDigest(PROSE + '\n' + json);
const SHA = digestFor(DEFAULT_MANIFEST_JSON);

const CONDUCTED_RUNNER = {
  kind: 'opencode' as const,
  remotePort: 4166,
  host: 'lane-alias-example',
  hostName: 'lane-host-example',
  agent: null,
  model: null,
  variant: null,
};

function collectedAttempt(headCommit: string = COMMIT_A): AttemptRecord {
  const artifacts: CollectedAttemptArtifacts = {
    headCommit,
    commitsSinceBase: [headCommit],
    collectedArtifactPaths: [],
    notes: 'present',
  };
  return {
    id: 'attempt-example-1',
    workOrderId: 'wo-example-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: WORKTREE,
    baseCommit: COMMIT_A,
    state: 'collected',
    outcome: null,
    briefDigest: SHA,
    briefPackagePath: '.lane/brief-package',
    sessionId: null,
    completionReceipt: {
      attemptId: 'attempt-example-1',
      sessionId: 'session-example-1',
      endedAtIso: LATER,
      authoritative: true,
      exitStatus: 0,
      stoppedByRequest: false,
    },
    artifacts,
    runner: CONDUCTED_RUNNER,
    seatPlan: SEAT_PLAN,
    seatSelection: {
      role: 'first-pass',
      seatIndex: 0,
      seatId: 'fp-1',
      model: 'model-example-1',
      tool: 'opencode',
      variant: null,
      agent: null,
    },
    stopReason: 'none',
    createdAtIso: NOW,
    updatedAtIso: NOW,
  };
}

function runRecord(overrides: Record<string, unknown> = {}): LaneRunRecord {
  const result = LaneRun.create({ ...BASE_RECORD, ...overrides });
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error('fixture must be a valid LaneRun record');
  }
  return result.value.toRecord();
}

function makeUlidMinter(): () => string {
  let next = 0;
  return () => {
    const id = '01JB00000000000000000000' + String(next).padStart(2, '0');
    next += 1;
    return id;
  };
}

function reviewKey(step: 'brief-check' | 'code-review', seatIndex: number, head12: string): string {
  const built = buildLaneRunStepKey({
    runId: RUN_ID,
    round: 0,
    step,
    seatIndex,
    attemptOrdinal: null,
    head12,
    retry: null,
  });
  expect(built.ok).toBe(true);
  if (!built.ok) {
    throw new Error('fixture must build a review key');
  }
  return built.key;
}

function acceptKey(): string {
  const built = buildLaneRunStepKey({
    runId: RUN_ID,
    round: 0,
    step: 'accept',
    seatIndex: 0,
    attemptOrdinal: null,
    head12: HEAD12_A,
    retry: null,
  });
  expect(built.ok).toBe(true);
  if (!built.ok) {
    throw new Error('fixture must build an accept key');
  }
  return built.key;
}

function openPrKey(): string {
  const built = buildLaneRunStepKey({
    runId: RUN_ID,
    round: 0,
    step: 'open-pr',
    seatIndex: 0,
    attemptOrdinal: null,
    head12: HEAD12_A,
    retry: null,
  });
  expect(built.ok).toBe(true);
  if (!built.ok) {
    throw new Error('fixture must build an open-pr key');
  }
  return built.key;
}

/** The WB5a receipt as the conductor's receipt summary for `kind`. */
function wb5aReceiptSummary<K extends 'brief-check' | 'code-review' | 'pre-merge'>(
  kind: K,
  requestId: string | null,
): {
  receiptId: string;
  requestId: string | null;
  kind: K;
  reviewerModel: string;
  candidateHeadSha: string;
  verdict: 'failed';
  findings: readonly ReviewRequestFinding[];
} {
  return {
    receiptId: 'rcpt-wb5a-1',
    requestId,
    kind,
    reviewerModel: WB5A_STORE_C_FIXTURE.receipt.reviewerModel,
    candidateHeadSha: COMMIT_A,
    verdict: 'failed' as const,
    findings: [
      {
        findingId: WB5A_FINDING_ID,
        severity: 'minor' as const,
        summary: WB5A_STORE_C_FIXTURE.receipt.findings[0]!.summary,
        filePath: WB5A_FILE_PATH,
        line: 840,
      },
    ],
  };
}

interface Harness {
  readonly runRepo: LaneRunRepositoryAdapter;
  readonly runJournal: LaneRunJournalAdapter;
  readonly attemptRepo: AttemptRepositoryAdapter;
  readonly reviewRequests: ReviewRequest[];
  readonly grantRequests: ConductorForgeGrantRequest[];
  readonly forgeRequests: ExecuteAuthorizedForgeActionRequest[];
  readonly deps: AdvanceLaneRunDependencies;
  setManifest(json: string | null): Promise<void>;
  setReviewAnswer(answer: (request: ReviewRequest) => Promise<ReviewRequestResult>): void;
  setFindReceiptAnswer(answer: (request: FindReviewReceiptRequest) => Promise<FindReviewReceiptResult>): void;
  setFindLatestReceiptAnswer(answer: (request: FindLatestReceiptOfKindRequest) => Promise<FindLatestReceiptOfKindResult>): void;
  setReceiptsAnswer(answer: AcceptanceReceiptsResult): void;
  setAcceptanceAnswer(answer: AcceptanceAssessmentResult): void;
  setGrantAnswer(answer: ConductorForgeGrantResult): void;
  setForgeAnswer(answer: ExecuteAuthorizedForgeActionResult): void;
}

async function makeHarness(
  record: LaneRunRecord,
  attempts: readonly AttemptRecord[],
  options: { readonly wireReviewRequest?: boolean; readonly wireGrant?: boolean; readonly wireForge?: boolean } = {},
): Promise<Harness> {
  const runRepo = new LaneRunRepositoryAdapter();
  const runJournal = new LaneRunJournalAdapter();
  const attemptRepo = new AttemptRepositoryAdapter();
  const executionJournal = new ExecutionJournalAdapter();
  const reviewRequests: ReviewRequest[] = [];
  const grantRequests: ConductorForgeGrantRequest[] = [];
  const forgeRequests: ExecuteAuthorizedForgeActionRequest[] = [];
  let manifestJson: string | null = DEFAULT_MANIFEST_JSON;
  let reviewAnswer: (request: ReviewRequest) => Promise<ReviewRequestResult> = async (request) => ({
    outcome: 'receipt',
    receipt: { ...wb5aReceiptSummary(request.kind as 'code-review', request.requestId), requestId: request.requestId },
  });
  let findReceiptAnswer: (request: FindReviewReceiptRequest) => Promise<FindReviewReceiptResult> = async (request) => ({
    outcome: 'found',
    receipt: { ...wb5aReceiptSummary('code-review', request.requestId), requestId: request.requestId },
  });
  let findLatestReceiptAnswer: (request: FindLatestReceiptOfKindRequest) => Promise<FindLatestReceiptOfKindResult> =
    async () => ({ outcome: 'not-found' });
  let receiptsAnswer: AcceptanceReceiptsResult = {
    outcome: 'passed',
    receiptsId: RECEIPT_ID,
    assessedHeadSha: COMMIT_A,
  };
  let acceptanceAnswer: AcceptanceAssessmentResult = {
    outcome: 'accepted',
    receiptId: RECEIPT_ID,
    assessedHeadSha: COMMIT_A,
  };
  let grantAnswer: ConductorForgeGrantResult = {
    outcome: 'issued',
    grantId: GRANT_ID,
    decisionRevision: DECISION_REVISION,
  };
  let forgeAnswer: ExecuteAuthorizedForgeActionResult = {
    outcome: 'executed',
    pullRequestNumber: 7,
    headSha: COMMIT_A,
  };

  const created = await runRepo.create(record);
  expect(created.outcome).toBe('saved');
  const leased = await runRepo.acquireLease(record.runId, {
    holderId: HOLDER,
    observedFence: 0,
    leaseUntilIso: LEASE_UNTIL,
    nowIso: NOW,
  });
  expect(leased.outcome).toBe('saved');
  for (const attempt of attempts) {
    await attemptRepo.saveAttempt(attempt);
  }

  const deps: AdvanceLaneRunDependencies = {
    runRepo,
    runJournal,
    attemptRepo,
    executionJournal,
    artifactPort: {
      readBriefManifest: async () => manifestJson,
      readBriefFile: async () => PROSE,
      verifyArtifactManifest: async () => ({ outcome: 'sealed' }) as never,
    },
    reconcileAttempt: {
      reconcileAttempt: async () => ({
        outcome: 'active',
        attempt: attempts[attempts.length - 1] ?? collectedAttempt(),
        status: {
          runnerReachable: 'reachable',
          workspacePreparation: 'prepared',
          workerCommand: 'active',
          completionReceipt: null,
          artifactsCollected: false,
        },
      }),
    },
    admission: {
      admit: async () => ({ outcome: 'admitted' }),
    },
    newUlid: makeUlidMinter(),
    sameModelFamily: ((left: string, right: string) => left === right) as SameModelFamily,
    ...(options.wireReviewRequest === false
      ? {}
      : {
          reviewRequest: {
            requestReview: async (request) => {
              reviewRequests.push(request);
              return reviewAnswer(request);
            },
            findReviewReceipt: async (request) => findReceiptAnswer(request),
            findLatestReceiptOfKind: async (request) => findLatestReceiptAnswer(request),
          },
        }),
    reviewAssessment: {
      openReviewAssessment: async (_request: OpenReviewAssessmentRequest): Promise<OpenReviewAssessmentResult> => ({
        outcome: 'open',
      }),
    },
    workOrderRepo: {
      findWorkOrderById: async (id) => (id === WORK_ORDER.id ? WORK_ORDER : null),
    },
    acceptanceAssessment: {
      assessHeadAcceptance: async () => acceptanceAnswer,
      assessHeadReceipts: async () => receiptsAnswer,
    },
    ...(options.wireGrant === false
      ? {}
      : {
          conductorForgeGrant: {
            issueConductorForgeGrant: async (request) => {
              grantRequests.push(request);
              return grantAnswer;
            },
          },
        }),
    ...(options.wireForge === false
      ? {}
      : {
          executeForgeAction: {
            executeAuthorizedForgeAction: async (request) => {
              forgeRequests.push(request);
              return forgeAnswer;
            },
          },
        }),
  };

  return {
    runRepo,
    runJournal,
    attemptRepo,
    reviewRequests,
    grantRequests,
    forgeRequests,
    deps,
    setManifest: async (json) => {
      manifestJson = json;
      if (json !== null) {
        const digest = digestFor(json);
        for (const attempt of await attemptRepo.listAllAttempts()) {
          if (attempt.briefDigest !== digest) {
            await attemptRepo.saveAttempt({ ...attempt, revision: (attempt.revision ?? 0) + 1, briefDigest: digest });
          }
        }
      }
    },
    setReviewAnswer: (answer) => {
      reviewAnswer = answer;
    },
    setFindReceiptAnswer: (answer) => {
      findReceiptAnswer = answer;
    },
    setFindLatestReceiptAnswer: (answer) => {
      findLatestReceiptAnswer = answer;
    },
    setReceiptsAnswer: (answer) => {
      receiptsAnswer = answer;
    },
    setAcceptanceAnswer: (answer) => {
      acceptanceAnswer = answer;
    },
    setGrantAnswer: (answer) => {
      grantAnswer = answer;
    },
    setForgeAnswer: (answer) => {
      forgeAnswer = answer;
    },
  };
}

async function advance(harness: Harness, overrides: Record<string, unknown> = {}) {
  const useCase = new AdvanceLaneRunUseCase(harness.deps);
  return useCase.advanceLaneRun({
    runId: RUN_ID,
    lease: { holderId: HOLDER, fence: 1 },
    halted: false,
    nowIso: LATER,
    ...overrides,
  });
}

async function conduct(harness: Harness, state: Parameters<typeof laneRunConductEntry>[2], nowIso: string): Promise<void> {
  const entry = laneRunConductEntry(harness.deps.newUlid(), RUN_ID, state, nowIso);
  const appended = await harness.runJournal.append(entry);
  expect(appended.outcome).toBe('appended');
}

async function appendIntent(harness: Harness, key: string, mintedId: string | null, recordedAtIso: string): Promise<void> {
  const entry = laneRunIntentEntry(harness.deps.newUlid(), RUN_ID, key, mintedId, recordedAtIso);
  const appended = await harness.runJournal.append(entry);
  expect(appended.outcome).toBe('appended');
}

async function appendResult(
  harness: Harness,
  key: string,
  outcome: Parameters<typeof laneRunResultEntry>[3],
  reasonCode: Parameters<typeof laneRunResultEntry>[4],
  recordedAtIso: string,
  detail: string | null = null,
): Promise<void> {
  const entry = laneRunResultEntry(harness.deps.newUlid(), RUN_ID, key, outcome, reasonCode, recordedAtIso, detail);
  const appended = await harness.runJournal.append(entry);
  expect(appended.outcome).toBe('appended');
}

// ---------------------------------------------------------------------------
// Evidence-side fixtures.
// ---------------------------------------------------------------------------

const ASSESSMENT_HEAD = '1111111111111111111111111111111111111111';

function wb5aReceiptRecord(overrides: Partial<ReviewReceiptRecord> = {}): ReviewReceiptRecord {
  return {
    id: 'rr-wb5a-1',
    assessmentId: 'assessment-att-1',
    projectId: 'proj-1',
    attemptId: 'att-1',
    candidateHeadSha: ASSESSMENT_HEAD,
    reviewerModel: WB5A_STORE_C_FIXTURE.receipt.reviewerModel,
    implementerModel: 'openrouter/inception/mercury-3',
    readOnlyVerified: true,
    result: 'fail',
    findings: [{ ...WB5A_STORE_C_FIXTURE.receipt.findings[0] }],
    evidenceRef: 'evidence-ref-1',
    policyRevision: 'pol-1',
    completedAtIso: '2026-11-06T10:00:00Z',
    ...overrides,
  };
}

function assessmentRecord(overrides: Partial<EvidenceAssessmentRecord> = {}): EvidenceAssessmentRecord {
  return {
    id: 'assessment-att-1',
    projectId: 'proj-1',
    attemptId: 'att-1',
    candidateHeadSha: ASSESSMENT_HEAD,
    policyRevision: 'pol-1',
    implementerModel: 'openrouter/inception/mercury-3',
    requiredChecks: [],
    state: 'pending',
    verificationReceipts: [],
    reviewReceipts: [wb5aReceiptRecord()],
    findingDispositions: [],
    acceptanceReceiptId: null,
    blockers: [],
    revision: 1,
    updatedAtIso: '2026-11-06T10:00:00Z',
    ...overrides,
  };
}

class InMemoryEvidenceRepo implements EvidenceAssessmentRepositoryPort {
  constructor(public assessment: EvidenceAssessmentRecord | null) {}
  async findAssessmentById(id: string): Promise<EvidenceAssessmentRecord | null> {
    return this.assessment && this.assessment.id === id ? this.assessment : null;
  }
  async findAssessmentByHead(head: string): Promise<EvidenceAssessmentRecord | null> {
    return this.assessment && this.assessment.candidateHeadSha === head ? this.assessment : null;
  }
  async saveAssessment(assessment: EvidenceAssessmentRecord): Promise<void> {
    this.assessment = assessment;
  }
}

const noOwnerDecisions = {
  readAttemptOwnerDecisionReferences: async () =>
    ({ outcome: 'recorded' as const, ownerDecisionReferences: [] as readonly string[] }),
};

const acceptanceRequest = {
  assessmentId: 'assessment-att-1',
  candidateHeadSha: ASSESSMENT_HEAD,
  policyRevision: 'pol-1',
};

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('RV3 severity-derived review outcomes', () => {
  it('decideReviewReceiptOutcome maps severities: minor-only fail passes with carried minors, blocker/major fail, zero-finding fail unknown', () => {
    const minorOnly = wb5aReceiptRecord();
    const minorDecision = decideReviewReceiptOutcome(minorOnly);
    expect(minorDecision.outcome).toBe('pass');
    expect(minorDecision.outcome === 'pass' && minorDecision.carriedMinors.map((f) => f.findingId)).toEqual([WB5A_FINDING_ID]);

    const blocking = wb5aReceiptRecord({
      findings: [
        { ...WB5A_STORE_C_FIXTURE.receipt.findings[0]!, severity: 'major' },
      ],
    });
    expect(decideReviewReceiptOutcome(blocking)).toEqual({ outcome: 'fail' });

    const zeroFinding = wb5aReceiptRecord({ findings: [] });
    expect(decideReviewReceiptOutcome(zeroFinding)).toEqual({
      outcome: 'unknown',
      unknownReason: 'unparseable-verdict',
    });

    const noFindingsOnFail = wb5aReceiptRecord({ findings: [], unknownReason: 'no-findings-on-fail' });
    expect(decideReviewReceiptOutcome(noFindingsOnFail)).toEqual({
      outcome: 'unknown',
      unknownReason: 'no-findings-on-fail',
    });

    const blockerOnPass = wb5aReceiptRecord({
      result: 'pass',
      findings: [{ ...WB5A_STORE_C_FIXTURE.receipt.findings[0]!, severity: 'blocker' }],
    });
    expect(decideReviewReceiptOutcome(blockerOnPass)).toEqual({ outcome: 'fail' });
  });

  it('decideConductorReviewOutcome agrees with the evidence decider across the verdict/severity matrix', () => {
    const finding = (severity: 'blocker' | 'major' | 'minor' | 'nit', id = 'f-1') => ({
      findingId: id,
      severity,
      summary: 's',
      filePath: 'src/a.ts',
      line: 1,
    });
    const base = { receiptId: 'r', requestId: null, kind: 'code-review' as const, reviewerModel: 'rm', candidateHeadSha: COMMIT_A };

    expect(decideConductorReviewOutcome({ ...base, verdict: 'failed', findings: [finding('minor')] })).toEqual({
      outcome: 'passed',
      reasonCode: 'review-passed',
      detail: 'minor-only-findings',
      carriedMinors: [{ findingId: 'f-1', severity: 'minor', filePath: 'src/a.ts', line: 1 }],
    });
    expect(decideConductorReviewOutcome({ ...base, verdict: 'passed', findings: [finding('nit', 'f-2')] }).detail).toBe('minor-only-findings');
    expect(decideConductorReviewOutcome({ ...base, verdict: 'failed', findings: [] })).toEqual({
      outcome: 'unknown',
      reasonCode: 'review-unknown',
      detail: 'unparseable-verdict',
      carriedMinors: [],
    });
    expect(
      decideConductorReviewOutcome({ ...base, verdict: 'failed', findings: [], unknownReason: 'no-findings-on-fail' }).detail,
    ).toBe('no-findings-on-fail');
    for (const severity of ['blocker', 'major'] as const) {
      expect(decideConductorReviewOutcome({ ...base, verdict: 'passed', findings: [finding(severity)] })).toEqual({
        outcome: 'failed',
        reasonCode: 'review-failed',
        detail: null,
        carriedMinors: [],
      });
    }
    expect(decideConductorReviewOutcome({ ...base, verdict: 'unknown', findings: [finding('minor')] }).outcome).toBe('unknown');
    expect(
      decideConductorReviewOutcome({ ...base, verdict: 'failed', findings: [finding('minor')], readOnlyVerified: false }).outcome,
    ).toBe('unknown');
    expect(decideConductorReviewOutcome({ ...base, verdict: 'passed', findings: [] })).toEqual({
      outcome: 'passed',
      reasonCode: 'review-passed',
      detail: null,
      carriedMinors: [],
    });
  });

  it('LaneRun.create accepts colon-scoped park finding ids and refuses a parked findings snapshot of []', () => {
    const withColon = LaneRun.create({
      ...BASE_RECORD,
      parkCount: 1,
      parked: {
        reason: 'blocker-after-round-2',
        qualifier: null,
        parkedFrom: 'fixing',
        questionId: null,
        findings: [
          {
            findingId: WB5A_FINDING_ID,
            severity: 'major',
            summary: 'a blocking colon-scoped finding',
            filePath: 'src/ex.ts',
            line: 8,
          },
        ],
      },
    });
    expect(withColon.success, withColon.success ? undefined : withColon.error?.message).toBe(true);

    const withEmpty = LaneRun.create({
      ...BASE_RECORD,
      parkCount: 1,
      parked: {
        reason: 'blocker-after-round-2',
        qualifier: null,
        parkedFrom: 'fixing',
        questionId: null,
        findings: [],
      },
    });
    expect(withEmpty.success).toBe(false);
  });
});

/** A round-2 `fixing` harness with a journalled code-review failure at the head. */
async function roundTwoFixingHarness(
  answer: (request: FindLatestReceiptOfKindRequest) => Promise<FindLatestReceiptOfKindResult>,
): Promise<Harness> {
  const harness = await makeHarness(
    runRecord({ round: 2, attemptIds: ['attempt-example-1', 'attempt-example-2', 'attempt-example-3'] }),
    [
      collectedAttempt(),
      { ...collectedAttempt(), id: 'attempt-example-2' },
      { ...collectedAttempt(), id: 'attempt-example-3' },
    ],
  );
  await conduct(harness, 'fixing', NOW);
  const codeKey = reviewKey('code-review', 0, HEAD12_A);
  await appendIntent(harness, codeKey, 'review-fixing-1', NOW);
  await appendResult(harness, codeKey, 'completed', 'review-failed', NOW);
  harness.setFindLatestReceiptAnswer(answer);
  return harness;
}

describe('RV3: the WB5a-store-c saved minor-only FAIL receipt end to end', () => {
  it('WB5a-store-c saved minor-only FAIL receipt is accepted with the minor carried and opens PR with Challenge this line, never blocking or parking', async () => {
    // 1. The aggregate: the minor finding is not unresolved, the assessment is
    // acceptable, and the finding is carried.
    const aggregate = EvidenceAssessment.fromRecord(assessmentRecord());
    expect(aggregate.unresolvedFindingIds()).toEqual([]);
    expect(aggregate.collectBlockers().some((blocker) => blocker.includes('is unresolved'))).toBe(false);
    const carried = aggregate.carriedMinorFindings();
    expect(carried.map((finding) => finding.findingId)).toEqual([WB5A_FINDING_ID]);

    // 2. The acceptance use case: receipts pass and acceptance, zero blockers,
    // the tally counts the minor-only fail as passed, and the minor is carried.
    const repo = new InMemoryEvidenceRepo(assessmentRecord());
    const useCase = new AssessHeadAcceptanceUseCase({ repo, attemptOwnerDecisionPort: noOwnerDecisions });
    const receipts = await useCase.assessHeadReceipts(acceptanceRequest);
    expect(receipts.outcome).toBe('receipts-passed');
    if (receipts.outcome === 'receipts-passed') {
      expect(receipts.reviewTally).toEqual({ pass: 1, fail: 0, unknown: 0, disagreement: false });
      expect((receipts.carriedMinors ?? []).map((finding) => finding.findingId)).toEqual([WB5A_FINDING_ID]);
    }
    const accepted = await useCase.assessHeadAcceptance(acceptanceRequest);
    expect(accepted.outcome).toBe('accepted');
    if (accepted.outcome === 'accepted') {
      expect(accepted.reviewTally).toEqual({ pass: 1, fail: 0, unknown: 0, disagreement: false });
      expect((accepted.carriedMinors ?? []).map((finding) => finding.findingId)).toEqual([WB5A_FINDING_ID]);
    }
    expect(repo.assessment?.state).toBe('accepted');

    // 3. The conductor: the code-review step journals review-passed with the
    // minor-only detail, the run never enters fixing and never parks, and the
    // open-PR body carries the minor under `## Challenge this` without the
    // reviewer prose.
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'code-review', NOW);
    harness.setReviewAnswer(async (request) => ({
      outcome: 'receipt',
      receipt: { ...wb5aReceiptSummary(request.kind as 'code-review', request.requestId), requestId: request.requestId },
    }));
    const codeKey = reviewKey('code-review', 0, HEAD12_A);
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'code-review',
      key: codeKey,
      result: 'completed',
      reasonCode: 'review-passed',
      detail: 'minor-only-findings',
    });
    // The reviewer's summary prose never reaches the journal.
    const entriesAfterReview = await harness.runJournal.listForRun(RUN_ID);
    expect(JSON.stringify(entriesAfterReview)).not.toContain('symlink or oversized file');

    // accepting: the receipts-only assessment passes at the exact head.
    harness.setReceiptsAnswer({
      outcome: 'passed',
      receiptsId: RECEIPT_ID,
      assessedHeadSha: COMMIT_A,
    });
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'accepting' });
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'accept',
      key: acceptKey(),
      result: 'completed',
      reasonCode: 'accepted',
    });
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'opening-pr' });
    // Never parked, never fixing.
    const savedRun = await harness.runRepo.get(RUN_ID);
    expect(savedRun?.parked).toBeNull();

    // open-pr with the carried minor line: the review act already journalled
    // the code-review intent (minted request id) and its review-passed
    // minor-only result, which carriedMinorsOf reads back.
    harness.setFindLatestReceiptAnswer(async (request) =>
      request.kind === 'pre-merge'
        ? {
            outcome: 'found',
            receipt: { ...wb5aReceiptSummary('pre-merge', null), requestId: null, candidateHeadSha: COMMIT_A },
          }
        : { outcome: 'not-found' },
    );
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'open-pr',
      key: openPrKey(),
      result: 'completed',
      reasonCode: 'pr-opened',
    });
    const forgeRequest = harness.forgeRequests[0] as unknown as { body?: string };
    const prBody = forgeRequest.body ?? '';
    expect(prBody).toContain('## Challenge this');
    expect(prBody).toContain(`- [minor] ${WB5A_FILE_PATH}:840`);
    expect(prBody).not.toContain('symlink or oversized file');
  });

  it('robustness (1): decideReviewReceiptOutcome and decideConductorReviewOutcome never throw on null, primitives, sparse findings arrays, unknown severities, or throwing getters', () => {
    const hostile = {
      get findings(): unknown {
        throw new Error('getter exploded');
      },
    };
    const inputs: unknown[] = [
      null,
      undefined,
      42,
      'text',
      [],
      {},
      hostile,
      { findings: [/* sparse */ ] },
      Object.assign([{}], { 0: undefined }),
      { findings: [{ severity: 'catastrophic' }], result: 'fail', readOnlyVerified: true },
      { verdict: 'explosive', findings: [null] },
      { verdict: 'failed', findings: new Proxy([], {}) },
    ];
    for (const input of inputs) {
      expect(() => decideReviewReceiptOutcome(input)).not.toThrow();
      expect(() => decideConductorReviewOutcome(input)).not.toThrow();
      const receiptDecision = decideReviewReceiptOutcome(input);
      const conductorDecision = decideConductorReviewOutcome(input);
      expect(['unknown', 'fail', 'pass']).toContain(receiptDecision.outcome);
      expect(['unknown', 'failed', 'passed']).toContain(conductorDecision.outcome);
      expect(conductorDecision.outcome === 'unknown' ? conductorDecision.reasonCode : '').toBe(
        receiptDecision.outcome === 'unknown' || receiptDecision.outcome === 'fail' ? 'review-unknown' : 'review-passed',
      );
    }
    // A corrupt severity fails closed: it is a blocker, never a pass.
    expect(
      decideConductorReviewOutcome({
        verdict: 'failed',
        findings: [{ findingId: 'f', severity: 'catastrophic', summary: 's', filePath: null, line: null }],
      }).outcome,
    ).toBe('unknown');
    expect(decideReviewReceiptOutcome({ result: 'pass', findings: [{ severity: 'catastrophic' }], readOnlyVerified: true }).outcome).toBe('unknown');
  });

  it('robustness (1): AdvanceLaneRunUseCase and AssessHeadAcceptanceUseCase return typed refusals on null, non-object, wrong-typed, and throwing-getter requests', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    const advanceUseCase = new AdvanceLaneRunUseCase(harness.deps);
    const hostileRequest = {
      get runId(): string {
        throw new Error('getter exploded');
      },
      lease: { holderId: 'driver', fence: 1 },
      nowIso: LATER,
    };
    for (const request of [null, undefined, 7, 'x', [], hostileRequest]) {
      const result = await advanceUseCase.advanceLaneRun(request as never);
      expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    }
    const wrongTyped = { runId: RUN_ID, lease: { holderId: 'driver', fence: 'one' }, nowIso: LATER };
    expect(await advanceUseCase.advanceLaneRun(wrongTyped as never)).toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
    });
    const haltedWrong = { runId: RUN_ID, lease: { holderId: 'driver', fence: 1 }, nowIso: LATER, halted: 'no' };
    expect(await advanceUseCase.advanceLaneRun(haltedWrong as never)).toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
    });

    const acceptUseCase = new AssessHeadAcceptanceUseCase({ repo: new InMemoryEvidenceRepo(assessmentRecord()), attemptOwnerDecisionPort: noOwnerDecisions });
    const hostileAccept = {
      get assessmentId(): string {
        throw new Error('getter exploded');
      },
    };
    for (const request of [null, undefined, 5, 'x', []]) {
      const result = await acceptUseCase.assessHeadAcceptance(request as never);
      expect(result).toEqual({
        outcome: 'rejected',
        reason: 'Acceptance requires a plain request object',
      });
    }
    // Objects without the required fields are rejected on their fields, never
    // thrown on.
    for (const request of [{}, hostileAccept]) {
      const result = await acceptUseCase.assessHeadAcceptance(request as never);
      expect(result.outcome).toBe('rejected');
      if (result.outcome === 'rejected') {
        expect(result.reason).toBe('Acceptance requires an assessmentId, a candidateHeadSha, and a policyRevision');
      }
    }
  });

  it('robustness (2): a cut-short or throwing receipt read during carriedMinorsOf or blockerFindingsFor leaves recoverable state without corrupting open-pr or park', async () => {
    // open-pr: a throwing carried-minors read still opens the PR.
    const prHarness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(prHarness, 'opening-pr', NOW);
    await appendIntent(prHarness, acceptKey(), null, NOW);
    await appendResult(prHarness, acceptKey(), 'completed', 'accepted', NOW);
    const codeKey = reviewKey('code-review', 0, HEAD12_A);
    await appendIntent(prHarness, codeKey, 'review-cut-1', NOW);
    await appendResult(prHarness, codeKey, 'completed', 'review-passed', NOW, 'minor-only-findings');
    prHarness.setFindReceiptAnswer(async () => {
      throw new Error('receipt store cut short');
    });
    prHarness.setFindLatestReceiptAnswer(async () => {
      throw new Error('receipt store cut short');
    });
    expect(await advance(prHarness)).toEqual({
      outcome: 'acted',
      step: 'open-pr',
      key: openPrKey(),
      result: 'completed',
      reasonCode: 'pr-opened',
    });

    // Park: a throwing receipt read stores `null` (unread), never [].
    const parkHarness = await roundTwoFixingHarness(async () => {
      throw new Error('receipt store cut short');
    });
    expect(await advance(parkHarness)).toEqual({ outcome: 'parked', reason: 'blocker-after-round-2', qualifier: null });
    const parkedRecord = await parkHarness.runRepo.get(RUN_ID);
    expect(parkedRecord?.parked?.findings).toBeNull();
  });

  it('robustness (3): crash between review intent and result reconciles minor-only FAIL once to review-passed without re-requesting review, and repeat acceptance preserves carriedMinors', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'code-review', NOW);
    // The review request itself never answers (a crash after the intent).
    harness.setReviewAnswer(async () => {
      throw new Error('delegate-failed');
    });
    const codeKey = reviewKey('code-review', 0, HEAD12_A);
    const first = await advance(harness);
    expect(first).toEqual({
      outcome: 'acted',
      step: 'code-review',
      key: codeKey,
      result: 'ambiguous',
      reasonCode: 'review-unknown',
    });
    // The reconcile reads the receipt by the minted request id: the WB5a
    // minor-only FAIL reconciles once to review-passed, no second request.
    harness.setFindReceiptAnswer(async (request) => ({
      outcome: 'found',
      receipt: { ...wb5aReceiptSummary('code-review', request.requestId), requestId: request.requestId },
    }));
    const second = await advance(harness);
    expect(second).toEqual({
      outcome: 'acted',
      step: 'code-review',
      key: codeKey,
      result: 'reconciled',
      reasonCode: 'review-passed',
      detail: 'minor-only-findings',
    });
    expect(harness.reviewRequests).toHaveLength(1);
    const results = (await harness.runJournal.listForRun(RUN_ID)).filter(
      (entry) => entry.kind === 'result' && entry.key === codeKey,
    );
    expect(results).toHaveLength(1);

    // Repeat acceptance after `accepted` preserves the carried minors.
    const repo = new InMemoryEvidenceRepo(assessmentRecord({ state: 'accepted', acceptanceReceiptId: 'acc-1' }));
    const useCase = new AssessHeadAcceptanceUseCase({ repo, attemptOwnerDecisionPort: noOwnerDecisions });
    const firstRun = await useCase.assessHeadAcceptance(acceptanceRequest);
    const secondRun = await useCase.assessHeadAcceptance(acceptanceRequest);
    for (const run of [firstRun, secondRun]) {
      expect(run.outcome).toBe('accepted');
      if (run.outcome === 'accepted') {
        expect((run.carriedMinors ?? []).map((finding) => finding.findingId)).toEqual([WB5A_FINDING_ID]);
      }
    }
  });

  it('robustness (4): unknown, unverified, unavailable, and zero-finding FAIL receipts stay unknown and never count as pass or empty park findings', async () => {
    // The evidence decider and the conductor decider agree.
    const zeroFinding = wb5aReceiptRecord({ findings: [] });
    expect(decideReviewReceiptOutcome(zeroFinding).outcome).toBe('unknown');
    const unverified = wb5aReceiptRecord({ readOnlyVerified: false });
    expect(decideReviewReceiptOutcome(unverified).outcome).toBe('unknown');
    const unknownResult = wb5aReceiptRecord({ result: 'unknown', unknownReason: 'empty' });
    const unknownDecision = decideReviewReceiptOutcome(unknownResult);
    expect(unknownDecision).toEqual({ outcome: 'unknown', unknownReason: 'empty' });
    // Unknown stays unknown even with minor-only findings on the conductor side.
    expect(decideConductorReviewOutcome({ verdict: 'unknown', findings: [{ findingId: 'f', severity: 'minor', summary: 's', filePath: null, line: null }] }).outcome).toBe('unknown');
    expect(decideConductorReviewOutcome({ verdict: 'passed', findings: [{ findingId: 'f', severity: 'minor', summary: 's', filePath: null, line: null }], readOnlyVerified: false }).outcome).toBe('unknown');

    // The acceptance use case blocks a zero-finding fail as review-missing.
    const repo = new InMemoryEvidenceRepo(assessmentRecord({ reviewReceipts: [wb5aReceiptRecord({ findings: [] })] }));
    const useCase = new AssessHeadAcceptanceUseCase({ repo, attemptOwnerDecisionPort: noOwnerDecisions });
    const result = await useCase.assessHeadAcceptance(acceptanceRequest);
    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(
        result.blockers.some((blocker) =>
          blocker.includes("review by 'openrouter/openai/gpt-6-luna' failed for this head with no findings (unparseable-verdict"),
        ),
      ).toBe(true);
    }
    expect(repo.assessment?.state).toBe('blocked');

    // A run whose review verdict is unknown retries once and parks ambiguous,
    // never fixing and never passed.
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'code-review', NOW);
    harness.setReviewAnswer(async (request) => ({
      outcome: 'receipt',
      receipt: {
        receiptId: 'rcpt-x',
        requestId: request.requestId,
        kind: 'code-review',
        reviewerModel: 'review-model-1',
        candidateHeadSha: COMMIT_A,
        verdict: 'unknown',
        findings: [],
      },
    }));
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'code-review',
      key: reviewKey('code-review', 0, HEAD12_A),
      result: 'completed',
      reasonCode: 'review-unknown',
    });
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'code-review',
      key: reviewKey('code-review', 0, HEAD12_A) + '/retry1',
      result: 'completed',
      reasonCode: 'review-unknown',
    });
    expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'ambiguous', qualifier: 'code-review' });

    // blockerFindingsFor: an `unavailable` receipt store stays unread (null),
    // never [].
    const parkHarness = await roundTwoFixingHarness(async () => ({ outcome: 'unavailable' as const, reason: 'unreadable' as const }));
    expect(await advance(parkHarness)).toEqual({ outcome: 'parked', reason: 'blocker-after-round-2', qualifier: null });
    const parkedRecord = await parkHarness.runRepo.get(RUN_ID);
    expect(parkedRecord?.parked?.findings).toBeNull();
  });

  it('robustness (5): secret-shaped summaries and unsafe paths never leak into journal details, PR Challenge this lines, or park findings', async () => {
    const secret = 'sk-' + 'live-' + 'a'.repeat(32);
    // Journal detail: only fixed tokens, never reviewer text.
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'code-review', NOW);
    harness.setReviewAnswer(async (request) => ({
      outcome: 'receipt',
      receipt: {
        receiptId: 'rcpt-secret',
        requestId: request.requestId,
        kind: 'code-review',
        reviewerModel: 'review-model-1',
        candidateHeadSha: COMMIT_A,
        verdict: 'failed',
        findings: [
          { findingId: 'f-1', severity: 'minor', summary: secret, filePath: '../../etc/passwd', line: 1 },
        ],
      },
    }));
    const result = (await advance(harness)) as { reasonCode?: string };
    expect(result.reasonCode).toBe('review-passed');
    expect((result as { detail?: string | null }).detail).toBe('minor-only-findings');    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(JSON.stringify(entries)).not.toContain(secret);
    expect(JSON.stringify(entries)).not.toContain('../../etc/passwd');

    // PR body: the carried minor's unsafe path is refused by renderPrBody, and
    // the open-pr falls back to a body without carried minors.
    const refused = renderPrBody({
      workOrderId: 'wo-1',
      title: 't',
      tier: 2,
      runId: 'r-1',
      rounds: 0,
      gate: 'passed',
      reviews: [],
      frozen: { hardToUndo: HARD_TO_UNDO, assumptions: ASSUMPTIONS, challengeThis: CHALLENGE_THIS },
      carriedMinors: [{ severity: 'minor', filePath: '../../etc/passwd', line: 1 }],
    });
    expect(refused.ok).toBe(false);

    // Park findings: a secret-shaped blocking summary redacts to the fixed
    // token without dropping the causing finding to [].
    const caused = causingParkFindingsView([
      { findingId: 'f-1', severity: 'major', summary: secret, filePath: 'src/ex.ts', line: 1 },
    ]);
    expect(caused).toHaveLength(1);
    expect(caused[0]!.summary).toBe('redacted blocking finding');
    expect(JSON.stringify(caused)).not.toContain(secret);
  });

  it('robustness (7): park findings and carried minors enforce count and length caps', () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      findingId: 'finding-' + index,
      severity: 'major',
      summary: 'finding number ' + index,
      filePath: 'src/ex.ts',
      line: index,
    }));
    expect(causingParkFindingsView(many)).toHaveLength(PARK_FINDINGS_MAX_COUNT);

    const overlongId = { ...many[0]!, findingId: 'f'.repeat(129) };
    const synthesized = causingParkFindingsView([overlongId]);
    expect(synthesized).toHaveLength(1);
    expect(synthesized[0]!.findingId.length).toBeLessThanOrEqual(128);
    expect(synthesized[0]!.findingId).toMatch(/^[0-9A-Za-z][0-9A-Za-z._:-]{0,127}$/);

    const overlongSummary = { ...many[0]!, summary: 'x'.repeat(500) };
    const bounded = causingParkFindingsView([overlongSummary]);
    expect(Array.from(bounded[0]!.summary).length).toBeLessThanOrEqual(160);

    // carriedMinorsOf caps at 50 items through carriedMinorsOfReceipt: the
    // conductor decision caps its carried minors too.
    const manyMinors = Array.from({ length: 60 }, (_, index) => ({
      findingId: 'finding-' + index,
      severity: 'minor' as const,
      summary: 'finding number ' + index,
      filePath: 'src/ex.ts',
      line: index,
    }));
    const decision = decideConductorReviewOutcome({ verdict: 'failed', findings: manyMinors });
    expect(decision.outcome === 'passed' && decision.carriedMinors.length).toBe(50);
  });

  it('robustness (8): open-pr with carried minors verifies frozen brief digest and records its one-way intent before grant and forge execution', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    await conduct(harness, 'opening-pr', NOW);
    await appendIntent(harness, acceptKey(), null, NOW);
    await appendResult(harness, acceptKey(), 'completed', 'accepted', NOW);
    const codeKey = reviewKey('code-review', 0, HEAD12_A);
    await appendIntent(harness, codeKey, 'review-order-1', NOW);
    await appendResult(harness, codeKey, 'completed', 'review-passed', NOW, 'minor-only-findings');

    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'open-pr',
      key: openPrKey(),
      result: 'completed',
      reasonCode: 'pr-opened',
    });
    // The one-way open-pr intent was journalled before the grant and the forge
    // execution, and it mints the forge action id.
    const entries = await harness.runJournal.listForRun(RUN_ID);
    const openIntent = entries.filter((entry) => entry.kind === 'intent' && entry.key === openPrKey());
    expect(openIntent).toHaveLength(1);
    expect(openIntent[0]!.mintedId).toMatch(/^forge-/);
    expect(harness.forgeRequests[0]!.actionId).toBe(openIntent[0]!.mintedId);
    expect(harness.grantRequests[0]!.forgeKind).toBe('push-and-open-pr');
  });

  it('production path (robustness 9): the saved minor-only FAIL receipt read through the real ReviewRequestAdapter is accepted with the minor carried, never fixing or parked', async () => {
    // The conductor composition (apps/cli/src/composition/conductor.ts) hands
    // AdvanceLaneRunUseCase a real ReviewRequestAdapter over the evidence
    // context's review and inspection use cases. Here the same adapter sits
    // over a stored copy of the saved WB5a-store-c receipt, so verdict mapping,
    // decideConductorReviewOutcome and carriedMinorsOf all run as production
    // wires them; only the evidence storage is in memory.
    const harness = await makeHarness(runRecord(), [collectedAttempt()]);
    let stored: ReviewReceiptRecord[] = [];
    const adapter = new ReviewRequestAdapter({
      requestIndependentReview: async (request) => {
        const receipt = wb5aReceiptRecord({
          id: 'rr-prod-1',
          assessmentId: request.assessmentId,
          projectId: request.projectId,
          attemptId: request.attemptId,
          candidateHeadSha: request.candidateHeadSha,
          kind: request.kind,
          requestId: request.requestId,
        });
        stored = [receipt];
        return { outcome: 'reviewed', receipt } as never;
      },
      inspectAcceptanceEvidence: async () =>
        ({
          outcome: 'found',
          assessment: assessmentRecord({
            attemptId: 'attempt-example-1',
            candidateHeadSha: COMMIT_A,
            reviewReceipts: stored,
          }),
        }) as never,
    });
    const productionHarness = { ...harness, deps: { ...harness.deps, reviewRequest: adapter } };
    await conduct(productionHarness, 'code-review', NOW);
    const codeKey = reviewKey('code-review', 0, HEAD12_A);
    expect(await advance(productionHarness)).toEqual({
      outcome: 'acted',
      step: 'code-review',
      key: codeKey,
      result: 'completed',
      reasonCode: 'review-passed',
      detail: 'minor-only-findings',
    });
    expect(await advance(productionHarness)).toEqual({ outcome: 'entered', state: 'accepting' });
    expect(await advance(productionHarness)).toMatchObject({ step: 'accept', reasonCode: 'accepted' });
    expect(await advance(productionHarness)).toEqual({ outcome: 'entered', state: 'opening-pr' });
    expect((await harness.runRepo.get(RUN_ID))?.parked).toBeNull();
    const result = await advance(productionHarness);
    expect(result).toMatchObject({ step: 'open-pr', reasonCode: 'pr-opened' });
    const prBody = (productionHarness.forgeRequests[0] as unknown as { body?: string }).body ?? '';
    expect(prBody).toContain(`- [minor] ${WB5A_FILE_PATH}:840`);
    expect(prBody).not.toContain('symlink or oversized file');
  });
});
