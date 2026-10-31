/**
 * Unit tests for Q2a-2: the conductor reads and acts only through an attempt's
 * recorded host. A conducted attempt always carries its runner host; a missing
 * host is never read through the local executor — the frozen-manifest, artifact
 * verdict and brief-file reads call no port and return their unreadable value,
 * and the dispatch/collect/gate/review acts park `step-refused` with the step
 * as qualifier without writing a journal entry or calling any port. `prepare`
 * and `stop` are never parked by the guard. Every store is in-memory; no
 * runner, no subprocess, no network.
 */

import { describe, expect, it } from 'vitest';

import type { AttemptRecord, AttemptRunnerRecord, CollectedAttemptArtifacts, WorkOrderRecord } from '../../../domain/execution-records.js';
import { LaneRun } from '../../../domain/entities/LaneRun.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { LaneRunStateValue } from '../../../domain/value-objects/LaneRunState.vo.js';
import { buildLaneRunStepKey, laneRunStopKey } from '../../../domain/lane-run-keys.js';
import {
  laneRunConductEntry,
  laneRunIntentEntry,
  laneRunResultEntry,
} from '../../../domain/lane-run-step-facts.js';
import type { LaneRunDecision } from '../../../domain/lane-run-decider.js';
import { LaneRunRepositoryAdapter } from '../../../infrastructure/adapters/LaneRunRepositoryAdapter.adapter.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { AttemptRepositoryAdapter } from '../../../infrastructure/adapters/AttemptRepositoryAdapter.adapter.js';
import { ExecutionJournalAdapter } from '../../../infrastructure/adapters/ExecutionJournalAdapter.adapter.js';
import { AdvanceLaneRunUseCase } from '../AdvanceLaneRunUseCase.use-case.js';
import type { AdvanceLaneRunDependencies } from '../AdvanceLaneRunUseCase.use-case.js';
import type { DispatchAttemptRequest, DispatchAttemptResult } from '../../ports/in/DispatchAttemptPort.in-port.js';
import type { CollectAttemptArtifactsResult } from '../../ports/in/CollectAttemptArtifactsPort.in-port.js';
import type { EvaluateAttemptGateResult } from '../../ports/in/EvaluateAttemptGatePort.in-port.js';
import type { CancelPreparedAttemptResult } from '../../ports/in/CancelPreparedAttemptPort.in-port.js';
import type { FindReviewReceiptRequest, FindReviewReceiptResult, ReviewRequest, ReviewRequestResult } from '../../ports/out/ReviewRequestPort.out-port.js';
import type { PrepareFixAttemptRequest, PrepareFixAttemptResult } from '../../ports/in/PrepareFixAttemptPort.in-port.js';
import type { PrepareBriefPackageResult } from '../../ports/in/PrepareBriefPackagePort.in-port.js';
import type { PrepareBriefPackageUseCaseRequest } from '../PrepareBriefPackageUseCase.use-case.js';
import { readVerifiedFrozenManifest } from '../advance-lane-run/frozen-manifest.js';
import { manifestVerdictOf } from '../advance-lane-run/facts.js';
import { performReview } from '../advance-lane-run/review-fix.js';
import type { AdvanceStepContext, GatheredLaneRunFacts } from '../advance-lane-run/step-context.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const NOW = '2026-10-27T10:00:00.000Z';
const LATER = '2026-10-27T10:01:00.000Z';
const LEASE_UNTIL = '2026-10-27T10:05:00.000Z';
const HOLDER = 'driver';
const COMMIT_A = 'a'.repeat(40);
const HEAD12_A = 'a'.repeat(12);
import { simpleDeterministicHexDigest } from '../PrepareBriefPackageUseCase.use-case.js';

/** The frozen prose the harness reads for an attempt's `.lane/brief.md`; its digest seals the prior (KF-21b). */
const DEFAULT_PROSE = '# Task\n\nFix the acceptance problem.\n';
const WORKTREE = '/tmp/opencode/wo-example-1/wt-example-1';

/** The recorded host of a conducted attempt (KF-10/Q2a-2 invariant). */
const CONDUCTED_RUNNER: AttemptRunnerRecord = {
  kind: 'opencode',
  remotePort: 4166,
  host: 'lane-alias-example',
  hostName: 'lane-host-example',
  agent: null,
  model: null,
  variant: null,
};

/** The frozen manifest a conducted run writes: dispatch limits and the fix-round brief rebuild fields. */
const FULL_MANIFEST_JSON = JSON.stringify({
  workOrderId: 'wo-example-1',
  projectId: 'project-example-1',
  taskId: 'task-example-1',
  laneId: 'lane-example-1',
  repository: 'example/repo',
  baseCommit: COMMIT_A,
  policyRevision: 'policy-example-1',
  modelAssignment: { model: 'model-example-1', variant: 'default', fallbackModel: 'fallback-model', seatTool: 'opencode' },
  independentReviewer: 'review-model-1',
  ownedPaths: ['packages/example/src'],
  allowedPathPrefixes: ['packages/example/src'],
  permissions: ['filesystem:worktree'],
  acceptanceChecks: ['check-1'],
  acceptanceSpec: { commitRequired: true, diffCheck: true, commands: [{ argv: ['corepack', 'yarn', 'build'] }] },
  stepLimit: 100,
  timeLimitSeconds: 2700,
  resourceBounds: { cpu: '2' },
  expectedArtifacts: [],
  ownerDecisionReferences: [],
  prNotes: { hardToUndo: 'undo', assumptions: 'assume', challengeThis: 'challenge' },
});

// SEC-5b: the dispatch read of the frozen manifest is digest-verified, so the
// harness's prepare-brief fake freezes the digest of the prose and manifest it
// actually serves.
const SHA = simpleDeterministicHexDigest(DEFAULT_PROSE + '\n' + FULL_MANIFEST_JSON);

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

/** First-pass one seat, fix two, review one (the fix-round and review tests need them). */
const SEAT_PLAN = {
  version: 1 as const,
  'first-pass': [
    { id: 'fp-1', model: 'model-example-1', tool: 'opencode' },
    { id: 'fp-2', model: 'model-example-2', tool: 'opencode' },
  ],
  fix: [
    { id: 'fx-1', model: 'fix-model-1', tool: 'opencode' },
    { id: 'fx-2', model: 'fix-model-2', tool: 'opencode' },
  ],
  review: [
    { id: 'rev-1', model: 'review-model-1', tool: 'opencode' },
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

const COLLECTED_ARTIFACTS: CollectedAttemptArtifacts = {
  headCommit: COMMIT_A,
  commitsSinceBase: [COMMIT_A],
  collectedArtifactPaths: [],
  notes: 'present',
};

function attemptFixture(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: 'attempt-example-1',
    workOrderId: 'wo-example-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: WORKTREE,
    baseCommit: COMMIT_A,
    state: 'intent-recorded',
    outcome: null,
    revision: 0,
    briefDigest: simpleDeterministicHexDigest(DEFAULT_PROSE + '\n' + FULL_MANIFEST_JSON),
    briefPackagePath: '.lane/brief-package',
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
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
    ...overrides,
  };
}

function collectedAttempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return attemptFixture({ state: 'collected', artifacts: COLLECTED_ARTIFACTS, ...overrides });
}

function endedAttempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return attemptFixture({
    state: 'ended',
    sessionId: 'session-example-1',
    completionReceipt: {
      attemptId: 'attempt-example-1',
      sessionId: 'session-example-1',
      endedAtIso: LATER,
      authoritative: true,
      exitStatus: 0,
      stoppedByRequest: false,
    },
    ...overrides,
  });
}

/** A run record via the domain entity, like the other K4 fixtures. */
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

function stepKey(parts: {
  readonly round: number;
  readonly step: 'dispatch' | 'collect' | 'gate' | 'prepare' | 'brief-check' | 'code-review';
  readonly seatIndex: number;
  readonly attemptOrdinal: number | null;
  readonly head12: string | null;
}): string {
  const built = buildLaneRunStepKey({
    runId: RUN_ID,
    round: parts.round,
    step: parts.step,
    seatIndex: parts.seatIndex,
    attemptOrdinal: parts.attemptOrdinal,
    head12: parts.head12,
    retry: null,
  });
  expect(built.ok).toBe(true);
  if (!built.ok) {
    throw new Error('fixture must build a step key');
  }
  return built.key;
}

const DISPATCH_KEY = stepKey({ round: 0, step: 'dispatch', seatIndex: 0, attemptOrdinal: 1, head12: null });
const COLLECT_KEY = stepKey({ round: 0, step: 'collect', seatIndex: 0, attemptOrdinal: null, head12: null });
const GATE_KEY = stepKey({ round: 0, step: 'gate', seatIndex: 0, attemptOrdinal: null, head12: HEAD12_A });
const BRIEF_CHECK_KEY = stepKey({ round: 0, step: 'brief-check', seatIndex: 0, attemptOrdinal: null, head12: HEAD12_A });

interface Harness {
  readonly runRepo: LaneRunRepositoryAdapter;
  readonly runJournal: LaneRunJournalAdapter;
  readonly attemptRepo: AttemptRepositoryAdapter;
  readonly executionJournal: ExecutionJournalAdapter;
  readonly manifestReads: (AttemptRunnerRecord | null)[];
  readonly verdictReads: (AttemptRunnerRecord | null)[];
  readonly briefFileReads: (AttemptRunnerRecord | null)[];
  readonly dispatchRequests: DispatchAttemptRequest[];
  readonly collectRequests: unknown[];
  readonly gateRequests: unknown[];
  readonly cancelRequests: unknown[];
  readonly reviewRequests: ReviewRequest[];
  readonly fixRequests: PrepareFixAttemptRequest[];
  readonly briefRequests: PrepareBriefPackageUseCaseRequest[];
  readonly deps: AdvanceLaneRunDependencies;
  setManifest(json: string | null): void;
  setManifestVerdict(verdict: 'sealed' | 'missing' | 'mismatch'): void;
  setBriefText(text: string | null): void;
  setDispatchAnswer(answer: (request: DispatchAttemptRequest) => Promise<DispatchAttemptResult>): void;
  setCollectAnswer(answer: CollectAttemptArtifactsResult): void;
  setGateAnswer(answer: EvaluateAttemptGateResult): void;
  setCancelAnswer(answer: CancelPreparedAttemptResult): void;
  setReviewAnswer(answer: (request: ReviewRequest) => Promise<ReviewRequestResult>): void;
  setFixAnswer(answer: (request: PrepareFixAttemptRequest) => Promise<PrepareFixAttemptResult>): void;
  setBriefAnswer(answer: (request: PrepareBriefPackageUseCaseRequest) => Promise<PrepareBriefPackageResult>): void;
  seedReviewFailure(findings: readonly { findingId: string; severity: 'blocker' | 'major' | 'minor' | 'nit'; summary: string; filePath: string | null; line: number | null }[]): Promise<void>;
}

async function makeHarness(record: LaneRunRecord, attempts: readonly AttemptRecord[]): Promise<Harness> {
  const runRepo = new LaneRunRepositoryAdapter();
  const runJournal = new LaneRunJournalAdapter();
  const attemptRepo = new AttemptRepositoryAdapter();
  const executionJournal = new ExecutionJournalAdapter();
  const manifestReads: (AttemptRunnerRecord | null)[] = [];
  const verdictReads: (AttemptRunnerRecord | null)[] = [];
  const briefFileReads: (AttemptRunnerRecord | null)[] = [];
  const dispatchRequests: DispatchAttemptRequest[] = [];
  const collectRequests: unknown[] = [];
  const gateRequests: unknown[] = [];
  const cancelRequests: unknown[] = [];
  const reviewRequests: ReviewRequest[] = [];
  const fixRequests: PrepareFixAttemptRequest[] = [];
  const briefRequests: PrepareBriefPackageUseCaseRequest[] = [];

  let manifestJson: string | null = FULL_MANIFEST_JSON;
  let manifestVerdict: 'sealed' | 'missing' | 'mismatch' = 'sealed';
  let briefText: string | null = DEFAULT_PROSE;
  let dispatchAnswer: (request: DispatchAttemptRequest) => Promise<DispatchAttemptResult> = async (request) => ({
    outcome: 'started',
    attempt: attemptFixture({ id: request.attemptId }),
    sessionId: 'session-example-1',
  });
  let collectAnswer: CollectAttemptArtifactsResult = { outcome: 'collected', artifacts: COLLECTED_ARTIFACTS };
  let gateAnswer: EvaluateAttemptGateResult = { verdict: 'passed' };
  let cancelAnswer: CancelPreparedAttemptResult = {
    outcome: 'cancelled',
    attempt: attemptFixture({ state: 'cancelled', outcome: 'stopped' }),
    capacity: 'released',
  };
  let reviewAnswer: (request: ReviewRequest) => Promise<ReviewRequestResult> = async (request) => ({
    outcome: 'receipt',
    receipt: {
      receiptId: 'rcpt-' + request.requestId,
      requestId: request.requestId,
      kind: request.kind,
      reviewerModel: request.reviewerModel,
      candidateHeadSha: request.candidateHeadSha,
      verdict: 'passed',
      findings: [],
    },
  });
  let findReceiptAnswer: (request: FindReviewReceiptRequest) => Promise<FindReviewReceiptResult> = async () => ({
    outcome: 'not-found',
  });
  let fixAnswer: (request: PrepareFixAttemptRequest) => Promise<PrepareFixAttemptResult> = async (request) => ({
    outcome: 'prepared',
    attempt: buildFixAttempt(request, 0),
  });
  let prepareBriefAnswer: (request: PrepareBriefPackageUseCaseRequest) => Promise<PrepareBriefPackageResult> = async (request) => ({
    outcome: 'prepared',
    prepared: {
      attemptId: request.attemptId ?? '',
      briefDigest: SHA,
      prosePath: '.lane/brief.md',
      manifestPath: '.lane/brief-manifest.json',
      selectedKnowledgeVersions: [],
    },
  });

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
      readBriefManifest: async (_worktreePath: string, _manifestPath: string, recordedHost: AttemptRunnerRecord | null | undefined) => {
        manifestReads.push(recordedHost ?? null);
        return manifestJson;
      },
      verifyArtifactManifest: async (request: { recordedHost?: AttemptRunnerRecord | null }) => {
        verdictReads.push(request.recordedHost ?? null);
        return { outcome: manifestVerdict } as never;
      },
      readBriefFile: async (_worktreePath: string, _filePath: string, recordedHost: AttemptRunnerRecord | null | undefined) => {
        briefFileReads.push(recordedHost ?? null);
        return briefText;
      },
    },
    reconcileAttempt: {
      reconcileAttempt: async () => ({ outcome: 'refused', reason: 'not-found' }),
    },
    admission: {
      admit: async () => ({ outcome: 'admitted' }),
    },
    newUlid: makeUlidMinter(),
    sameModelFamily: (left: string, right: string) => left === right,
    dispatchAttempt: {
      dispatchAttempt: async (request) => {
        dispatchRequests.push(request);
        return dispatchAnswer(request);
      },
    },
    collectAttemptArtifacts: {
      collectAttemptArtifacts: async () => {
        collectRequests.push({ called: true });
        return collectAnswer;
      },
    },
    evaluateAttemptGate: {
      evaluateAttemptGate: async () => {
        gateRequests.push({ called: true });
        return gateAnswer;
      },
    },
    cancelPreparedAttempt: {
      cancelPreparedAttempt: async () => {
        cancelRequests.push({ called: true });
        return cancelAnswer;
      },
    },
    reviewRequest: {
      requestReview: async (request) => {
        reviewRequests.push(request);
        return reviewAnswer(request);
      },
      findReviewReceipt: async (request) => findReceiptAnswer(request),
      findLatestReceiptOfKind: async () => ({ outcome: 'not-found' }),
    },
    reviewAssessment: {
      openReviewAssessment: async () => ({ outcome: 'open' }),
    },
    workOrderRepo: {
      findWorkOrderById: async () => WORK_ORDER,
    },
    prepareFixAttempt: {
      prepareFixAttempt: async (request) => {
        fixRequests.push(request);
        const prepared = await fixAnswer(request);
        if (prepared.outcome === 'prepared') {
          await attemptRepo.saveAttempt(prepared.attempt);
        }
        return prepared;
      },
    },
    prepareBrief: {
      prepareBriefPackage: async (request) => {
        briefRequests.push(request);
        return prepareBriefAnswer(request);
      },
      previewBriefPackage: async () => ({ outcome: 'previewed', preview: { attemptId: '', briefDigest: SHA, modelAssignment: { model: 'model-example-1', variant: 'default', seatTool: 'opencode' }, seatPlan: null, acceptance: { commitRequired: true, diffCheck: true, commandCount: 1, commandDigests: [] }, prNotesPresent: false, selectedKnowledgeVersions: [] } }),
    },
  };

  return {
    runRepo,
    runJournal,
    attemptRepo,
    executionJournal,
    manifestReads,
    verdictReads,
    briefFileReads,
    dispatchRequests,
    collectRequests,
    gateRequests,
    cancelRequests,
    reviewRequests,
    fixRequests,
    briefRequests,
    deps,
    setManifest: (json) => {
      manifestJson = json;
    },
    setManifestVerdict: (verdict) => {
      manifestVerdict = verdict;
    },
    setBriefText: (text) => {
      briefText = text;
    },
    setDispatchAnswer: (answer) => {
      dispatchAnswer = answer;
    },
    setCollectAnswer: (answer) => {
      collectAnswer = answer;
    },
    setGateAnswer: (answer) => {
      gateAnswer = answer;
    },
    setCancelAnswer: (answer) => {
      cancelAnswer = answer;
    },
    setReviewAnswer: (answer) => {
      reviewAnswer = answer;
    },
    setFixAnswer: (answer) => {
      fixAnswer = answer;
    },
    setBriefAnswer: (answer) => {
      prepareBriefAnswer = answer;
    },
    seedReviewFailure: async (findings) => {
      const key = stepKey({ round: 0, step: 'code-review', seatIndex: 0, attemptOrdinal: null, head12: HEAD12_A });
      const requestId = 'review-' + deps.newUlid();
      const intentEntry = laneRunIntentEntry(deps.newUlid(), RUN_ID, key, requestId, NOW);
      expect((await runJournal.append(intentEntry)).outcome).toBe('appended');
      const resultEntry = laneRunResultEntry(deps.newUlid(), RUN_ID, key, 'completed', 'review-failed', NOW);
      expect((await runJournal.append(resultEntry)).outcome).toBe('appended');
      const conductEntry = laneRunConductEntry(deps.newUlid(), RUN_ID, 'fixing', NOW);
      expect((await runJournal.append(conductEntry)).outcome).toBe('appended');
      findReceiptAnswer = async (request) => ({
        outcome: 'found',
        receipt: {
          receiptId: 'rcpt-' + request.requestId,
          requestId: request.requestId,
          kind: 'code-review',
          reviewerModel: 'review-model-1',
          candidateHeadSha: COMMIT_A,
          verdict: 'failed',
          findings,
        },
      });
    },
  };
}

function buildFixAttempt(request: PrepareFixAttemptRequest, seatIndex: number): AttemptRecord {
  const seatId = seatIndex === 0 ? 'fx-1' : 'fx-2';
  return {
    id: request.fixAttemptId,
    workOrderId: request.workOrderId,
    kind: 'fix',
    fixNumber: 1,
    priorAttemptId: request.priorAttemptId,
    worktreePath: WORKTREE,
    baseCommit: COMMIT_A,
    state: 'intent-recorded',
    outcome: null,
    revision: 0,
    briefDigest: request.briefDigest ?? SHA,
    briefPackagePath: request.briefPackagePath ?? '.lane/brief-package',
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    // Q2a-1: the fix attempt inherits its prior's host block.
    runner: CONDUCTED_RUNNER,
    seatPlan: SEAT_PLAN,
    seatSelection: {
      role: 'fix',
      seatIndex,
      seatId,
      model: seatIndex === 0 ? 'fix-model-1' : 'fix-model-2',
      tool: 'opencode',
      variant: null,
      agent: null,
    },
    stopReason: 'none',
    createdAtIso: request.nowIso ?? NOW,
    updatedAtIso: request.nowIso ?? NOW,
  };
}

function advance(harness: Harness, overrides: Record<string, unknown> = {}) {
  const useCase = new AdvanceLaneRunUseCase(harness.deps);
  return useCase.advanceLaneRun({
    runId: RUN_ID,
    lease: { holderId: HOLDER, fence: 1 },
    halted: false,
    nowIso: LATER,
    ...overrides,
  });
}

async function conduct(harness: Harness, state: LaneRunStateValue, nowIso: string): Promise<void> {
  const entry = laneRunConductEntry(harness.deps.newUlid(), RUN_ID, state, nowIso);
  const appended = await harness.runJournal.append(entry);
  expect(appended.outcome).toBe('appended');
}

async function admit(harness: Harness, attemptId: string): Promise<void> {
  await harness.executionJournal.saveCapacityReservation({
    id: harness.deps.newUlid(),
    attemptId,
    hostId: 'host-example-1',
    slotIndex: 0,
    held: true,
    seatTool: 'opencode',
    reservedAtIso: NOW,
    releasedAtIso: null,
  });
}

/** The act-guard parking shape: step-refused with the step as qualifier, no intent/result, no port calls. */
async function expectParkedStepRefused(
  harness: Harness,
  key: string,
  step: string,
): Promise<void> {
  const result = await advance(harness);
  expect(result).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: step });
  const entries = await harness.runJournal.listForKey(key);
  expect(entries.filter((entry) => entry.kind === 'intent' || entry.kind === 'result')).toEqual([]);
}

describe('readVerifiedFrozenManifest and manifestVerdictOf go through the recorded host or are not made (Q2a-2)', () => {
  it('a conducted attempt with runner null calls no port and reads the unreadable value', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt({ runner: null })]);
    const attempt = (await harness.attemptRepo.findAttemptById('attempt-example-1'))!;

    expect(await readVerifiedFrozenManifest(attempt, harness.deps.artifactPort)).toBeNull();
    expect(harness.manifestReads).toEqual([]);

    expect(await manifestVerdictOf(attempt, harness.deps.artifactPort)).toBe('missing');
    expect(harness.verdictReads).toEqual([]);
  });

  it('with a host block every read receives exactly that block, never null', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt({ runner: CONDUCTED_RUNNER })]);
    const attempt = (await harness.attemptRepo.findAttemptById('attempt-example-1'))!;

    const manifest = await readVerifiedFrozenManifest(attempt, harness.deps.artifactPort);
    expect(manifest).not.toBeNull();
    expect(harness.manifestReads).toEqual([CONDUCTED_RUNNER]);

    expect(await manifestVerdictOf(attempt, harness.deps.artifactPort)).toBe('sealed');
    expect(harness.verdictReads).toEqual([CONDUCTED_RUNNER]);
  });

  it('the brief-check read is not made and the review refuses assessment-unavailable when the attempt has no host', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt({ runner: null })]);
    const latest = (await harness.attemptRepo.findAttemptById('attempt-example-1'))!;
    const ctx: AdvanceStepContext = { deps: harness.deps };
    const record = await harness.runRepo.get(RUN_ID);
    expect(record).not.toBeNull();
    const gathered: GatheredLaneRunFacts = {
      facts: {
        state: 'brief-check',
      } as never,
      deadlineUnknown: false,
      latestAttempt: latest,
      attemptRecords: [latest],
    };
    const decision: Extract<LaneRunDecision, { kind: 'act' }> = {
      kind: 'act',
      step: 'brief-check',
      key: BRIEF_CHECK_KEY,
      round: 0,
      seatIndex: 0,
      head12: HEAD12_A,
      retry: null,
    };
    const result = await performReview(ctx, record!, gathered, decision, {
      runId: RUN_ID,
      lease: { holderId: HOLDER, fence: 1 },
      halted: false,
      nowIso: LATER,
    });
    expect(result).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key: BRIEF_CHECK_KEY,
      result: 'refused',
      reasonCode: 'assessment-unavailable',
    });
    expect(harness.briefFileReads).toEqual([]);
    expect(harness.reviewRequests).toEqual([]);
  });
});

describe('the act guard parks host-reading acts on an attempt without a recorded host (Q2a-2)', () => {
  it('act dispatch parks step-refused dispatch without writing or calling any port', async () => {
    const harness = await makeHarness(runRecord(), [attemptFixture({ runner: null })]);
    await admit(harness, 'attempt-example-1');
    await expectParkedStepRefused(harness, DISPATCH_KEY, 'dispatch');
    expect(harness.dispatchRequests).toEqual([]);
    expect(harness.manifestReads).toEqual([]);
    expect(harness.cancelRequests).toEqual([]);
  });

  it('act collect parks step-refused collect without writing or calling any port', async () => {
    const harness = await makeHarness(runRecord(), [endedAttempt({ runner: null })]);
    await conduct(harness, 'collecting', NOW);
    await expectParkedStepRefused(harness, COLLECT_KEY, 'collect');
    expect(harness.collectRequests).toEqual([]);
    expect(harness.manifestReads).toEqual([]);
  });

  it('act gate parks step-refused gate without writing or calling any port', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt({ runner: null })]);
    await conduct(harness, 'gating', NOW);
    await expectParkedStepRefused(harness, GATE_KEY, 'gate');
    expect(harness.gateRequests).toEqual([]);
    expect(harness.verdictReads).toEqual([]);
  });

  it('act brief-check parks step-refused brief-check without writing or calling any port', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt({ runner: null })]);
    await conduct(harness, 'brief-check', NOW);
    await expectParkedStepRefused(harness, BRIEF_CHECK_KEY, 'brief-check');
    expect(harness.reviewRequests).toEqual([]);
    expect(harness.briefFileReads).toEqual([]);
    expect(harness.manifestReads).toEqual([]);
  });

  it('act prepare and act stop are never parked by the guard', async () => {
    // prepare: a cancelled, host-less attempt in seat-failed prepares the next
    // first-pass seat; the guard must not park it.
    const cancelled = attemptFixture({ state: 'cancelled', stopReason: 'rate-limited', runner: null });
    const prepareHarness = await makeHarness(runRecord(), [cancelled]);
    await conduct(prepareHarness, 'seat-failed', NOW);
    const prepared = await advance(prepareHarness);
    expect(prepared).not.toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'prepare' });
    expect(prepared).toMatchObject({ outcome: 'acted', step: 'prepare', reasonCode: 'prepared' });

    // stop: a prepared, host-less attempt with a graceful stop request cancels
    // under its stop key; the guard must not park it.
    const stopHarness = await makeHarness(runRecord(), [attemptFixture({ runner: null })]);
    const stopBuilt = laneRunStopKey(RUN_ID, 'web');
    expect(stopBuilt.ok).toBe(true);
    if (!stopBuilt.ok) {
      throw new Error('fixture must build a stop key');
    }
    const stopEntry = {
      ...laneRunIntentEntry(stopHarness.deps.newUlid(), RUN_ID, stopBuilt.key, null, NOW),
      mode: 'graceful' as const,
      expectedRevision: 1,
    };
    const stopAppended = await stopHarness.runJournal.append(stopEntry);
    expect(stopAppended.outcome).toBe('appended');
    const stopped = await advance(stopHarness);
    expect(stopped).not.toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'stop' });
    expect(stopped).toMatchObject({ outcome: 'acted', step: 'stop' });
  });

  it('with a host block the dispatch read and act proceed exactly as before (KF-10 regression)', async () => {
    const harness = await makeHarness(runRecord(), [attemptFixture({ runner: CONDUCTED_RUNNER })]);
    await admit(harness, 'attempt-example-1');
    const dispatched = await advance(harness);
    expect(dispatched).toEqual({
      outcome: 'acted',
      step: 'dispatch',
      key: DISPATCH_KEY,
      result: 'completed',
      reasonCode: 'dispatch-started',
    });
    expect(harness.dispatchRequests).toHaveLength(1);
    expect(harness.manifestReads.length).toBeGreaterThan(0);
    for (const read of harness.manifestReads) {
      expect(read).toEqual(CONDUCTED_RUNNER);
    }
  });
});

describe('a fix round inherits the prior host and dispatches through it (Q2a-2)', () => {
  it('the fix attempt inherits the prior host; its pre-dispatch manifest read receives the prior host block', async () => {
    const harness = await makeHarness(runRecord(), [collectedAttempt({ runner: CONDUCTED_RUNNER })]);
    await harness.seedReviewFailure([
      { findingId: 'finding-1', severity: 'blocker', summary: 'blocks', filePath: 'src/ex.ts', line: 4 },
    ]);

    const prepared = await advance(harness);
    expect(prepared).toMatchObject({ outcome: 'acted', step: 'prepare', result: 'completed', reasonCode: 'prepared' });

    const afterPrepare = await harness.runRepo.get(RUN_ID);
    const fixAttemptId = afterPrepare?.attemptIds[1];
    expect(typeof fixAttemptId).toBe('string');
    const fixAttempt = await harness.attemptRepo.findAttemptById(fixAttemptId as string);
    expect(fixAttempt?.runner).toEqual(CONDUCTED_RUNNER);

    await admit(harness, fixAttemptId as string);
    const dispatched = await advance(harness);
    expect(dispatched).toMatchObject({ outcome: 'acted', step: 'dispatch', result: 'completed', reasonCode: 'dispatch-started' });
    // The pre-dispatch manifest read received the fix attempt's inherited host (the prior's block).
    expect(harness.manifestReads.length).toBeGreaterThan(0);
    expect(harness.manifestReads[harness.manifestReads.length - 1]).toEqual(CONDUCTED_RUNNER);
    expect(harness.dispatchRequests).toHaveLength(1);
  });
});
