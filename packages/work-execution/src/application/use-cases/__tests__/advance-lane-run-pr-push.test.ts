/**
 * Unit tests for K6-6: the conductor's `act open-pr` and `act push` under
 * conductor push grants (`ConductorForgeGrantPort`) through
 * `ExecuteAuthorizedForgeActionPort`, with the PR title and body rendered from
 * records only (`renderPrBody`, the frozen D7 notes). Both steps are one-way:
 * their reconciles read the forge, never re-send. Every store is in-memory;
 * no forge, no subprocess, no network.
 */

import { describe, expect, it } from 'vitest';

import type { AttemptRecord, CollectedAttemptArtifacts, WorkOrderRecord } from '../../../domain/execution-records.js';
import { LaneRun } from '../../../domain/entities/LaneRun.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import { buildLaneRunStepKey } from '../../../domain/lane-run-keys.js';
import { laneRunConductEntry, laneRunIntentEntry, laneRunResultEntry } from '../../../domain/lane-run-step-facts.js';
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
import type { ReadPullRequestRequest, ReadPullRequestResult } from '../../ports/out/ForgeReadPort.out-port.js';
import { LaneRunRepositoryAdapter } from '../../../infrastructure/adapters/LaneRunRepositoryAdapter.adapter.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { AttemptRepositoryAdapter } from '../../../infrastructure/adapters/AttemptRepositoryAdapter.adapter.js';
import { simpleDeterministicHexDigest } from '../PrepareBriefPackageUseCase.use-case.js';
import { ExecutionJournalAdapter } from '../../../infrastructure/adapters/ExecutionJournalAdapter.adapter.js';
import { AdvanceLaneRunUseCase } from '../AdvanceLaneRunUseCase.use-case.js';
import type { AdvanceLaneRunDependencies } from '../AdvanceLaneRunUseCase.use-case.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const NOW = '2026-10-27T10:00:00.000Z';
const LATER = '2026-10-27T10:01:00.000Z';
const LEASE_UNTIL = '2026-10-27T10:05:00.000Z';
const HOLDER = 'driver';
const COMMIT = 'a'.repeat(40);
const MOVED_COMMIT = 'b'.repeat(40);
const HEAD12 = 'a'.repeat(12);
const WORKTREE = '/tmp/opencode/wo-example-1/wt-example-1';
const PROJECT_ID = 'project-example';
const WORK_ORDER_ID = 'wo-example-1';
const GRANT_ID = 'grant-conductor-example-1';
const DECISION_REVISION = 'policy:conductor@0123456789ab';
const RECEIPT_ID = 'rcp-example-1';
const FORGE_REASON = 'forge smoke example 1';
const HARD_TO_UNDO = 'hard-to-undo text example 1';
const ASSUMPTIONS = 'assumptions text example 1';
const CHALLENGE_THIS = 'challenge this text example 1';

const BASE_RECORD = {
  version: 1,
  runId: RUN_ID,
  workOrderId: WORK_ORDER_ID,
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
  'first-pass': [
    { id: 'fp-1', model: 'model-example-1', tool: 'opencode' },
    { id: 'fp-2', model: 'model-example-2', tool: 'opencode' },
  ],
  fix: [{ id: 'fx-1', model: 'model-example-1', tool: 'opencode' }],
  review: [],
};

const SEAT_SELECTION = {
  role: 'first-pass' as const,
  seatIndex: 0,
  seatId: 'fp-1',
  model: 'model-example-1',
  tool: 'opencode',
  variant: null,
  agent: null,
};

const COLLECTED_ARTIFACTS: CollectedAttemptArtifacts = {
  headCommit: COMMIT,
  commitsSinceBase: [COMMIT],
  collectedArtifactPaths: [],
  notes: 'present',
};

const DEFAULT_MANIFEST = {
  stepLimit: 100,
  timeLimitSeconds: 2700,
  expectedArtifacts: [],
  prNotes: {
    hardToUndo: HARD_TO_UNDO,
    assumptions: ASSUMPTIONS,
    challengeThis: CHALLENGE_THIS,
  },
};

// SEC-5b: the open-PR read of the frozen manifest is digest-verified, so the
// attempt's recorded `briefDigest` is the digest of the frozen prose and the
// frozen manifest, frozen together.
const PROSE = '# brief\n';
const SHA = simpleDeterministicHexDigest(PROSE + '\n' + JSON.stringify(DEFAULT_MANIFEST));

function makeWorkOrder(overrides: Partial<WorkOrderRecord> = {}): WorkOrderRecord {
  return {
    id: WORK_ORDER_ID,
    projectId: PROJECT_ID,
    taskId: 'task-example-1',
    laneId: 'lane-example',
    repository: 'repo-example',
    baseCommit: COMMIT,
    ownedPaths: ['src/example.ts'],
    policyRevision: 'policy-example-1',
    prerequisiteWorkOrderIds: [],
    state: 'ready-to-merge',
    revision: 1,
    createdAtIso: NOW,
    updatedAtIso: NOW,
    risk: 'standard',
    ...overrides,
  };
}

function attemptFixture(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: 'attempt-example-1',
    workOrderId: WORK_ORDER_ID,
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: WORKTREE,
    baseCommit: COMMIT,
    state: 'intent-recorded',
    outcome: null,
    briefDigest: SHA,
    briefPackagePath: '.lane/brief-package',
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    runner: {
      kind: 'opencode',
      remotePort: 4166,
      host: 'lane-alias-example',
      hostName: 'lane-host-example',
      agent: null,
      model: null,
      variant: null,
    },
    seatPlan: SEAT_PLAN,
    seatSelection: SEAT_SELECTION,
    stopReason: 'none',
    createdAtIso: NOW,
    updatedAtIso: NOW,
    ...overrides,
  };
}

function collectedAttempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return attemptFixture({ state: 'collected', artifacts: COLLECTED_ARTIFACTS, ...overrides });
}

/** A run record via the domain entity, like the earlier K4 fixtures. */
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
  readonly step: 'prepare' | 'accept' | 'open-pr' | 'push';
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

function acceptKey(): string {
  return stepKey({ round: 0, step: 'accept', seatIndex: 0, attemptOrdinal: null, head12: HEAD12 });
}

function openPrKey(): string {
  return stepKey({ round: 0, step: 'open-pr', seatIndex: 0, attemptOrdinal: null, head12: HEAD12 });
}

function pushKey(): string {
  return stepKey({ round: 0, step: 'push', seatIndex: 0, attemptOrdinal: null, head12: HEAD12 });
}

interface Harness {
  readonly runRepo: LaneRunRepositoryAdapter;
  readonly runJournal: LaneRunJournalAdapter;
  readonly attemptRepo: AttemptRepositoryAdapter;
  readonly grantRequests: readonly ConductorForgeGrantRequest[];
  readonly forgeRequests: readonly ExecuteAuthorizedForgeActionRequest[];
  readonly forgeReadRequests: readonly ReadPullRequestRequest[];
  readonly portCalls: readonly string[];
  readonly deps: AdvanceLaneRunDependencies;
  setManifest(json: string | null): Promise<void>;
  setChangedManifestOnDisk(json: string | null): void;
  setAcceptanceAnswer(answer: AcceptanceAssessmentResult | 'throw'): void;
  setReceiptsAnswer(answer: AcceptanceReceiptsResult | 'throw'): void;
  setGrantAnswer(answer: ConductorForgeGrantResult | 'throw'): void;
  setForgeAnswer(answer: ExecuteAuthorizedForgeActionResult | 'throw'): void;
  setForgeReadAnswer(answer: ReadPullRequestResult | 'throw'): void;
  setWorkOrderNull(nullIt: boolean): void;
}

interface HarnessOptions {
  readonly wireGrant?: boolean;
  readonly wireForge?: boolean;
  readonly wireAcceptance?: boolean;
  readonly wireWorkOrder?: boolean;
  readonly wireForgeRead?: boolean;
}

function openPullRequestAtHead(number: number): ReadPullRequestResult {
  return {
    outcome: 'found',
    pullRequest: {
      number,
      state: 'open',
      mergeState: 'clean',
      headSha: COMMIT,
      headRef: 'wt-example-1',
      baseRef: 'main',
      mergedAtIso: null,
      closedAtIso: null,
      mergeCommitSha: null,
    },
  };
}

async function makeHarness(
  record: LaneRunRecord,
  attempts: readonly AttemptRecord[],
  options: HarnessOptions = {},
): Promise<Harness> {
  const runRepo = new LaneRunRepositoryAdapter();
  const runJournal = new LaneRunJournalAdapter();
  const attemptRepo = new AttemptRepositoryAdapter();
  const executionJournal = new ExecutionJournalAdapter();
  const grantRequests: ConductorForgeGrantRequest[] = [];
  const forgeRequests: ExecuteAuthorizedForgeActionRequest[] = [];
  const forgeReadRequests: ReadPullRequestRequest[] = [];
  const portCalls: string[] = [];
  let manifestJson: string | null = JSON.stringify(DEFAULT_MANIFEST);
  let acceptanceAnswer: AcceptanceAssessmentResult | 'throw' = {
    outcome: 'accepted',
    receiptId: RECEIPT_ID,
    assessedHeadSha: COMMIT,
  };
  let receiptsAnswer: AcceptanceReceiptsResult | 'throw' = {
    outcome: 'passed',
    receiptsId: RECEIPT_ID,
    assessedHeadSha: COMMIT,
  };
  let grantAnswer: ConductorForgeGrantResult | 'throw' = {
    outcome: 'issued',
    grantId: GRANT_ID,
    decisionRevision: DECISION_REVISION,
  };
  let forgeAnswer: ExecuteAuthorizedForgeActionResult | 'throw' = {
    outcome: 'executed',
    pullRequestNumber: 7,
    headSha: COMMIT,
  };
  let forgeReadAnswer: ReadPullRequestResult | 'throw' = { outcome: 'not-found' };
  let workOrderNull = false;

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
      verifyArtifactManifest: async () => ({ outcome: 'missing' }) as never,
    },
    reconcileAttempt: {
      reconcileAttempt: async () => ({
        outcome: 'active',
        attempt: attempts[attempts.length - 1] ?? attemptFixture(),
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
    ...(options.wireAcceptance === false
      ? {}
      : {
          acceptanceAssessment: {
            assessHeadAcceptance: async (_request) => {
              portCalls.push('acceptance');
              if (acceptanceAnswer === 'throw') {
                throw new Error('assessment unavailable');
              }
              return acceptanceAnswer;
            },
            assessHeadReceipts: async (_request) => {
              portCalls.push('receipts');
              if (receiptsAnswer === 'throw') {
                throw new Error('receipts assessment unavailable');
              }
              return receiptsAnswer;
            },
          },
        }),
    ...(options.wireGrant === false
      ? {}
      : {
          conductorForgeGrant: {
            issueConductorForgeGrant: async (request) => {
              grantRequests.push(request);
              portCalls.push('grant');
              if (grantAnswer === 'throw') {
                throw new Error('grant unavailable');
              }
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
              portCalls.push('forge');
              if (forgeAnswer === 'throw') {
                throw new Error('forge unavailable');
              }
              return forgeAnswer;
            },
          },
        }),
    ...(options.wireWorkOrder === false
      ? {}
      : {
          workOrderRepo: {
            findWorkOrderById: async (workOrderId) => {
              portCalls.push('work-order');
              if (workOrderNull) {
                return null;
              }
              return makeWorkOrder({ id: workOrderId });
            },
          },
        }),
    ...(options.wireForgeRead === false
      ? {}
      : {
          forgeRead: {
            readPullRequest: async (_request) => {
              forgeReadRequests.push(_request);
              portCalls.push('forge-read');
              if (forgeReadAnswer === 'throw') {
                throw new Error('forge read unavailable');
              }
              return forgeReadAnswer;
            },
            isConfigured: () => true,
          },
        }),
  };
  return {
    runRepo,
    runJournal,
    attemptRepo,
    grantRequests,
    forgeRequests,
    forgeReadRequests,
    portCalls,
    deps,
    setManifest: async (json) => {
      manifestJson = json;
      // SEC-5b: a re-frozen manifest re-freezes the stored attempts' digests
      // too, so every read of the served manifest verifies against it.
      if (json !== null) {
        const digest = simpleDeterministicHexDigest(PROSE + '\n' + json);
        for (const attempt of await attemptRepo.listAllAttempts()) {
          if (attempt.briefDigest !== digest) {
            await attemptRepo.saveAttempt({
              ...attempt,
              revision: (attempt.revision ?? 0) + 1,
              briefDigest: digest,
            });
          }
        }
      }
    },
    // The changed-on-disk path (SEC-5b): the served manifest changes without
    // any attempt digest being re-frozen — every digest read then mismatches.
    setChangedManifestOnDisk: (json) => {
      manifestJson = json;
    },
    setAcceptanceAnswer: (answer) => {
      acceptanceAnswer = answer;
    },
    setReceiptsAnswer: (answer) => {
      receiptsAnswer = answer;
    },
    setGrantAnswer: (answer) => {
      grantAnswer = answer;
    },
    setForgeAnswer: (answer) => {
      forgeAnswer = answer;
    },
    setForgeReadAnswer: (answer) => {
      forgeReadAnswer = answer;
    },
    setWorkOrderNull: (nullIt) => {
      workOrderNull = nullIt;
    },
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

async function conduct(harness: Harness, state: Parameters<typeof laneRunConductEntry>[2], nowIso: string): Promise<void> {
  const entry = laneRunConductEntry(harness.deps.newUlid(), RUN_ID, state, nowIso);
  const appended = await harness.runJournal.append(entry);
  expect(appended.outcome).toBe('appended');
}

async function appendIntent(
  harness: Harness,
  key: string,
  mintedId: string | null,
  recordedAtIso: string,
): Promise<void> {
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
): Promise<void> {
  const entry = laneRunResultEntry(harness.deps.newUlid(), RUN_ID, key, outcome, reasonCode, recordedAtIso);
  const appended = await harness.runJournal.append(entry);
  expect(appended.outcome).toBe('appended');
}

/** A collected attempt in `opening-pr`, accepted at the collected head. */
async function openingPrHarness(options: HarnessOptions = {}, record: LaneRunRecord = runRecord()): Promise<Harness> {
  const harness = await makeHarness(record, [collectedAttempt()], options);
  await conduct(harness, 'opening-pr', NOW);
  await appendIntent(harness, acceptKey(), null, NOW);
  await appendResult(harness, acceptKey(), 'completed', 'accepted', NOW);
  return harness;
}

/** A collected attempt in `pushing`, accepted at the collected head. */
async function pushingHarness(options: HarnessOptions = {}, record: LaneRunRecord = runRecord()): Promise<Harness> {
  const harness = await makeHarness(record, [collectedAttempt()], options);
  await conduct(harness, 'pushing', NOW);
  await appendIntent(harness, acceptKey(), null, NOW);
  await appendResult(harness, acceptKey(), 'completed', 'accepted', NOW);
  return harness;
}

describe('AdvanceLaneRunUseCase open-pr act (K6-6)', () => {
  it('test 1: a granted, executed open-pr journals pr-opened, saves the PR number and the next advance enters watching-ci', async () => {
    const harness = await openingPrHarness();
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'open-pr',
      key: openPrKey(),
      result: 'completed',
      reasonCode: 'pr-opened',
    });
    expect(harness.grantRequests).toEqual([
      {
        projectId: PROJECT_ID,
        workOrderId: WORK_ORDER_ID,
        attemptId: 'attempt-example-1',
        forgeKind: 'push-and-open-pr',
        expectedHeadSha: COMMIT,
        policyRevision: 'policy-example-1',
        acceptanceReceiptId: RECEIPT_ID,
      },
    ]);
    expect(harness.forgeRequests).toHaveLength(1);
    const forgeRequest = harness.forgeRequests[0]!;
    expect(forgeRequest).toMatchObject({
      attemptId: 'attempt-example-1',
      workOrderId: WORK_ORDER_ID,
      kind: 'push-and-open-pr',
      expectedHeadSha: COMMIT,
      authorizationGrantId: GRANT_ID,
      authorizedBy: DECISION_REVISION,
      title: 'Fleet work order wo-example-1',
    });
    // CB-D2: the run record has no baseBranch, so the PR base and the result
    // detail are `main`.
    expect(forgeRequest.baseBranch).toBe('main');
    expect(forgeRequest.body).toContain('## What');
    expect(forgeRequest.body).toContain('## Proof');
    expect(forgeRequest.body).toContain('## Hard to undo');
    expect(forgeRequest.body).toContain('## Assumptions');
    expect(forgeRequest.body).toContain('## Challenge this');
    expect(forgeRequest.body).toContain(HARD_TO_UNDO);
    expect(forgeRequest.body).toContain(ASSUMPTIONS);
    expect(forgeRequest.body).toContain(CHALLENGE_THIS);
    expect(forgeRequest.body).not.toContain('reviewer-example-1');
    const record = await harness.runRepo.get(RUN_ID);
    expect(record?.prNumber).toBe(7);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries.some((entry) => entry.kind === 'result' && entry.key === openPrKey() && entry.outcome === 'completed' && entry.reasonCode === 'pr-opened' && entry.detail === 'main')).toBe(true);
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'watching-ci' });
  });

  it('test 1b: an open-pr against a recorded chain base names it on the forge request and result detail', async () => {
    const harness = await openingPrHarness({}, runRecord({ baseBranch: 'chain/example' }));
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'open-pr',
      key: openPrKey(),
      result: 'completed',
      reasonCode: 'pr-opened',
    });
    expect(harness.forgeRequests).toHaveLength(1);
    expect(harness.forgeRequests[0]?.baseBranch).toBe('chain/example');
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries.some((entry) => entry.kind === 'result' && entry.key === openPrKey() && entry.outcome === 'completed' && entry.reasonCode === 'pr-opened' && entry.detail === 'chain/example')).toBe(true);
  });

  it('test 1c: the push grant carries the receipts-only rcp id and assessHeadAcceptance is never called (KF-22b)', async () => {
    const harness = await openingPrHarness();
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'open-pr',
      key: openPrKey(),
      result: 'completed',
      reasonCode: 'pr-opened',
    });
    expect(harness.grantRequests).toHaveLength(1);
    expect(harness.grantRequests[0]).toMatchObject({ acceptanceReceiptId: RECEIPT_ID });
    expect(RECEIPT_ID.startsWith('rcp-')).toBe(true);
    expect(harness.portCalls).toContain('receipts');
    expect(harness.portCalls).not.toContain('acceptance');
  });

  it('test 2: missing frozen prNotes refuses forge-refused with no grant and no forge call, then the next advance parks step-refused open-pr', async () => {
    const harness = await openingPrHarness();
    await harness.setManifest(JSON.stringify({ stepLimit: 100, timeLimitSeconds: 2700, expectedArtifacts: [] }));
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'open-pr',
      key: openPrKey(),
      result: 'refused',
      reasonCode: 'forge-refused',
    });
    expect(harness.grantRequests).toEqual([]);
    expect(harness.forgeRequests).toEqual([]);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    const intents = entries.filter((entry) => entry.kind === 'intent' && entry.key === openPrKey());
    expect(intents).toHaveLength(1);
    expect(intents[0]!.mintedId).toBeNull();
    expect(await advance(harness)).toEqual({
      outcome: 'parked',
      reason: 'step-refused',
      qualifier: 'open-pr',
    });
  });

  it('test 2b (SEC-5b): a changed-on-disk frozen manifest refuses forge-refused with no intent, grant or forge call', async () => {
    const harness = await openingPrHarness();
    // A valid manifest whose bytes changed without any digest re-freeze: the
    // verified read fails closed before any intent, grant or forge call.
    harness.setChangedManifestOnDisk(JSON.stringify({ ...DEFAULT_MANIFEST, stepLimit: 101 }));
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'open-pr',
      key: openPrKey(),
      result: 'refused',
      reasonCode: 'forge-refused',
    });
    expect(harness.grantRequests).toEqual([]);
    expect(harness.forgeRequests).toEqual([]);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    const intents = entries.filter((entry) => entry.kind === 'intent' && entry.key === openPrKey());
    expect(intents).toHaveLength(1);
    expect(intents[0]!.mintedId).toBeNull();
  });

  it('test 3: a refused grant journals grant-refused with the keyed intent minted to the action id and no forge call', async () => {
    const harness = await openingPrHarness();
    harness.setGrantAnswer({ outcome: 'refused', reason: FORGE_REASON });
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'open-pr',
      key: openPrKey(),
      result: 'refused',
      reasonCode: 'grant-refused',
    });
    expect(harness.forgeRequests).toEqual([]);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    const intents = entries.filter((entry) => entry.kind === 'intent' && entry.key === openPrKey());
    expect(intents).toHaveLength(1);
    // The intent is minted to the action id before the grant, so it is never null.
    // The deterministic ulid minter consumed one id each for the conduct, the accept
    // intent and the accept result, so the action id is the minter's fourth value.
    expect(intents[0]!.mintedId).toBe('forge-01JB0000000000000000000003');
    const results = entries.filter((entry) => entry.kind === 'result' && entry.key === openPrKey());
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ outcome: 'refused', reasonCode: 'grant-refused' });
  });

  it('test 3b: a thrown grant journals exactly one refused/grant-refused result under the already-journalled intent and no forge call', async () => {
    const harness = await openingPrHarness();
    harness.setGrantAnswer('throw');
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'open-pr',
      key: openPrKey(),
      result: 'refused',
      reasonCode: 'grant-refused',
    });
    expect(harness.grantRequests).toHaveLength(1);
    expect(harness.forgeRequests).toEqual([]);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    const intents = entries.filter((entry) => entry.kind === 'intent' && entry.key === openPrKey());
    expect(intents).toHaveLength(1);
    expect(intents[0]!.mintedId).toBe('forge-01JB0000000000000000000003');
    const results = entries.filter((entry) => entry.kind === 'result' && entry.key === openPrKey());
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ outcome: 'refused', reasonCode: 'grant-refused' });
    // The spent one-way key parks on the next advance; no second grant is issued.
    expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'open-pr' });
    expect(harness.grantRequests).toHaveLength(1);
  });

  it('test 4: an ambiguous forge outcome leaves the intent pending; the reconcile that finds the PR at the head reconciles and fills the PR number, calling the forge action exactly once', async () => {
    const harness = await openingPrHarness();
    harness.setForgeAnswer({ outcome: 'refused', reason: FORGE_REASON, forgeAmbiguous: true });
    const first = await advance(harness);
    expect(first).toEqual({
      outcome: 'acted',
      step: 'open-pr',
      key: openPrKey(),
      result: 'ambiguous',
      reasonCode: 'forge-ambiguous',
    });
    expect(harness.forgeRequests).toHaveLength(1);
    const afterAct = await harness.runJournal.listForRun(RUN_ID);
    expect(afterAct.filter((entry) => entry.kind === 'result' && entry.key === openPrKey())).toEqual([]);
    harness.setForgeReadAnswer(openPullRequestAtHead(7));
    const reconciled = await advance(harness);
    expect(reconciled).toEqual({
      outcome: 'acted',
      step: 'open-pr',
      key: openPrKey(),
      result: 'reconciled',
      reasonCode: 'pr-opened',
    });
    expect(harness.forgeRequests).toHaveLength(1);
    const record = await harness.runRepo.get(RUN_ID);
    expect(record?.prNumber).toBe(7);
  });

  it('test 5: a reconcile that finds the PR at another head refuses; an unreadable read is ambiguous', async () => {
    const moved = await openingPrHarness();
    await appendIntent(moved, openPrKey(), null, NOW);
    moved.setForgeReadAnswer({
      outcome: 'found',
      pullRequest: {
        number: 7,
        state: 'open',
        mergeState: 'clean',
        headSha: MOVED_COMMIT,
        headRef: 'wt-example-1',
        baseRef: 'main',
        mergedAtIso: null,
        closedAtIso: null,
        mergeCommitSha: null,
      },
    });
    expect(await advance(moved)).toEqual({
      outcome: 'acted',
      step: 'open-pr',
      key: openPrKey(),
      result: 'refused',
      reasonCode: 'forge-refused',
    });
    const unreadable = await openingPrHarness();
    await appendIntent(unreadable, openPrKey(), null, NOW);
    unreadable.setForgeReadAnswer({ outcome: 'unavailable', reason: FORGE_REASON });
    expect(await advance(unreadable)).toEqual({
      outcome: 'acted',
      step: 'open-pr',
      key: openPrKey(),
      result: 'ambiguous',
      reasonCode: 'forge-ambiguous',
    });
  });

  it('test 6: a forge refusal with no ambiguity journals forge-refused', async () => {
    const harness = await openingPrHarness();
    harness.setForgeAnswer({ outcome: 'refused', reason: 'head moved' });
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'open-pr',
      key: openPrKey(),
      result: 'refused',
      reasonCode: 'forge-refused',
    });
    expect(harness.forgeRequests).toHaveLength(1);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries.some((entry) => entry.kind === 'result' && entry.key === openPrKey() && entry.outcome === 'refused' && entry.reasonCode === 'forge-refused')).toBe(true);
  });

  it('test 7: after a crash the one-way key is never re-sent: the reconcile settles the intent and the forge action is never called', async () => {
    const harness = await openingPrHarness();
    await appendIntent(harness, openPrKey(), 'forge-01JB00000000000000000000', NOW);
    harness.setForgeReadAnswer(openPullRequestAtHead(7));
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'open-pr',
      key: openPrKey(),
      result: 'reconciled',
      reasonCode: 'pr-opened',
    });
    expect(harness.forgeRequests).toHaveLength(0);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries.filter((entry) => entry.kind === 'intent' && entry.key === openPrKey())).toHaveLength(1);
    const record = await harness.runRepo.get(RUN_ID);
    expect(record?.prNumber).toBe(7);
  });

  it('test 8: a null work order waits facts-inconsistent and a missing grant wiring is not-wired', async () => {
    const nullWorkOrder = await openingPrHarness();
    nullWorkOrder.setWorkOrderNull(true);
    expect(await advance(nullWorkOrder)).toEqual({ outcome: 'waiting', reason: 'facts-inconsistent' });
    const unwired = await openingPrHarness({ wireGrant: false });
    expect(await advance(unwired)).toEqual({ outcome: 'not-wired', step: 'open-pr' });
  });
});

describe('AdvanceLaneRunUseCase push act (K6-6)', () => {
  it('test 9: a granted, executed push journals pushed with no title, body or prNumber write', async () => {
    const harness = await pushingHarness();
    harness.setForgeReadAnswer({
      outcome: 'found',
      pullRequest: {
        number: 7,
        state: 'open',
        mergeState: 'clean',
        headSha: MOVED_COMMIT,
        headRef: 'wt-example-1',
        baseRef: 'main',
        mergedAtIso: null,
        closedAtIso: null,
        mergeCommitSha: null,
      },
    });
    const result = await advance(harness);
    expect(result).toEqual({
      outcome: 'acted',
      step: 'push',
      key: pushKey(),
      result: 'completed',
      reasonCode: 'pushed',
    });
    expect(harness.grantRequests).toEqual([
      {
        projectId: PROJECT_ID,
        workOrderId: WORK_ORDER_ID,
        attemptId: 'attempt-example-1',
        forgeKind: 'push-to-pr',
        expectedHeadSha: COMMIT,
        policyRevision: 'policy-example-1',
        acceptanceReceiptId: RECEIPT_ID,
      },
    ]);
    expect(harness.forgeRequests).toHaveLength(1);
    expect(harness.forgeRequests[0]).toMatchObject({
      attemptId: 'attempt-example-1',
      workOrderId: WORK_ORDER_ID,
      kind: 'push-to-pr',
      expectedHeadSha: COMMIT,
      authorizationGrantId: GRANT_ID,
      authorizedBy: DECISION_REVISION,
    });
    expect(harness.forgeRequests[0]!.title).toBeUndefined();
    expect(harness.forgeRequests[0]!.body).toBeUndefined();
    // CB-D2: a push act carries no base branch and its result detail stays null.
    expect(harness.forgeRequests[0]!.baseBranch).toBeUndefined();
    const record = await harness.runRepo.get(RUN_ID);
    expect(record?.prNumber).toBeNull();
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries.some((entry) => entry.kind === 'result' && entry.key === pushKey() && entry.outcome === 'completed' && entry.reasonCode === 'pushed' && entry.detail === null)).toBe(true);
  });

  it('test 10: an ambiguous push outcome leaves the intent pending and a reconcile at the head pushes once', async () => {
    const harness = await pushingHarness();
    harness.setForgeReadAnswer({
      outcome: 'found',
      pullRequest: {
        number: 7,
        state: 'open',
        mergeState: 'clean',
        headSha: MOVED_COMMIT,
        headRef: 'wt-example-1',
        baseRef: 'main',
        mergedAtIso: null,
        closedAtIso: null,
        mergeCommitSha: null,
      },
    });
    harness.setForgeAnswer({ outcome: 'refused', reason: FORGE_REASON, forgeAmbiguous: true });
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'push',
      key: pushKey(),
      result: 'ambiguous',
      reasonCode: 'forge-ambiguous',
    });
    expect(harness.forgeRequests).toHaveLength(1);
    harness.setForgeReadAnswer(openPullRequestAtHead(7));
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'push',
      key: pushKey(),
      result: 'reconciled',
      reasonCode: 'pushed',
    });
    expect(harness.forgeRequests).toHaveLength(1);
  });

  it('test 11: a push whose head moved since the grant is refused by the forge and journals forge-refused, then parks step-refused push', async () => {
    const harness = await pushingHarness();
    harness.setForgeReadAnswer({
      outcome: 'found',
      pullRequest: {
        number: 7,
        state: 'open',
        mergeState: 'clean',
        headSha: MOVED_COMMIT,
        headRef: 'wt-example-1',
        baseRef: 'main',
        mergedAtIso: null,
        closedAtIso: null,
        mergeCommitSha: null,
      },
    });
    // The forge re-checks the expected head at push time (ForgeActionAdapter): a moved head is a plain refusal.
    harness.setForgeAnswer({ outcome: 'refused', reason: 'expected head moved' });
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'push',
      key: pushKey(),
      result: 'refused',
      reasonCode: 'forge-refused',
    });
    expect(harness.forgeRequests).toHaveLength(1);
    expect(harness.forgeRequests[0]).toMatchObject({ kind: 'push-to-pr', expectedHeadSha: COMMIT });
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries.some((entry) => entry.kind === 'result' && entry.key === pushKey() && entry.outcome === 'refused' && entry.reasonCode === 'forge-refused')).toBe(true);
    expect(JSON.stringify(entries)).not.toContain('expected head moved');
    // The one-way key is spent: the next advance parks for the owner instead of pushing again.
    expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'push' });
    expect(harness.forgeRequests).toHaveLength(1);
  });

  it('test 12: a spent open-pr key parks step-refused open-pr without a new intent or grant/forge calls', async () => {
    const harness = await openingPrHarness();
    await appendIntent(harness, openPrKey(), null, NOW);
    await appendResult(harness, openPrKey(), 'completed', 'pr-opened', NOW);
    expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'open-pr' });
    expect(harness.grantRequests).toEqual([]);
    expect(harness.forgeRequests).toEqual([]);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries.filter((entry) => entry.kind === 'intent' && entry.key === openPrKey())).toHaveLength(1);
  });

  it('test 13: a spent push key parks step-refused push without a new intent or grant/forge calls', async () => {
    const harness = await pushingHarness();
    harness.setForgeReadAnswer({
      outcome: 'found',
      pullRequest: {
        number: 7,
        state: 'open',
        mergeState: 'clean',
        headSha: MOVED_COMMIT,
        headRef: 'wt-example-1',
        baseRef: 'main',
        mergedAtIso: null,
        closedAtIso: null,
        mergeCommitSha: null,
      },
    });
    await appendIntent(harness, pushKey(), null, NOW);
    await appendResult(harness, pushKey(), 'completed', 'pushed', NOW);
    expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'step-refused', qualifier: 'push' });
    expect(harness.grantRequests).toEqual([]);
    expect(harness.forgeRequests).toEqual([]);
    const entries = await harness.runJournal.listForRun(RUN_ID);
    expect(entries.filter((entry) => entry.kind === 'intent' && entry.key === pushKey())).toHaveLength(1);
  });

  it('test 14: a crash between the intent and the grant reconciles by the forge read, never a second grant', async () => {
    const harness = await openingPrHarness();
    await appendIntent(harness, openPrKey(), 'forge-01JB00000000000000000000', NOW);
    harness.setForgeReadAnswer(openPullRequestAtHead(7));
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'open-pr',
      key: openPrKey(),
      result: 'reconciled',
      reasonCode: 'pr-opened',
    });
    expect(harness.grantRequests).toEqual([]);
    expect(harness.forgeRequests).toEqual([]);
    const record = await harness.runRepo.get(RUN_ID);
    expect(record?.prNumber).toBe(7);
  });
});

describe('AdvanceLaneRunUseCase recorded branch (KF-5b)', () => {
  const BRANCH = 'fleet/' + RUN_ID;

  it("the open-pr forge request carries the run's recorded branch", async () => {
    const harness = await openingPrHarness({}, runRecord({ branchName: BRANCH }));
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'open-pr',
      key: openPrKey(),
      result: 'completed',
      reasonCode: 'pr-opened',
    });
    expect(harness.forgeRequests).toHaveLength(1);
    expect(harness.forgeRequests[0]).toMatchObject({ kind: 'push-and-open-pr', branchName: BRANCH });
  });

  it("the open-pr reconcile reads the PR by the recorded branch", async () => {
    const harness = await openingPrHarness({}, runRecord({ branchName: BRANCH }));
    harness.setForgeAnswer({ outcome: 'refused', reason: FORGE_REASON, forgeAmbiguous: true });
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'open-pr',
      key: openPrKey(),
      result: 'ambiguous',
      reasonCode: 'forge-ambiguous',
    });
    harness.setForgeReadAnswer(openPullRequestAtHead(7));
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'open-pr',
      key: openPrKey(),
      result: 'reconciled',
      reasonCode: 'pr-opened',
    });
    // The facts read (gc) and the reconcile read all name the recorded branch.
    expect(harness.forgeReadRequests).toHaveLength(3);
    expect(
      harness.forgeReadRequests.every(
        (request) => request.ref.kind === 'branch' && request.ref.branchName === BRANCH,
      ),
    ).toBe(true);
  });

  it("the push forge request carries the run's recorded branch", async () => {
    const harness = await pushingHarness({}, runRecord({ branchName: BRANCH }));
    harness.setForgeReadAnswer({
      outcome: 'found',
      pullRequest: {
        number: 7,
        state: 'open',
        mergeState: 'clean',
        headSha: MOVED_COMMIT,
        headRef: 'wt-example-1',
        baseRef: 'main',
        mergedAtIso: null,
        closedAtIso: null,
        mergeCommitSha: null,
      },
    });
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'push',
      key: pushKey(),
      result: 'completed',
      reasonCode: 'pushed',
    });
    expect(harness.forgeRequests).toHaveLength(1);
    expect(harness.forgeRequests[0]).toMatchObject({ kind: 'push-to-pr', branchName: BRANCH });
  });

  it('old records without the field keep the worktree-path fallback and forward no branchName', async () => {
    const harness = await openingPrHarness();
    harness.setForgeAnswer({ outcome: 'refused', reason: FORGE_REASON, forgeAmbiguous: true });
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'open-pr',
      key: openPrKey(),
      result: 'ambiguous',
      reasonCode: 'forge-ambiguous',
    });
    expect(harness.forgeRequests[0]).not.toHaveProperty('branchName');
    harness.setForgeReadAnswer(openPullRequestAtHead(7));
    expect(await advance(harness)).toEqual({
      outcome: 'acted',
      step: 'open-pr',
      key: openPrKey(),
      result: 'reconciled',
      reasonCode: 'pr-opened',
    });
    // The facts read (twice) and the reconcile read all fall back to the
    // worktree path's last segment for old records.
    expect(harness.forgeReadRequests).toHaveLength(3);
    expect(
      harness.forgeReadRequests.every(
        (request) => request.ref.kind === 'branch' && request.ref.branchName === 'wt-example-1',
      ),
    ).toBe(true);
  });
});
