// Lane SR6: RecordSeatObservationUseCase and its port, exported from the
// package root. The subject checks (§3.5.5), the one-observation-per-window
// rule (§3.5.3), the dry run and every typed refusal are covered here.

import { types } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  buildLaneRunStepKey,
  RecordSeatObservationPort,
  RecordSeatObservationUseCase,
  SeatObservationRepositoryAdapter,
  type AttemptRecord,
  type LaneRunJournalEntryRecord,
  type LaneRunRecord,
  type RecordSeatObservationDependencies,
  type RecordSeatObservationResult,
} from '@fleet/work-execution';

const NOW = '2026-11-27T10:00:00.000Z';
const LATER = '2026-11-27T10:30:00.000Z';
const RUN_ID = 'run-01ARZ3N0S8VDM3S0GX00000001';
const HEAD_40 = 'a'.repeat(40);

const SEAT_PLAN = Object.freeze({
  version: 1,
  'first-pass': [{ id: 'impl-a', model: 'acme/alpha-1', tool: 'opencode' }],
  fix: [{ id: 'impl-b', model: 'acme/alpha-1', tool: 'opencode' }],
  review: [{ id: 'rev-a', model: 'acme/beta-1' }],
});

function attemptRecord(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: 'att-1',
    workOrderId: 'wo-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/tmp/wt',
    baseCommit: 'b'.repeat(40),
    state: 'running',
    outcome: null,
    briefDigest: null,
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    seatSelection: {
      role: 'first-pass',
      seatIndex: 0,
      seatId: 'seat-a',
      model: 'acme/alpha-1',
      tool: 'opencode',
      variant: null,
      agent: null,
    },
    createdAtIso: NOW,
    updatedAtIso: NOW,
    ...overrides,
  };
}

/** A minimal run record: the use case reads only runId and attemptIds. */
function laneRun(attemptIds: readonly string[]): LaneRunRecord {
  return {
    version: 1,
    runId: RUN_ID,
    workOrderId: 'wo-1',
    attemptIds: [...attemptIds],
  } as unknown as LaneRunRecord;
}

let entryCounter = 0;

function journalEntry(
  overrides: Partial<LaneRunJournalEntryRecord> = {},
): LaneRunJournalEntryRecord {
  entryCounter += 1;
  return {
    version: 1,
    entryId: `entry-${entryCounter}`,
    kind: 'intent',
    key: null,
    runId: RUN_ID,
    recordedAtIso: NOW,
    mode: null,
    expectedRevision: null,
    mintedId: null,
    outcome: null,
    reasonCode: null,
    detail: null,
    grantId: null,
    state: null,
    ...overrides,
  } as LaneRunJournalEntryRecord;
}

function reviewStepKey(step: 'brief-check' | 'code-review' | 'pre-merge', seatIndex: number): string {
  const built = buildLaneRunStepKey({
    runId: RUN_ID,
    round: 0,
    step,
    seatIndex,
    attemptOrdinal: null,
    head12: '000000000000',
    retry: null,
  });
  if (!built.ok) {
    throw new Error(`fixture step key refused: ${built.error}`);
  }
  return built.key;
}

function attemptRepo(attempts: readonly (AttemptRecord | null)[], throws = false) {
  return {
    findAttemptById: async (attemptId: string) => {
      if (throws) {
        throw new Error('attempt store unreadable');
      }
      return attempts.find((attempt) => attempt?.id === attemptId) ?? null;
    },
  };
}

interface HarnessOptions {
  readonly attempts?: readonly (AttemptRecord | null)[];
  readonly attemptsThrow?: boolean;
  readonly observationCooldownMinutes?: number;
  readonly runs?: readonly LaneRunRecord[];
  readonly journal?: readonly LaneRunJournalEntryRecord[];
  readonly runsThrow?: boolean;
  readonly journalThrow?: boolean;
  readonly highRiskReviewerSeatIds?: readonly string[];
  readonly reviewRequest?: RecordSeatObservationDependencies['reviewRequest'];
  readonly observationsThrow?: boolean;
  readonly appendThrows?: boolean;
  readonly nowIso?: () => string;
}

function harness(options: HarnessOptions = {}): {
  useCase: RecordSeatObservationPort;
  store: SeatObservationRepositoryAdapter;
} {
  const store = new SeatObservationRepositoryAdapter();
  const observations: RecordSeatObservationDependencies['observations'] = {
    listSeatObservations: async (seatId?: string) => {
      if (options.observationsThrow) {
        throw new Error('observation store unreadable');
      }
      return store.listSeatObservations(seatId);
    },
    appendSeatObservation: async (record) => {
      if (options.appendThrows) {
        throw new Error('observation store refused the write');
      }
      return store.appendSeatObservation(record);
    },
  };
  const runs = options.runs ?? [];
  const journal = options.journal ?? [];
  const deps: RecordSeatObservationDependencies = {
    observations,
    attempts: attemptRepo(options.attempts ?? [attemptRecord()], options.attemptsThrow === true),
    isProxy: types.isProxy,
    nowIso: options.nowIso ?? (() => NOW),
    mintObservationId: (() => {
      let id = 0;
      return () => {
        id += 1;
        return `obs-${id}`;
      };
    })(),
    observationCooldownMinutes: options.observationCooldownMinutes ?? 0,
    ...(options.runs !== undefined || options.journal !== undefined
      ? {
          runRepo: {
            list: async () => {
              if (options.runsThrow) {
                throw new Error('lane-run store unreadable');
              }
              return runs;
            },
          },
        }
      : {}),
    ...(options.runs !== undefined || options.journal !== undefined
      ? {
          runJournal: {
            listForRun: async () => {
              if (options.journalThrow) {
                throw new Error('lane-run journal unreadable');
              }
              return journal;
            },
          },
        }
      : {}),
    ...(options.reviewRequest !== undefined ? { reviewRequest: options.reviewRequest } : {}),
    ...(options.highRiskReviewerSeatIds !== undefined
      ? { highRiskReviewerSeatIds: options.highRiskReviewerSeatIds }
      : {}),
  };
  return { useCase: new RecordSeatObservationUseCase(deps), store };
}

const attemptInput = {
  seatId: 'seat-a',
  outcome: 'rate-limited',
  subject: { attemptId: 'att-1' },
};

const reviewInput = {
  seatId: 'rev-a',
  outcome: 'rate-limited',
  subject: { reviewRequestId: 'req-1' },
};

/** A run whose latest attempt carries a seat plan and a collected head. */
function reviewFixture(step: 'brief-check' | 'code-review' | 'pre-merge', seatIndex = 0) {
  const reviewAttempt = attemptRecord({
    id: 'att-2',
    seatSelection: {
      role: 'review',
      seatIndex,
      seatId: 'rev-a',
      model: 'acme/beta-1',
      tool: 'opencode',
      variant: null,
      agent: null,
    },
    seatPlan: SEAT_PLAN,
    artifacts: { headCommit: HEAD_40 } as unknown as AttemptRecord['artifacts'],
  });
  return {
    attempts: [reviewAttempt],
    runs: [laneRun(['att-2'])],
    journal: [journalEntry({ key: reviewStepKey(step, seatIndex), mintedId: 'req-1' })],
  };
}

function expectRefused(
  result: RecordSeatObservationResult,
  code: string,
  reasonIncludes?: string,
): void {
  expect(result.outcome).toBe('refused');
  if (result.outcome === 'refused') {
    expect(result.code).toBe(code);
    if (reasonIncludes !== undefined) {
      expect(result.reason).toContain(reasonIncludes);
    }
  }
}

describe('RecordSeatObservationUseCase (attempt subjects)', () => {
  it('records a matching running attempt and cools the seat with a 60-minute policy', async () => {
    const { useCase, store } = harness({ observationCooldownMinutes: 60 });
    const result = await useCase.execute(attemptInput, 'cli');
    expect(result.outcome).toBe('recorded');
    if (result.outcome !== 'recorded') return;
    expect(result.cooling).toBe(true);
    expect(result.observation).toMatchObject({
      version: 1,
      observationId: 'obs-1',
      seatId: 'seat-a',
      outcome: 'rate-limited',
      observedAtIso: NOW,
      subject: { attemptId: 'att-1' },
      via: 'cli',
    });
    expect(await store.listSeatObservations('seat-a')).toHaveLength(1);
  });

  it('records with a 0-minute policy without cooling', async () => {
    const { useCase } = harness({ observationCooldownMinutes: 0 });
    const result = await useCase.execute(attemptInput, 'mcp');
    expect(result).toMatchObject({ outcome: 'recorded', cooling: false });
    if (result.outcome === 'recorded') {
      expect(result.observation.via).toBe('mcp');
    }
  });

  it('refuses a seat the attempt was not committed to', async () => {
    const { useCase } = harness();
    const result = await useCase.execute({ ...attemptInput, seatId: 'seat-b' }, 'cli');
    expectRefused(result, 'seat-mismatch');
  });

  it('refuses an ended attempt, an attempt with an outcome and one with a receipt', async () => {
    for (const overrides of [
      { state: 'ended' as const },
      { state: 'collected' as const },
      { state: 'cancelled' as const },
      { outcome: 'merged' as const },
      {
        completionReceipt: {
          command: 'gate',
          exitCode: 0,
          receiptId: 'r',
          recordedAtIso: NOW,
        } as unknown as AttemptRecord['completionReceipt'],
      },
    ]) {
      const { useCase } = harness({ attempts: [attemptRecord(overrides)] });
      const result = await useCase.execute(attemptInput, 'cli');
      expectRefused(result, 'subject-has-result');
    }
  });

  it('refuses an unknown attempt id', async () => {
    const { useCase } = harness({ attempts: [] });
    const result = await useCase.execute(attemptInput, 'cli');
    expectRefused(result, 'subject-not-found');
  });
});

describe('RecordSeatObservationUseCase (review-request subjects)', () => {
  it('records a brief-check review subject committed to the plan review seat', async () => {
    const { useCase, store } = harness({
      observationCooldownMinutes: 60,
      ...reviewFixture('brief-check'),
    });
    const result = await useCase.execute(reviewInput, 'cli');
    expect(result.outcome).toBe('recorded');
    expect(await store.listSeatObservations()).toHaveLength(1);
  });

  it('records a code-review review subject committed to the plan review seat', async () => {
    const { useCase } = harness(reviewFixture('code-review'));
    const result = await useCase.execute(reviewInput, 'cli');
    expect(result.outcome).toBe('recorded');
  });

  it('records a pre-merge review subject committed to the high-risk chain seat', async () => {
    const { useCase } = harness({
      ...reviewFixture('pre-merge', 1),
      highRiskReviewerSeatIds: ['hr-a', 'hr-b'],
    });
    const result = await useCase.execute(
      { ...reviewInput, seatId: 'hr-b' },
      'cli',
    );
    expect(result.outcome).toBe('recorded');
  });

  it('refuses a pre-merge subject without the high-risk chain wired', async () => {
    const { useCase } = harness(reviewFixture('pre-merge'));
    const result = await useCase.execute({ ...reviewInput, seatId: 'hr-a' }, 'cli');
    expectRefused(result, 'not-wired');
  });

  it('refuses a pre-merge subject bound to another chain seat', async () => {
    const { useCase } = harness({
      ...reviewFixture('pre-merge'),
      highRiskReviewerSeatIds: ['hr-a'],
    });
    const result = await useCase.execute(reviewInput, 'cli');
    expectRefused(result, 'seat-mismatch');
  });

  it('refuses a review subject bound to another plan review seat', async () => {
    const { useCase } = harness(reviewFixture('brief-check'));
    const result = await useCase.execute({ ...reviewInput, seatId: 'rev-b' }, 'cli');
    expectRefused(result, 'seat-mismatch');
  });

  it('refuses a review request id no journal intent minted', async () => {
    const { useCase } = harness({ ...reviewFixture('brief-check') });
    const result = await useCase.execute(
      { ...reviewInput, subject: { reviewRequestId: 'req-other' } },
      'cli',
    );
    expectRefused(result, 'subject-not-found');
  });

  it('refuses review subjects without the lane-run stores wired', async () => {
    const { useCase } = harness();
    const result = await useCase.execute(reviewInput, 'cli');
    expectRefused(result, 'not-wired');
  });

  it('refuses a review whose journal already holds a final result', async () => {
    const fixture = reviewFixture('brief-check');
    const { useCase } = harness({
      ...fixture,
      journal: [
        ...fixture.journal,
        journalEntry({
          kind: 'result',
          key: fixture.journal[0]?.key ?? null,
          outcome: 'completed',
          reasonCode: 'review-passed',
        }),
      ],
    });
    const result = await useCase.execute(reviewInput, 'cli');
    expectRefused(result, 'subject-has-result');
  });

  it('allows an ambiguous result and a review-no-receipt result', async () => {
    for (const resultEntry of [
      { outcome: 'ambiguous' as const, reasonCode: null },
      { outcome: 'completed' as const, reasonCode: 'review-no-receipt' },
    ]) {
      const fixture = reviewFixture('code-review');
      const { useCase } = harness({
        ...fixture,
        journal: [
          ...fixture.journal,
          journalEntry({
            kind: 'result',
            key: fixture.journal[0]?.key ?? null,
            ...resultEntry,
          }),
        ],
      });
      const result = await useCase.execute(reviewInput, 'cli');
      expect(result.outcome).toBe('recorded');
    }
  });

  it('refuses a review whose receipt is already found', async () => {
    const { useCase } = harness({
      ...reviewFixture('brief-check'),
      reviewRequest: {
        findReviewReceipt: async () => ({ outcome: 'found', receipt: {} as never }),
      } as unknown as NonNullable<RecordSeatObservationDependencies['reviewRequest']>,
    });
    const result = await useCase.execute(reviewInput, 'cli');
    expectRefused(result, 'subject-has-result');
  });

  it('refuses with a store error when the receipt read is unavailable or throws', async () => {
    for (const findReviewReceipt of [
      async () => ({ outcome: 'unavailable', reason: 'unreadable' }),
      async () => {
        throw new Error('receipt store failed');
      },
    ]) {
      const { useCase } = harness({
        ...reviewFixture('brief-check'),
        reviewRequest: {
          findReviewReceipt,
        } as unknown as NonNullable<RecordSeatObservationDependencies['reviewRequest']>,
      });
      const result = await useCase.execute(reviewInput, 'cli');
      expectRefused(result, 'store-error');
    }
  });
});

describe('RecordSeatObservationUseCase (dry run, windows and duplicates)', () => {
  it('a dry run validates and writes nothing', async () => {
    const { useCase, store } = harness({ observationCooldownMinutes: 60 });
    const result = await useCase.execute(attemptInput, 'cli', { dryRun: true });
    expect(result).toEqual({
      outcome: 'dry-run',
      observation: {
        version: 1,
        observationId: 'obs-1',
        seatId: 'seat-a',
        outcome: 'rate-limited',
        observedAtIso: NOW,
        subject: { attemptId: 'att-1' },
        via: 'cli',
      },
      wouldCool: true,
      duplicate: false,
    });
    expect(await store.listSeatObservations()).toHaveLength(0);
  });

  it('a second observation inside the window is stored and answers a duplicate', async () => {
    const { useCase, store } = harness({ observationCooldownMinutes: 60 });
    const first = await useCase.execute(
      { ...attemptInput, observationId: 'obs-1' },
      'cli',
    );
    expect(first.outcome).toBe('recorded');
    const second = await useCase.execute(
      { ...attemptInput, observationId: 'obs-2', observedAtIso: LATER },
      'cli',
    );
    expect(second).toMatchObject({
      outcome: 'duplicate',
      cooling: false,
      reason: 'window-already-cooling',
    });
    if (second.outcome === 'duplicate') {
      expect(second.observation.observationId).toBe('obs-2');
    }
    expect(await store.listSeatObservations('seat-a')).toHaveLength(2);
  });

  it('a repeat observation id is a duplicate that writes nothing new', async () => {
    const { useCase, store } = harness({ observationCooldownMinutes: 0 });
    await useCase.execute({ ...attemptInput, observationId: 'obs-1' }, 'cli');
    const repeat = await useCase.execute({ ...attemptInput, observationId: 'obs-1' }, 'cli');
    expect(repeat).toMatchObject({
      outcome: 'duplicate',
      cooling: false,
      reason: 'duplicate-observation-id',
    });
    if (repeat.outcome === 'duplicate') {
      expect(repeat.observation.observationId).toBe('obs-1');
    }
    expect(await store.listSeatObservations('seat-a')).toHaveLength(1);
  });
});

describe('RecordSeatObservationUseCase (hostile input and failures)', () => {
  it('rejects null, a Proxy, a throwing getter, .., an unknown outcome and bad subjects', async () => {
    const { useCase } = harness();
    for (const [name, input] of [
      ['null', null],
      ['proxy', new Proxy({}, {})],
      ['throwing-getter', { get seatId(): string { throw new Error('no'); } }],
      ['dotdot-seat', { ...attemptInput, seatId: '..' }],
      ['unknown-outcome', { ...attemptInput, outcome: 'exploded' }],
      ['empty-subject', { ...attemptInput, subject: {} }],
      ['both-subjects', { ...attemptInput, subject: { attemptId: 'att-1', reviewRequestId: 'req-1' } }],
      ['neither-subject', { seatId: 'seat-a', outcome: 'rate-limited' }],
      ['extra-key', { ...attemptInput, seatPlan: SEAT_PLAN }],
    ] as const) {
      const result = await useCase.execute(input, 'cli');
      expectRefused(result, 'invalid-input');
      expect(name).toBeTruthy();
    }
  });

  it('rejects an unusable via', async () => {
    const { useCase } = harness();
    const result = await useCase.execute(attemptInput, 'web' as 'cli');
    expectRefused(result, 'invalid-input');
  });

  it('answers clock-error when the clock throws or returns a non-ISO time', async () => {
    for (const nowIso of [
      () => {
        throw new Error('clock failed');
      },
      () => 'not-a-time',
    ]) {
      const { useCase } = harness({ nowIso });
      const result = await useCase.execute(attemptInput, 'cli');
      expectRefused(result, 'clock-error');
    }
  });

  it('answers store-error when any store read or write throws', async () => {
    const attemptsThrow = harness({ attemptsThrow: true });
    expectRefused(await attemptsThrow.useCase.execute(attemptInput, 'cli'), 'store-error');

    const observationsThrow = harness({ observationsThrow: true });
    expectRefused(await observationsThrow.useCase.execute(attemptInput, 'cli'), 'store-error');

    const appendThrows = harness({ appendThrows: true });
    expectRefused(await appendThrows.useCase.execute(attemptInput, 'cli'), 'store-error');

    const runsThrow = harness({ ...reviewFixture('brief-check'), runsThrow: true });
    expectRefused(await runsThrow.useCase.execute(reviewInput, 'cli'), 'store-error');

    const journalThrow = harness({ ...reviewFixture('brief-check'), journalThrow: true });
    expectRefused(await journalThrow.useCase.execute(reviewInput, 'cli'), 'store-error');
  });
});
