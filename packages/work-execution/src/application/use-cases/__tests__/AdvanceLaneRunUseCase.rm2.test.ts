/**
 * RM2: after two unparseable (`review-unknown`) verdicts from one review seat at
 * one head, the next review goes to the next eligible seat of the run's review
 * plan (never an implementer-family seat); the run parks `ambiguous` only when
 * every eligible seat is spent. Every store is in-memory.
 */

import { describe, expect, it } from 'vitest';

import type { AttemptRecord, CollectedAttemptArtifacts, WorkOrderRecord } from '../../../domain/execution-records.js';
import { LaneRun } from '../../../domain/entities/LaneRun.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { LaneRunStateValue } from '../../../domain/value-objects/LaneRunState.vo.js';
import { buildLaneRunStepKey } from '../../../domain/lane-run-keys.js';
import { laneRunReviewFact, laneRunReviewSeatUsage } from '../../../domain/lane-run-review-facts.js';
import { laneRunConductEntry, laneRunIntentEntry, laneRunResultEntry } from '../../../domain/lane-run-step-facts.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import { nextLaneRunAction, type LaneRunFacts, type LaneRunReviewFact } from '../../../domain/lane-run-decider.js';
import { selectPreMergeSeat, selectReviewSeat } from '../../../domain/seat-selection.js';
import { SeatPlan } from '../../../domain/value-objects/SeatPlan.vo.js';
import { LaneRunRepositoryAdapter } from '../../../infrastructure/adapters/LaneRunRepositoryAdapter.adapter.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { AttemptRepositoryAdapter } from '../../../infrastructure/adapters/AttemptRepositoryAdapter.adapter.js';
import { ExecutionJournalAdapter } from '../../../infrastructure/adapters/ExecutionJournalAdapter.adapter.js';
import { sha256HexDigest } from '../../../infrastructure/adapters/AttemptArtifactAdapter.adapter.js';
import { AdvanceLaneRunUseCase } from '../AdvanceLaneRunUseCase.use-case.js';
import type { AdvanceLaneRunDependencies } from '../AdvanceLaneRunUseCase.use-case.js';
import { reviewFactsOf } from '../advance-lane-run/review-fix.js';
import type { AdvanceStepContext } from '../advance-lane-run/step-context.js';
import type { ReviewRequest, ReviewReceiptSummary } from '../../ports/out/ReviewRequestPort.out-port.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const NOW = '2026-10-27T10:00:00.000Z';
const LATER = '2026-10-27T10:01:00.000Z';
const LEASE_UNTIL = '2026-10-27T10:05:00.000Z';
const HOLDER = 'driver';
const COMMIT_A = 'a'.repeat(40);
const HEAD12_A = 'a'.repeat(12);
const HEAD12_B = 'b'.repeat(12);
const PROSE = '# brief\n';
const MANIFEST_JSON = JSON.stringify({ acceptanceChecks: ['check-1'] });
const SHA = sha256HexDigest(PROSE + '\n' + MANIFEST_JSON);
const WORKTREE = '/tmp/opencode/wo-example-1/wt-example-1';
const IMPLEMENTER = 'model-example-1';

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

/** Seat 0 and seat 2 are independent reviewers; seat 1 shares the implementer's model. */
const SEAT_PLAN = {
  version: 1 as const,
  'first-pass': [{ id: 'fp-1', model: IMPLEMENTER, tool: 'opencode' }],
  fix: [{ id: 'fx-1', model: IMPLEMENTER, tool: 'opencode' }],
  review: [
    { id: 'rev-a', model: 'review-model-a', tool: 'opencode' },
    { id: 'rev-impl', model: IMPLEMENTER, tool: 'opencode' },
    { id: 'rev-b', model: 'review-model-b', tool: 'opencode' },
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

function collectedAttempt(): AttemptRecord {
  const artifacts: CollectedAttemptArtifacts = {
    headCommit: COMMIT_A,
    commitsSinceBase: [COMMIT_A],
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
    runner: {
      kind: 'opencode' as const,
      remotePort: 4166,
      host: 'lane-alias-example',
      hostName: 'lane-host-example',
      agent: null,
      model: null,
      variant: null,
    },
    seatPlan: SEAT_PLAN,
    seatSelection: {
      role: 'first-pass',
      seatIndex: 0,
      seatId: 'fp-1',
      model: IMPLEMENTER,
      tool: 'opencode',
      variant: null,
      agent: null,
    },
    stopReason: 'none',
    createdAtIso: NOW,
    updatedAtIso: NOW,
  };
}

function runRecord(): LaneRunRecord {
  const result = LaneRun.create({ ...BASE_RECORD });
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

function reviewKey(step: 'brief-check' | 'code-review', seatIndex: number, head12: string, retry: number | null = null): string {
  const built = buildLaneRunStepKey({ runId: RUN_ID, round: 0, step, seatIndex, attemptOrdinal: null, head12, retry });
  expect(built.ok).toBe(true);
  if (!built.ok) {
    throw new Error('fixture must build a review key');
  }
  return built.key;
}

function receiptFor(request: ReviewRequest, verdict: 'passed' | 'unknown'): ReviewReceiptSummary {
  return {
    receiptId: 'rcpt-' + request.requestId,
    requestId: request.requestId,
    kind: request.kind,
    reviewerModel: request.reviewerModel,
    candidateHeadSha: request.candidateHeadSha,
    verdict,
    findings: [],
  };
}

interface Harness {
  readonly deps: AdvanceLaneRunDependencies;
  readonly runJournal: LaneRunJournalAdapter;
  readonly reviewRequests: ReviewRequest[];
  setVerdictOf(answer: (request: ReviewRequest) => 'passed' | 'unknown'): void;
}

async function makeHarness(): Promise<Harness> {
  const runRepo = new LaneRunRepositoryAdapter();
  const runJournal = new LaneRunJournalAdapter();
  const attemptRepo = new AttemptRepositoryAdapter();
  const reviewRequests: ReviewRequest[] = [];
  let verdictOf: (request: ReviewRequest) => 'passed' | 'unknown' = () => 'unknown';
  expect((await runRepo.create(runRecord())).outcome).toBe('saved');
  const leased = await runRepo.acquireLease(RUN_ID, { holderId: HOLDER, observedFence: 0, leaseUntilIso: LEASE_UNTIL, nowIso: NOW });
  expect(leased.outcome).toBe('saved');
  await attemptRepo.saveAttempt(collectedAttempt());
  const deps: AdvanceLaneRunDependencies = {
    runRepo,
    runJournal,
    attemptRepo,
    executionJournal: new ExecutionJournalAdapter(),
    artifactPort: {
      readBriefManifest: async () => MANIFEST_JSON,
      readBriefFile: async () => PROSE,
      verifyArtifactManifest: async () => ({ outcome: 'sealed' }) as never,
    },
    reconcileAttempt: {
      reconcileAttempt: async () => ({
        outcome: 'active',
        attempt: collectedAttempt(),
        status: {
          runnerReachable: 'reachable',
          workspacePreparation: 'prepared',
          workerCommand: 'active',
          completionReceipt: null,
          artifactsCollected: false,
        },
      }),
    },
    admission: { admit: async () => ({ outcome: 'admitted' }) },
    newUlid: makeUlidMinter(),
    computeDigest: sha256HexDigest,
    sameModelFamily: (left: string, right: string) => left === right,
    reviewRequest: {
      requestReview: async (request) => {
        reviewRequests.push(request);
        return { outcome: 'receipt', receipt: receiptFor(request, verdictOf(request)) };
      },
      findReviewReceipt: async () => ({ outcome: 'not-found' }),
      findLatestReceiptOfKind: async () => ({ outcome: 'not-found' }),
    },
    reviewAssessment: { openReviewAssessment: async () => ({ outcome: 'open' }) },
    workOrderRepo: { findWorkOrderById: async () => WORK_ORDER },
  };
  return {
    deps,
    runJournal,
    reviewRequests,
    setVerdictOf: (answer) => {
      verdictOf = answer;
    },
  };
}

async function conduct(harness: Harness, state: LaneRunStateValue): Promise<void> {
  const entry = laneRunConductEntry(harness.deps.newUlid(), RUN_ID, state, NOW);
  expect((await harness.runJournal.append(entry)).outcome).toBe('appended');
}

async function advance(harness: Harness) {
  return new AdvanceLaneRunUseCase(harness.deps).advanceLaneRun({
    runId: RUN_ID,
    lease: { holderId: HOLDER, fence: 1 },
    halted: false,
    nowIso: LATER,
  });
}

/** An in-memory journal of one conducted state plus one intent and one final result per `[key, reasonCode]`. */
function journalOf(state: LaneRunStateValue, steps: ReadonlyArray<readonly [string, string | null]>): LaneRunJournalEntryRecord[] {
  const mint = makeUlidMinter();
  const entries: LaneRunJournalEntryRecord[] = [laneRunConductEntry(mint(), RUN_ID, state, NOW)];
  for (const [key, reasonCode] of steps) {
    entries.push(laneRunIntentEntry(mint(), RUN_ID, key, null, NOW));
    if (reasonCode !== null) {
      entries.push(laneRunResultEntry(mint(), RUN_ID, key, 'completed', reasonCode as never, NOW));
    }
  }
  return entries;
}

const CTX = { deps: { sameModelFamily: (left: string, right: string) => left === right } } as unknown as AdvanceStepContext;
const UNKNOWN_TWICE_ON_SEAT_0 = [
  [reviewKey('brief-check', 0, HEAD12_A), 'review-unknown'],
  [reviewKey('brief-check', 0, HEAD12_A, 1), 'review-unknown'],
] as const;

describe('RM2: review seat fallback after repeated unparseable verdicts', () => {
  it('two unparseable verdicts from seat A then a parseable verdict from seat B falls back and passes', async () => {
    const harness = await makeHarness();
    await conduct(harness, 'brief-check');
    harness.setVerdictOf((request) => (request.reviewerModel === 'review-model-a' ? 'unknown' : 'passed'));

    const first = await advance(harness);
    expect(first).toMatchObject({ outcome: 'acted', step: 'brief-check', key: reviewKey('brief-check', 0, HEAD12_A), reasonCode: 'review-unknown' });
    const second = await advance(harness);
    expect(second).toMatchObject({ outcome: 'acted', step: 'brief-check', key: reviewKey('brief-check', 0, HEAD12_A, 1), reasonCode: 'review-unknown' });
    const third = await advance(harness);
    expect(third).toEqual({
      outcome: 'acted',
      step: 'brief-check',
      key: reviewKey('brief-check', 2, HEAD12_A),
      result: 'completed',
      reasonCode: 'review-passed',
    });
    expect(harness.reviewRequests.map((request) => request.reviewerModel)).toEqual([
      'review-model-a',
      'review-model-a',
      'review-model-b',
    ]);
    expect(await advance(harness)).toEqual({ outcome: 'entered', state: 'code-review' });
  });

  it('one unparseable verdict then a parseable one from the same seat retries that seat and does not fall back', async () => {
    const harness = await makeHarness();
    await conduct(harness, 'brief-check');
    let calls = 0;
    harness.setVerdictOf(() => {
      calls += 1;
      return calls === 1 ? 'unknown' : 'passed';
    });
    await advance(harness);
    const retried = await advance(harness);
    expect(retried).toMatchObject({ key: reviewKey('brief-check', 0, HEAD12_A, 1), reasonCode: 'review-passed' });
    expect(harness.reviewRequests.map((request) => request.reviewerModel)).toEqual(['review-model-a', 'review-model-a']);
  });

  it('exhausting every eligible seat parks ambiguous and never asks the implementer-family seat', async () => {
    const harness = await makeHarness();
    await conduct(harness, 'brief-check');
    for (let step = 0; step < 4; step += 1) {
      expect(await advance(harness)).toMatchObject({ outcome: 'acted', reasonCode: 'review-unknown' });
    }
    expect(await advance(harness)).toEqual({ outcome: 'parked', reason: 'ambiguous', qualifier: 'brief-check' });
    const models = harness.reviewRequests.map((request) => request.reviewerModel);
    expect(models).toEqual(['review-model-a', 'review-model-a', 'review-model-b', 'review-model-b']);
    expect(models).not.toContain(IMPLEMENTER);
  });

  it('a new head resets the order: seat A is chosen again and no seat is exhausted at the new head', () => {
    const entries = journalOf('brief-check', UNKNOWN_TWICE_ON_SEAT_0);
    const spent = reviewFactsOf(CTX, runRecord(), 'brief-check', entries, HEAD12_A, [collectedAttempt()]);
    expect(spent.reviewSeat).toEqual({ ok: true, seatIndex: 2 });
    expect(spent.briefCheck).toMatchObject({ verdict: 'unknown', seatIndex: 0, latestSeatIntents: 2, exhaustedSeatIndexes: [0] });
    const fresh = reviewFactsOf(CTX, runRecord(), 'brief-check', entries, HEAD12_B, [collectedAttempt()]);
    expect(fresh.reviewSeat).toEqual({ ok: true, seatIndex: 0 });
    expect(fresh.briefCheck).toEqual({ verdict: 'none', seatIndex: null, retries: 0 });
  });

  it('a seat pinned by an earlier failed review yields to the next seat once it is exhausted at the current head', () => {
    const failedAtA = [reviewKey('code-review', 0, HEAD12_A), 'review-failed'] as const;
    const pinnedOnly = journalOf('code-review', [failedAtA]);
    expect(reviewFactsOf(CTX, runRecord(), 'code-review', pinnedOnly, HEAD12_B, [collectedAttempt()]).reviewSeat).toEqual({ ok: true, seatIndex: 0 });
    const exhaustedAtB = journalOf('code-review', [
      failedAtA,
      [reviewKey('code-review', 0, HEAD12_B), 'review-unknown'],
      [reviewKey('code-review', 0, HEAD12_B, 1), 'review-unknown'],
    ]);
    expect(reviewFactsOf(CTX, runRecord(), 'code-review', exhaustedAtB, HEAD12_B, [collectedAttempt()]).reviewSeat).toEqual({ ok: true, seatIndex: 2 });
  });

  it('laneRunReviewFact keeps its shape: no seat-usage fields appear on it', () => {
    const entries = journalOf('brief-check', UNKNOWN_TWICE_ON_SEAT_0);
    expect(laneRunReviewFact(entries, RUN_ID, 'brief-check', HEAD12_A)).toEqual({ verdict: 'unknown', seatIndex: 0, retries: 1 });
  });
});

describe('RM2: laneRunReviewSeatUsage counts only counted intents', () => {
  const usageOf = (entries: unknown, kind: 'brief-check' | 'code-review' | 'pre-merge' = 'brief-check', head12: string | null = HEAD12_A) =>
    laneRunReviewSeatUsage(entries, RUN_ID, kind, head12);

  it('two review-unknown intents on one seat make that seat exhausted and report two intents on it', () => {
    expect(usageOf(journalOf('brief-check', UNKNOWN_TWICE_ON_SEAT_0))).toEqual({ latestSeatIntents: 2, exhaustedSeatIndexes: [0] });
  });

  it('one review-unknown intent leaves the seat unexhausted with one intent', () => {
    expect(usageOf(journalOf('brief-check', [UNKNOWN_TWICE_ON_SEAT_0[0]]))).toEqual({ latestSeatIntents: 1, exhaustedSeatIndexes: [] });
  });

  it('a seat-busy or superseded intent is not counted toward exhaustion', () => {
    const entries = journalOf('brief-check', [
      [reviewKey('brief-check', 0, HEAD12_A), 'seat-busy'],
      [reviewKey('brief-check', 0, HEAD12_A, 1), 'review-superseded'],
      [reviewKey('brief-check', 0, HEAD12_A, 2), 'review-unknown'],
    ]);
    expect(usageOf(entries)).toEqual({ latestSeatIntents: 1, exhaustedSeatIndexes: [] });
  });

  it('intents before the latest review-retry resume boundary are not counted', () => {
    const mint = makeUlidMinter();
    const entries = journalOf('brief-check', UNKNOWN_TWICE_ON_SEAT_0);
    entries.push({
      ...laneRunResultEntry(mint(), RUN_ID, UNKNOWN_TWICE_ON_SEAT_0[0][0], 'completed', 'resumed', '2026-10-27T10:00:30.000Z'),
      detail: 'review-retry',
    });
    expect(usageOf(entries)).toEqual({ latestSeatIntents: 0, exhaustedSeatIndexes: [] });
  });

  it('a review kind other than brief-check or code-review reads as no usage', () => {
    const entries = journalOf('awaiting-premerge', [
      [reviewKey('brief-check', 0, HEAD12_A), 'review-unknown'],
    ]);
    expect(usageOf(entries, 'pre-merge')).toEqual({ latestSeatIntents: 0, exhaustedSeatIndexes: [] });
  });

  it('hostile journals read as no usage without throwing or running getters', () => {
    const none = { latestSeatIntents: 0, exhaustedSeatIndexes: [] };
    let getterRan = false;
    const valid = journalOf('brief-check', UNKNOWN_TWICE_ON_SEAT_0);
    const withGetter = [
      ...valid.slice(0, 1),
      Object.defineProperty({ ...valid[1] }, 'key', {
        enumerable: true,
        get() {
          getterRan = true;
          return valid[1]!.key;
        },
      }),
    ];
    const polluted = [JSON.parse('{"kind":"intent","__proto__":{"x":1},"recordedAtIso":"x"}') as unknown];
    const hostile: ReadonlyArray<readonly [string, unknown]> = [
      ['null', null],
      ['undefined', undefined],
      ['an object', {}],
      ['an array-like', { length: 1, 0: valid[0] }],
      ['an enormous length', Object.assign(new Array(100_001), {})],
      ['a hole', new Array(2)],
      ['a primitive entry', ['x']],
      ['a getter entry', withGetter],
      ['a __proto__ own key', polluted],
    ];
    for (const [label, input] of hostile) {
      expect(usageOf(input), label).toEqual(none);
    }
    expect(getterRan).toBe(false);
  });
});

describe('RM2: seat selection and the decider', () => {
  const created = SeatPlan.create(SEAT_PLAN);
  if (!created.success || created.value === undefined) {
    throw new Error('fixture must be a valid seat plan');
  }
  const plan = { success: true as const, value: created.value };
  const sameFamily = (left: string, right: string): boolean => left === right;

  it('selectReviewSeat skips an excluded seat and the implementer-family seat', () => {
    expect(plan.success).toBe(true);
    if (!plan.success) {
      return;
    }
    const base = { plan: plan.value, round: 0, implementerModels: [IMPLEMENTER], sameFamily };
    expect(selectReviewSeat(base)).toMatchObject({ ok: true, seatIndex: 0 });
    expect(selectReviewSeat({ ...base, excludedSeatIndexes: new Set([0]) })).toMatchObject({ ok: true, seatIndex: 2 });
    expect(selectReviewSeat({ ...base, rotationStart: 0, excludedSeatIndexes: new Set([0]) })).toMatchObject({ ok: true, seatIndex: 2 });
  });

  it('selectReviewSeat and selectPreMergeSeat return ok false when every eligible seat is excluded', () => {
    expect(plan.success).toBe(true);
    if (!plan.success) {
      return;
    }
    const reviewResult = selectReviewSeat({
      plan: plan.value,
      round: 0,
      implementerModels: [IMPLEMENTER],
      sameFamily,
      excludedSeatIndexes: new Set([0, 2]),
    });
    expect(reviewResult.ok).toBe(false);
    if (!reviewResult.ok) {
      expect(reviewResult.reason).toContain('rev-a: exhausted');
    }
    const preMerge = selectPreMergeSeat({
      seats: SEAT_PLAN.review,
      attempts: [collectedAttempt()],
      sameFamily,
      excludedSeatIndexes: new Set([0, 2]),
    });
    expect(preMerge.ok).toBe(false);
    expect(selectPreMergeSeat({ seats: SEAT_PLAN.review, attempts: [collectedAttempt()], sameFamily, excludedSeatIndexes: new Set([0]) })).toMatchObject({ ok: true, seatIndex: 2 });
  });

  function unknownFacts(review: Partial<LaneRunReviewFact>, seat: LaneRunFacts['reviewSeat']): LaneRunFacts {
    return {
      state: 'brief-check',
      halted: false,
      stopMode: null,
      stopRequestedAtIso: null,
      stopGraceMinutes: 45,
      pendingIntent: null,
      admission: 'admitted',
      costCeilingReached: false,
      implementerSeat: { ok: true, seatIndex: 0 },
      reviewSeat: seat,
      roundSeatIndexes: [],
      attempt: null,
      head12: HEAD12_A,
      acceptedHead12: null,
      gate: 'none',
      gateCongestion: null,
      gateUnknown: null,
      briefCheck: { verdict: 'unknown', seatIndex: 0, retries: 1, ...review },
      codeReview: { verdict: 'none', seatIndex: null, retries: 0 },
      preMerge: 'none',
      premergePost: 'none',
      mergeEnqueue: 'none',
      acceptance: 'none',
      acceptanceRetry: null,
      ci: 'pending',
      pr: null,
      refusedStep: null,
      merge: { oneWayDoor: false, policyGrant: true },
    };
  }

  it('the decider acts on the next seat only when the unknown seat is also recorded as exhausted', () => {
    const record = runRecord();
    const act = nextLaneRunAction(record, unknownFacts({ latestSeatIntents: 2, exhaustedSeatIndexes: [0] }, { ok: true, seatIndex: 2 }), LATER);
    expect(act).toMatchObject({ kind: 'act', step: 'brief-check', seatIndex: 2, retry: null });
    // Absent fields, or a differing seat, never switch seats.
    expect(nextLaneRunAction(record, unknownFacts({}, { ok: true, seatIndex: 2 }), LATER)).toMatchObject({ kind: 'park', reason: 'ambiguous' });
    expect(nextLaneRunAction(record, unknownFacts({ latestSeatIntents: 2, exhaustedSeatIndexes: [1] }, { ok: true, seatIndex: 2 }), LATER)).toMatchObject({ kind: 'park', reason: 'ambiguous' });
    // No seat left: a plain park.
    expect(nextLaneRunAction(record, unknownFacts({ latestSeatIntents: 2, exhaustedSeatIndexes: [0] }, { ok: false }), LATER)).toMatchObject({ kind: 'park', reason: 'ambiguous', qualifier: 'brief-check' });
  });

  it('the decider retries the same seat on its first unparseable verdict even after another seat was exhausted', () => {
    const decision = nextLaneRunAction(
      runRecord(),
      unknownFacts({ seatIndex: 2, retries: 2, latestSeatIntents: 1, exhaustedSeatIndexes: [0] }, { ok: true, seatIndex: 2 }),
      LATER,
    );
    expect(decision).toMatchObject({ kind: 'act', seatIndex: 2, retry: 1 });
  });
});
