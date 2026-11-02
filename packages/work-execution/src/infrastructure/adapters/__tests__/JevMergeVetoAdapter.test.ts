// Tests for JevMergeVetoAdapter (finding fix: reject negative configured costs, treat negative reported costs as unusable).
import { describe, expect, it } from 'vitest';
import {
  JevMergeVetoAdapter,
  type JevMergeVetoAdapterDependencies,
  type MergeVetoDecisionJournal,
  type MergeVetoReserveQuery,
  type MergeVetoReserveResult,
  type MergeVetoSettledReceipt,
} from '../JevMergeVetoAdapter.adapter.js';
import type { MergeVetoRequest } from '../../../application/ports/out/MergeVetoPort.out-port.js';

class MockJournal implements MergeVetoDecisionJournal {
  readonly reservations: MergeVetoReserveQuery[] = [];
  readonly settlements: { reservationId: string; receipt: MergeVetoSettledReceipt }[] = [];

  async reserve(query: MergeVetoReserveQuery): Promise<MergeVetoReserveResult> {
    this.reservations.push(query);
    return { ok: true, reservationId: 'res-test-1' };
  }

  async settle(reservationId: string, receipt: MergeVetoSettledReceipt): Promise<boolean> {
    this.settlements.push({ reservationId, receipt });
    return true;
  }
}

const SAMPLE_REQUEST: MergeVetoRequest = {
  repository: { owner: 'fleet', repo: 'v2' },
  pullRequestNumber: 101,
  verifiedHeadOid: 'abcdef0123456789abcdef0123456789abcdef01',
  mode: 'live',
  deadlineIso: '2026-11-02T12:00:00.000Z',
  state: {
    tier: 'tier-1',
    title: 'Update pipeline configuration',
    changedPaths: ['packages/config/src/index.ts'],
    additions: 12,
    deletions: 3,
    hardToUndo: 'none',
    fixRounds: 0,
    reviewerFamilies: ['anthropic'],
    replyResolvedThreads: 1,
    majorBlockerFindings: 0,
    headChangedAfterReview: false,
  },
};

function createSuccessfulResponse(cost?: number, confidence = 0.95): Response {
  const body = {
    id: 'req-test-1',
    model: 'typesafe/jev-1.14',
    usage: cost !== undefined ? { cost } : {},
    answers: {
      merge: {
        type: 'choice',
        choice: 'merge-safe',
        confidence,
        probabilities: {
          'merge-safe': confidence,
          'hold-for-human': Math.round((1 - confidence) * 100) / 100,
        },
      },
    },
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makeDeps(
  journal: MergeVetoDecisionJournal,
  fetchFn: typeof fetch,
  overrides: Partial<JevMergeVetoAdapterDependencies> = {},
): JevMergeVetoAdapterDependencies {
  return {
    model: 'typesafe/jev-1.14',
    holdConfidence: 0.8,
    monthlyBudgetUsd: 100,
    assumedCostPerCallUsd: 0.02,
    fetch: fetchFn,
    readKey: async () => 'test-auth-key',
    journal,
    now: () => 1730000000000,
    hash: () => '0'.repeat(64),
    ...overrides,
  };
}

describe('JevMergeVetoAdapter constructor monetary validation', () => {
  const journal = new MockJournal();
  const dummyFetch = (async () => new Response()) as typeof fetch;

  it('rejects negative assumedCostPerCallUsd', () => {
    expect(
      () =>
        new JevMergeVetoAdapter(
          makeDeps(journal, dummyFetch, { assumedCostPerCallUsd: -1 }),
        ),
    ).toThrow(/assumedCostPerCallUsd/);

    expect(
      () =>
        new JevMergeVetoAdapter(
          makeDeps(journal, dummyFetch, { assumedCostPerCallUsd: -0.01 }),
        ),
    ).toThrow(/assumedCostPerCallUsd/);
  });

  it('rejects negative monthlyBudgetUsd', () => {
    expect(
      () =>
        new JevMergeVetoAdapter(
          makeDeps(journal, dummyFetch, { monthlyBudgetUsd: -1 }),
        ),
    ).toThrow(/monthlyBudgetUsd/);

    expect(
      () =>
        new JevMergeVetoAdapter(
          makeDeps(journal, dummyFetch, { monthlyBudgetUsd: -50 }),
        ),
    ).toThrow(/monthlyBudgetUsd/);
  });

  it('rejects non-finite assumedCostPerCallUsd and monthlyBudgetUsd', () => {
    expect(
      () =>
        new JevMergeVetoAdapter(
          makeDeps(journal, dummyFetch, { assumedCostPerCallUsd: NaN }),
        ),
    ).toThrow(/assumedCostPerCallUsd/);

    expect(
      () =>
        new JevMergeVetoAdapter(
          makeDeps(journal, dummyFetch, { monthlyBudgetUsd: Infinity }),
        ),
    ).toThrow(/monthlyBudgetUsd/);
  });

  it('accepts zero and positive monetary values', () => {
    expect(
      () =>
        new JevMergeVetoAdapter(
          makeDeps(journal, dummyFetch, {
            assumedCostPerCallUsd: 0,
            monthlyBudgetUsd: 0,
          }),
        ),
    ).not.toThrow();

    expect(
      () =>
        new JevMergeVetoAdapter(
          makeDeps(journal, dummyFetch, {
            assumedCostPerCallUsd: 0.05,
            monthlyBudgetUsd: 250,
          }),
        ),
    ).not.toThrow();
  });
});

describe('JevMergeVetoAdapter reported cost settlement', () => {
  it('treats negative reported cost as unusable and settles with assumed cost marked estimated', async () => {
    const journal = new MockJournal();
    const fakeFetch = (async () => createSuccessfulResponse(-1)) as typeof fetch;
    const adapter = new JevMergeVetoAdapter(
      makeDeps(journal, fakeFetch, { assumedCostPerCallUsd: 0.02 }),
    );

    const advice = await adapter.adviseMergeVeto(SAMPLE_REQUEST);
    expect(advice.status).toBe('answered');

    expect(journal.settlements.length).toBe(1);
    const receipt = journal.settlements[0].receipt;
    expect(receipt.costUsd).toBe(0.02);
    expect(receipt.estimated).toBe(true);
  });

  it('settles positive reported cost as usable and not estimated', async () => {
    const journal = new MockJournal();
    const fakeFetch = (async () => createSuccessfulResponse(0.045)) as typeof fetch;
    const adapter = new JevMergeVetoAdapter(
      makeDeps(journal, fakeFetch, { assumedCostPerCallUsd: 0.02 }),
    );

    const advice = await adapter.adviseMergeVeto(SAMPLE_REQUEST);
    expect(advice.status).toBe('answered');

    expect(journal.settlements.length).toBe(1);
    const receipt = journal.settlements[0].receipt;
    expect(receipt.costUsd).toBe(0.045);
    expect(receipt.estimated).toBe(false);
  });

  it('settles zero reported cost as usable and not estimated', async () => {
    const journal = new MockJournal();
    const fakeFetch = (async () => createSuccessfulResponse(0)) as typeof fetch;
    const adapter = new JevMergeVetoAdapter(
      makeDeps(journal, fakeFetch, { assumedCostPerCallUsd: 0.02 }),
    );

    const advice = await adapter.adviseMergeVeto(SAMPLE_REQUEST);
    expect(advice.status).toBe('answered');

    expect(journal.settlements.length).toBe(1);
    const receipt = journal.settlements[0].receipt;
    expect(receipt.costUsd).toBe(0);
    expect(receipt.estimated).toBe(false);
  });

  it('treats absent reported cost as unusable and settles with assumed cost marked estimated', async () => {
    const journal = new MockJournal();
    const fakeFetch = (async () => createSuccessfulResponse(undefined)) as typeof fetch;
    const adapter = new JevMergeVetoAdapter(
      makeDeps(journal, fakeFetch, { assumedCostPerCallUsd: 0.02 }),
    );

    const advice = await adapter.adviseMergeVeto(SAMPLE_REQUEST);
    expect(advice.status).toBe('answered');

    expect(journal.settlements.length).toBe(1);
    const receipt = journal.settlements[0].receipt;
    expect(receipt.costUsd).toBe(0.02);
    expect(receipt.estimated).toBe(true);
  });

  it('treats negative reported cost as unusable on validation failure (low confidence)', async () => {
    const journal = new MockJournal();
    // Confidence 0.7 is below holdConfidence 0.8 -> validation fails with low-confidence
    const fakeFetch = (async () => createSuccessfulResponse(-1, 0.7)) as typeof fetch;
    const adapter = new JevMergeVetoAdapter(
      makeDeps(journal, fakeFetch, { assumedCostPerCallUsd: 0.02, holdConfidence: 0.8 }),
    );

    const advice = await adapter.adviseMergeVeto(SAMPLE_REQUEST);
    expect(advice.status).toBe('unknown');
    if (advice.status === 'unknown') {
      expect(advice.reason).toBe('low-confidence');
    }

    expect(journal.settlements.length).toBe(1);
    const receipt = journal.settlements[0].receipt;
    expect(receipt.costUsd).toBe(0.02);
    expect(receipt.estimated).toBe(true);
    expect(receipt.unknownReason).toBe('low-confidence');
  });

  it('passes configured assumedCostUsd and monthlyBudgetUsd to journal reservation', async () => {
    const journal = new MockJournal();
    const fakeFetch = (async () => createSuccessfulResponse(0.01)) as typeof fetch;
    const adapter = new JevMergeVetoAdapter(
      makeDeps(journal, fakeFetch, {
        assumedCostPerCallUsd: 0.03,
        monthlyBudgetUsd: 75,
      }),
    );

    await adapter.adviseMergeVeto(SAMPLE_REQUEST);

    expect(journal.reservations.length).toBe(1);
    expect(journal.reservations[0].assumedCostUsd).toBe(0.03);
    expect(journal.reservations[0].monthlyBudgetUsd).toBe(75);
  });
});

describe('JevMergeVetoAdapter key reader injection', () => {
  const journal = new MockJournal();
  const fakeFetch = (async () => createSuccessfulResponse(0.02)) as typeof fetch;

  it('answers not-configured when readKey is missing', async () => {
    const adapter = new JevMergeVetoAdapter(
      makeDeps(journal, fakeFetch, { readKey: undefined }),
    );

    const advice = await adapter.adviseMergeVeto(SAMPLE_REQUEST);
    expect(advice.status).toBe('unknown');
    if (advice.status === 'unknown') {
      expect(advice.reason).toBe('not-configured');
    }
  });

  it('answers not-configured when readKey throws, echoing no error', async () => {
    const adapter = new JevMergeVetoAdapter(
      makeDeps(journal, fakeFetch, {
        readKey: async () => {
          throw new Error('secret-key-file-path-failed');
        },
      }),
    );

    const advice = await adapter.adviseMergeVeto(SAMPLE_REQUEST);
    expect(advice.status).toBe('unknown');
    if (advice.status === 'unknown') {
      expect(advice.reason).toBe('not-configured');
    }
  });

  it('answers not-configured when readKey returns undefined', async () => {
    const adapter = new JevMergeVetoAdapter(
      makeDeps(journal, fakeFetch, {
        readKey: async () => undefined,
      }),
    );

    const advice = await adapter.adviseMergeVeto(SAMPLE_REQUEST);
    expect(advice.status).toBe('unknown');
    if (advice.status === 'unknown') {
      expect(advice.reason).toBe('not-configured');
    }
  });

  it('answers not-configured when readKey returns empty or whitespace string', async () => {
    const adapter = new JevMergeVetoAdapter(
      makeDeps(journal, fakeFetch, {
        readKey: async () => '   ',
      }),
    );

    const advice = await adapter.adviseMergeVeto(SAMPLE_REQUEST);
    expect(advice.status).toBe('unknown');
    if (advice.status === 'unknown') {
      expect(advice.reason).toBe('not-configured');
    }
  });

  it('preserves redaction-before-key-read order when state fails redaction', async () => {
    let keyReadInvoked = false;
    const adapter = new JevMergeVetoAdapter(
      makeDeps(journal, fakeFetch, {
        readKey: async () => {
          keyReadInvoked = true;
          return 'test-auth-key';
        },
      }),
    );

    const secretRequest: MergeVetoRequest = {
      ...SAMPLE_REQUEST,
      state: {
        ...SAMPLE_REQUEST.state,
        title: 'AKIAIOSFODNN7EXAMPLE',
      },
    };

    const advice = await adapter.adviseMergeVeto(secretRequest);
    expect(advice.status).toBe('unknown');
    if (advice.status === 'unknown') {
      expect(advice.reason).toBe('redaction-refused');
    }
    expect(keyReadInvoked).toBe(false);
  });

  it('finishes through finishDeadlineAfterReserve when key reading and reservation deplete remaining budget', async () => {
    const testJournal = new MockJournal();
    let fetchInvoked = false;
    const testFetch = (async () => {
      fetchInvoked = true;
      return createSuccessfulResponse(0.02);
    }) as typeof fetch;

    let time = 1000;
    const deadlineMs = 2000;
    const adapter = new JevMergeVetoAdapter(
      makeDeps(testJournal, testFetch, {
        now: () => time,
        readKey: async () => {
          time = 2000;
          return 'test-auth-key';
        },
      }),
    );

    const request: MergeVetoRequest = {
      ...SAMPLE_REQUEST,
      deadlineIso: new Date(deadlineMs).toISOString(),
    };

    const advice = await adapter.adviseMergeVeto(request);
    expect(advice.status).toBe('unknown');
    if (advice.status === 'unknown') {
      expect(advice.reason).toBe('deadline');
    }
    expect(fetchInvoked).toBe(false);
    expect(testJournal.reservations.length).toBe(1);
    expect(testJournal.settlements.length).toBe(1);
    expect(testJournal.settlements[0].receipt.unknownReason).toBe('deadline');
  });
});
