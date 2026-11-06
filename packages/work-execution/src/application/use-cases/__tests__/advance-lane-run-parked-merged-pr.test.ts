/**
 * Unit tests for CG1 and CX2: any parked run reads its PR — by number when one
 * is recorded, else by the run's own branch — keeping only a merged PR, for the
 * merged-PR rule only. No PR-number write, no journal entry, no non-parked-state
 * lookup. Every store is in-memory; no forge, no CI, no subprocess, no network.
 */

import { describe, expect, it } from 'vitest';

import type { AttemptRecord, CollectedAttemptArtifacts } from '../../../domain/execution-records.js';
import { LaneRun } from '../../../domain/entities/LaneRun.js';
import { laneRunJournalState } from '../../../domain/lane-run-journal.js';
import { LANE_RUN_PARK_REASONS } from '../../../domain/lane-run-records.js';
import type { LaneRunParkReason, LaneRunRecord } from '../../../domain/lane-run-records.js';
import { laneRunConductEntry } from '../../../domain/lane-run-step-facts.js';
import type { LaneRunStateValue } from '../../../domain/value-objects/LaneRunState.vo.js';
import type { ReadPullRequestRequest, ReadPullRequestResult } from '../../ports/out/ForgeReadPort.out-port.js';
import { LaneRunRepositoryAdapter } from '../../../infrastructure/adapters/LaneRunRepositoryAdapter.adapter.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { AttemptRepositoryAdapter } from '../../../infrastructure/adapters/AttemptRepositoryAdapter.adapter.js';
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
const SHA = 'c'.repeat(64);
const WORKTREE = '/tmp/opencode/wo-example-1/wt-example-1';

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

function attemptFixture(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: 'attempt-example-1',
    workOrderId: 'wo-example-1',
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

interface Harness {
  readonly runRepo: LaneRunRepositoryAdapter;
  readonly runJournal: LaneRunJournalAdapter;
  readonly attemptRepo: AttemptRepositoryAdapter;
  readonly forgeRequests: readonly ReadPullRequestRequest[];
  readonly deps: AdvanceLaneRunDependencies;
  setForgeAnswer(answer: ReadPullRequestResult | 'throw'): void;
}

interface HarnessOptions {
  readonly wireForge?: boolean;
  readonly forgeAncestry?: 'wired' | 'unwired';
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
  const forgeRequests: ReadPullRequestRequest[] = [];
  let forgeAnswer: ReadPullRequestResult | 'throw' = {
    outcome: 'found',
    pullRequest: {
      number: 9,
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
      readBriefManifest: async () => null,
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
    ...(options.wireForge === false
      ? {}
      : {
          forgeRead: {
            readPullRequest: async (request) => {
              forgeRequests.push(request);
              if (forgeAnswer === 'throw') {
                throw new Error('forge unavailable');
              }
              return forgeAnswer;
            },
            isConfigured: () => true,
            listOpenPullRequestsByBase: async () => ({ outcome: "unavailable" as const, reason: "not-used" }),
          },
        }),
    ...(options.forgeAncestry === 'unwired'
      ? {}
      : {
          forgeAncestry: {
            containsCommit: async ({ ancestorSha, descendantSha }) => ({
              outcome: 'answered',
              contains: descendantSha.startsWith(ancestorSha.slice(0, 4)),
            }),
          },
        }),
  };
  return {
    runRepo,
    runJournal,
    attemptRepo,
    forgeRequests,
    deps,
    setForgeAnswer: (answer) => {
      forgeAnswer = answer;
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

function mergedPullRequest(overrides: Partial<Extract<ReadPullRequestResult, { outcome: 'found' }>['pullRequest']> = {}): Extract<ReadPullRequestResult, { outcome: 'found' }> {
  return {
    outcome: 'found',
    pullRequest: {
      number: 9,
      state: 'merged',
      mergeState: 'clean',
      headSha: COMMIT,
      headRef: 'wt-example-1',
      baseRef: 'main',
      mergedAtIso: LATER,
      closedAtIso: null,
      mergeCommitSha: 'd'.repeat(40),
      ...overrides,
    },
  };
}

function parkedFixture(): { record: LaneRunRecord; attempts: readonly [ReturnType<typeof collectedAttempt>] } {
  const record = runRecord({
    parked: { reason: 'step-refused', qualifier: 'open-pr', parkedFrom: 'opening-pr', questionId: null },
    parkCount: 1,
  });
  return { record, attempts: [collectedAttempt()] };
}

async function parkedHarness(options: HarnessOptions = {}): Promise<Harness> {
  const { record, attempts } = parkedFixture();
  const harness = await makeHarness(record, attempts, options);
  await conduct(harness, 'parked', NOW);
  return harness;
}

describe('CG1: a parked run with no recorded PR number reads its PR by branch, keeping only a merged PR', () => {
  it('a merged PR at the lane head, found by branch, enters merged without saving a prNumber', async () => {
    const harness = await parkedHarness();
    harness.setForgeAnswer(mergedPullRequest());
    const result = await advance(harness);
    expect(result.outcome).toBe('entered');
    if (result.outcome !== 'entered') {
      throw new Error('expected entered');
    }
    expect(result.state).toBe('merged');
    expect(harness.forgeRequests[0]?.ref).toEqual({ kind: 'branch', branchName: 'wt-example-1' });
    const stored = await harness.runRepo.get(RUN_ID);
    expect(stored?.prNumber).toBeNull();
  });

  it('an open PR keeps the run parked', async () => {
    const harness = await parkedHarness();
    const result = await advance(harness);
    expect(result.outcome).toBe('waiting');
    if (result.outcome !== 'waiting') {
      throw new Error('expected waiting');
    }
    expect(result.reason).toBe('parked');
  });

  it('a merged PR with a different base keeps the run parked', async () => {
    const harness = await parkedHarness();
    harness.setForgeAnswer(mergedPullRequest({ baseRef: 'other-base' }));
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'waiting', reason: 'parked' });
  });

  it('a merged PR at a different head with no ancestry wired keeps the run parked', async () => {
    const harness = await parkedHarness({ forgeAncestry: 'unwired' });
    harness.setForgeAnswer(mergedPullRequest({ headSha: MOVED_COMMIT }));
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'waiting', reason: 'parked' });
  });

  it('a merged PR on a different branch keeps the run parked', async () => {
    const harness = await parkedHarness();
    harness.setForgeAnswer(mergedPullRequest({ headRef: 'some-other-branch' }));
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'waiting', reason: 'parked' });
  });

  it('a forge not-found keeps the run parked', async () => {
    const harness = await parkedHarness();
    harness.setForgeAnswer({ outcome: 'not-found' });
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'waiting', reason: 'parked' });
  });

  it('a forge throw keeps the run parked', async () => {
    const harness = await parkedHarness();
    harness.setForgeAnswer('throw');
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'waiting', reason: 'parked' });
  });

  it('a halt reads nothing and keeps the run parked', async () => {
    const harness = await parkedHarness();
    const result = await advance(harness, { halted: true });
    expect(result).toEqual({ outcome: 'waiting', reason: 'parked' });
    expect(harness.forgeRequests).toHaveLength(0);
  });

  it('a parked run with an owner question is not decided by the merged-PR lookup', async () => {
    const { record, attempts } = parkedFixture();
    const parkedRecord = runRecord({
      ...record,
      parked: { reason: 'seat-plan-exhausted', qualifier: null, parkedFrom: 'running', questionId: 'question-example-1' },
      parkCount: 1,
    });
    const harness = await makeHarness(parkedRecord, attempts);
    await conduct(harness, 'parked', NOW);
    harness.setForgeAnswer(mergedPullRequest());
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'waiting', reason: 'parked' });
  });

  it('a recorded prNumber reads the PR by number and an open PR keeps the run parked', async () => {
    const { record, attempts } = parkedFixture();
    const numberedRecord = runRecord({ ...record, prNumber: 7 });
    const harness = await makeHarness(numberedRecord, attempts);
    await conduct(harness, 'parked', NOW);
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'waiting', reason: 'parked' });
    expect(harness.forgeRequests[0]?.ref).toEqual({ kind: 'number', number: 7 });
  });
});

describe('CX2: a parked run whose PR merged with the lane head goes to merged, for every park reason', () => {
  const REASON_CASES: Record<LaneRunParkReason, { qualifier: string | null; parkedFrom: LaneRunStateValue }> = {
    'one-way-door': { qualifier: null, parkedFrom: 'fixing' },
    'seat-plan-exhausted': { qualifier: null, parkedFrom: 'fixing' },
    'blocker-after-round-2': { qualifier: null, parkedFrom: 'fixing' },
    ambiguous: { qualifier: 'merge', parkedFrom: 'merging' },
    'artifacts-unsealed': { qualifier: null, parkedFrom: 'fixing' },
    'cost-ceiling': { qualifier: null, parkedFrom: 'fixing' },
    'ci-failed-no-rounds': { qualifier: null, parkedFrom: 'fixing' },
    'branch-behind': { qualifier: null, parkedFrom: 'merging' },
    'review-seat-unavailable': { qualifier: null, parkedFrom: 'fixing' },
    halted: { qualifier: null, parkedFrom: 'fixing' },
    'stop-unconfirmed': { qualifier: null, parkedFrom: 'fixing' },
    'stop-refused': { qualifier: 'runner-refused', parkedFrom: 'fixing' },
    'acceptance-rejected': { qualifier: null, parkedFrom: 'accepting' },
    'step-refused': { qualifier: 'prepare', parkedFrom: 'fixing' },
    'owner-merge': { qualifier: null, parkedFrom: 'merging' },
    'fix-no-progress': { qualifier: null, parkedFrom: 'fixing' },
  };

  it('REASON_CASES covers exactly LANE_RUN_PARK_REASONS', () => {
    expect(Object.keys(REASON_CASES).sort()).toEqual([...LANE_RUN_PARK_REASONS].sort());
  });

  it.each(LANE_RUN_PARK_REASONS)('%s enters merged when its PR merged with the lane head', async (reason) => {
    const { qualifier, parkedFrom } = REASON_CASES[reason];
    const record = runRecord({
      prNumber: 9,
      parked: { reason, qualifier, parkedFrom, questionId: null },
      parkCount: 1,
    });
    const harness = await makeHarness(record, [collectedAttempt()]);
    await conduct(harness, 'parked', NOW);
    harness.setForgeAnswer(mergedPullRequest());
    const result = await advance(harness);
    expect(result.outcome).toBe('entered');
    if (result.outcome !== 'entered') {
      throw new Error('expected entered');
    }
    expect(result.state).toBe('merged');
    expect(laneRunJournalState(await harness.runJournal.listForRun(RUN_ID), RUN_ID)).toBe('merged');
    const stored = await harness.runRepo.get(RUN_ID);
    expect(stored?.prNumber).toBe(9);
  });

  it('CG1 sequence by name: step-refused prepare fixing with PR 638 enters merged by number', async () => {
    const record = runRecord({
      prNumber: 638,
      parked: { reason: 'step-refused', qualifier: 'prepare', parkedFrom: 'fixing', questionId: null },
      parkCount: 1,
    });
    const harness = await makeHarness(record, [collectedAttempt()]);
    await conduct(harness, 'parked', NOW);
    harness.setForgeAnswer(mergedPullRequest({ number: 638 }));
    const result = await advance(harness);
    expect(result.outcome).toBe('entered');
    if (result.outcome !== 'entered') {
      throw new Error('expected entered');
    }
    expect(result.state).toBe('merged');
    expect(harness.forgeRequests[0]?.ref).toEqual({ kind: 'number', number: 638 });
  });

  it('a merged PR without the lane head keeps the run parked', async () => {
    const record = runRecord({
      prNumber: 9,
      parked: { reason: 'step-refused', qualifier: 'prepare', parkedFrom: 'fixing', questionId: null },
      parkCount: 1,
    });
    const harness = await makeHarness(record, [collectedAttempt()]);
    await conduct(harness, 'parked', NOW);
    harness.setForgeAnswer(mergedPullRequest({ headSha: MOVED_COMMIT }));
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'waiting', reason: 'parked' });
    expect(laneRunJournalState(await harness.runJournal.listForRun(RUN_ID), RUN_ID)).not.toBe('merged');
  });

  it('a one-way-door park with an owner question stays parked even when the PR merged', async () => {
    const record = runRecord({
      prNumber: 9,
      parked: { reason: 'one-way-door', qualifier: null, parkedFrom: 'fixing', questionId: 'question-example-1' },
      parkCount: 1,
    });
    const harness = await makeHarness(record, [collectedAttempt()]);
    await conduct(harness, 'parked', NOW);
    harness.setForgeAnswer(mergedPullRequest());
    const result = await advance(harness);
    expect(result).toEqual({ outcome: 'waiting', reason: 'parked' });
  });
});
