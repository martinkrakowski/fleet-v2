// Lane DT-V2 tests: JevMergeVetoAdapter over the shared decision client. No
// real network: fetch is always a spy or a stub replaying a recorded choice
// payload; key reader, clock and hasher are injected; the decision journal is
// in-memory and records every reservation and settlement.
import { describe, expect, it, vi } from 'vitest';
import {
  JevMergeVetoAdapter,
  MERGE_VETO_CONSUMER,
} from '../JevMergeVetoAdapter.adapter.js';
import type {
  MergeVetoDecisionJournal,
  MergeVetoReserveQuery,
  MergeVetoReserveResult,
  MergeVetoSettledReceipt,
} from '../JevMergeVetoAdapter.adapter.js';
import type {
  MergeVetoRequest,
  MergeVetoUnknownReason,
} from '../../../application/ports/out/MergeVetoPort.out-port.js';

const KEY_TEXT = 'sk-test-key-not-real';
const NOW_MS = 1_800_000_000_000;
const FAR_FUTURE_ISO = new Date(NOW_MS + 3_600_000).toISOString();

/**
 * Synthetic recorded choice payload in the wire shape of the owner-recorded
 * shared fixture (`packages/shared/src/__tests__/fixtures/jev/jev-choice-response.json`):
 * that fixture carries `answers.k0/k1/k2` over lesson/policy_proposal/
 * instruction/status_noise and no `answers.merge`, so the merge answer here is
 * a remapped, labelled synthetic merge answer in that same wire shape
 * (`answers.merge` with `type: 'choice'`, `choice`, `probabilities` keyed by
 * both criteria, `confidence`, `usage.cost`, `id`, `model`).
 */
const RECORDED_CHOICE_PAYLOAD = {
  model: 'typesafe/jev-1.14-20261014',
  answers: {
    merge: {
      type: 'choice',
      choice: 'merge-safe',
      probabilities: { 'merge-safe': 0.99, 'hold-for-human': 0.01 },
      confidence: 0.99,
    },
  },
  usage: { input_tokens: 628, output_tokens: 142, cost: 0.000026376 },
  id: 'gen-fixture-merge-veto',
  provider: 'TypeSafe',
};

const REQUEST: MergeVetoRequest = {
  repository: { owner: 'acme', repo: 'widgets' },
  pullRequestNumber: 42,
  verifiedHeadOid: '0123456789abcdef0123456789abcdef01234567',
  mode: 'shadow',
  state: {
    tier: '2',
    title: 'Fix date parsing',
    changedPaths: ['src/utils/date.ts'],
    additions: 12,
    deletions: 4,
    hardToUndo: 'None',
    fixRounds: 1,
    reviewerFamilies: ['grok', 'luna'],
    replyResolvedThreads: 1,
    majorBlockerFindings: 0,
    headChangedAfterReview: false,
  },
  deadlineIso: FAR_FUTURE_ISO,
};

function makeResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Fetch spy replaying recorded bodies and recording every call in `events`. */
function fetchAnswering(bodies: readonly unknown[], events: string[]): typeof fetch {
  let index = 0;
  return (async (_url: unknown, _init?: RequestInit) => {
    events.push('fetch');
    const body = bodies[Math.min(index, bodies.length - 1)];
    index += 1;
    return makeResponse(body);
  }) as typeof fetch;
}

/** In-memory journal recording every reservation and settlement. */
class InMemoryJournal implements MergeVetoDecisionJournal {
  readonly reserves: Array<MergeVetoReserveQuery & { reservationId: string }> = [];
  readonly settles: Array<{ reservationId: string; receipt: MergeVetoSettledReceipt }> = [];
  reserveResult: 'ok' | 'budget' | 'not-configured' = 'ok';
  settleResult = true;

  constructor(private readonly events?: string[]) {}

  async reserve(query: MergeVetoReserveQuery): Promise<MergeVetoReserveResult> {
    this.events?.push('reserve');
    if (this.reserveResult !== 'ok') {
      return { ok: false, reason: this.reserveResult };
    }
    const reservationId = `res-${this.reserves.length + 1}`;
    this.reserves.push({ ...query, reservationId });
    return { ok: true, reservationId };
  }

  async settle(reservationId: string, receipt: MergeVetoSettledReceipt): Promise<boolean> {
    this.events?.push('settle');
    this.settles.push({ reservationId, receipt });
    return this.settleResult;
  }
}

function makeAdapter(overrides?: {
  fetch?: typeof fetch;
  journal?: InMemoryJournal;
  disabledProjects?: readonly string[];
  holdConfidence?: number;
  monthlyBudgetUsd?: number;
  assumedCostPerCallUsd?: number;
  timeoutMs?: number;
  now?: () => number;
  hash?: (state: string) => string;
  readKey?: (path: string) => Promise<string>;
}): {
  adapter: JevMergeVetoAdapter;
  journal: InMemoryJournal;
  events: string[];
} {
  const events: string[] = [];
  const journal = overrides?.journal ?? new InMemoryJournal(events);
  const adapter = new JevMergeVetoAdapter({
    model: 'typesafe/jev-1.14',
    keyFile: '/keys/jev.key',
    holdConfidence: overrides?.holdConfidence ?? 0.8,
    monthlyBudgetUsd: overrides?.monthlyBudgetUsd ?? 100,
    assumedCostPerCallUsd: overrides?.assumedCostPerCallUsd ?? 0.0001,
    disabledProjects: overrides?.disabledProjects,
    fetch: overrides?.fetch ?? fetchAnswering([RECORDED_CHOICE_PAYLOAD], events),
    readKey: overrides?.readKey ?? (async () => KEY_TEXT),
    journal,
    timeoutMs: overrides?.timeoutMs,
    now: overrides?.now ?? (() => NOW_MS),
    hash: overrides?.hash ?? ((state: string) => `sha256:${state.length}`),
  });
  return { adapter, journal, events };
}

describe('JevMergeVetoAdapter', () => {
  it('answers merge-safe on a recorded choice payload in both modes, writing only to the journal', async () => {
    for (const mode of ['shadow', 'live'] as const) {
      const spies = [
        vi.spyOn(console, 'log').mockImplementation(() => {}),
        vi.spyOn(console, 'warn').mockImplementation(() => {}),
        vi.spyOn(console, 'error').mockImplementation(() => {}),
      ];
      try {
        const { adapter, journal, events } = makeAdapter();
        const result = await adapter.adviseMergeVeto({ ...REQUEST, mode });
        expect(result).toEqual({
          status: 'answered',
          choice: 'merge-safe',
          confidence: 0.99,
          decisionReceiptId: 'gen-fixture-merge-veto',
          mode,
        });
        // Reservation before the fetch, settlement after; nothing else happens.
        expect(events).toEqual(['reserve', 'fetch', 'settle']);
        expect(journal.reserves).toHaveLength(1);
        expect(journal.settles).toHaveLength(1);
        const receipt = journal.settles[0].receipt;
        expect(receipt.consumer).toBe(MERGE_VETO_CONSUMER);
        expect(receipt.contextRef).toBe('merge-veto:acme/widgets#42@0123456789ab');
        expect(receipt.provider).toBe('jev');
        expect(receipt.model).toBe('typesafe/jev-1.14-20261014');
        expect(receipt.requestId).toBe('gen-fixture-merge-veto');
        expect(receipt.costUsd).toBeCloseTo(0.000026376, 12);
        expect(receipt.questionKinds).toEqual(['choice']);
        expect(receipt.minConfidenceObserved).toBe(0.99);
        expect(receipt.unknownReason).toBeUndefined();
        for (const spy of spies) {
          expect(spy).not.toHaveBeenCalled();
        }
      } finally {
        for (const spy of spies) {
          spy.mockRestore();
        }
      }
    }
  });

  it('refuses a secret-shaped or over-cap field with zero fetches and zero journal entries', async () => {
    const secretTitle = 'rotate the token sk-abcdefghijklmnopqrstuvwx today';
    const overCapTitle = 'x'.repeat(8 * 1024 + 1);
    for (const title of [secretTitle, overCapTitle]) {
      const { adapter, journal, events } = makeAdapter();
      const result = await adapter.adviseMergeVeto({
        ...REQUEST,
        state: { ...REQUEST.state, title },
      });
      expect(result).toEqual({ status: 'unknown', reason: 'redaction-refused' });
      expect(events).toEqual([]);
      expect(journal.reserves).toHaveLength(0);
      expect(journal.settles).toHaveLength(0);
    }
  });

  it('enforces the monthly budget through the journal and never uses an unrecorded answer', async () => {
    // At the monthly cap the journal refuses the reservation: budget, no fetch.
    const atCap = new InMemoryJournal();
    atCap.reserveResult = 'budget';
    const atCapCalls: string[] = [];
    const atCapAdapter = makeAdapter({
      journal: atCap,
      fetch: fetchAnswering([RECORDED_CHOICE_PAYLOAD], atCapCalls),
    });
    const atCapResult = await atCapAdapter.adapter.adviseMergeVeto(REQUEST);
    expect(atCapResult).toEqual({ status: 'unknown', reason: 'budget' });
    expect(atCapCalls).toEqual([]);
    expect(atCap.settles).toHaveLength(0);

    // Below the cap: the reserved entry is appended before the fetch and the
    // settled entry after.
    const belowCap = makeAdapter();
    const belowCapResult = await belowCap.adapter.adviseMergeVeto(REQUEST);
    expect(belowCapResult.status).toBe('answered');
    expect(belowCap.events).toEqual(['reserve', 'fetch', 'settle']);
    expect(belowCap.journal.reserves).toHaveLength(1);
    expect(belowCap.journal.settles).toHaveLength(1);

    // A settled append returning false turns an otherwise valid answer into
    // not-configured with the reservation still recorded.
    const failingSettle = new InMemoryJournal();
    failingSettle.settleResult = false;
    const failing = makeAdapter({ journal: failingSettle });
    const failingResult = await failing.adapter.adviseMergeVeto(REQUEST);
    expect(failingResult).toEqual({ status: 'unknown', reason: 'not-configured' });
    expect(failingSettle.reserves).toHaveLength(1);
    expect(failingSettle.settles).toHaveLength(1);
  });

  it('maps every transport and validation failure to unknown and never throws', async () => {
    const cases: Array<{
      name: string;
      fetch: typeof fetch;
      reason: MergeVetoUnknownReason;
    }> = [
      {
        name: 'rejecting fetch',
        fetch: (async () => {
          throw new Error('connection refused');
        }) as typeof fetch,
        reason: 'transport',
      },
      {
        name: 'non-2xx status',
        fetch: (async () => makeResponse('{"error":"secret details"}', 500)) as typeof fetch,
        reason: 'transport',
      },
      {
        name: 'oversized body',
        fetch: (async () => makeResponse('"' + 'y'.repeat(64 * 1024 + 1) + '"')) as typeof fetch,
        reason: 'shape',
      },
      {
        name: 'unparsable body',
        fetch: (async () => makeResponse('<html>bad</html>')) as typeof fetch,
        reason: 'shape',
      },
    ];
    for (const item of cases) {
      const { adapter } = makeAdapter({ fetch: item.fetch });
      const result = await adapter.adviseMergeVeto(REQUEST);
      expect(result).toEqual({ status: 'unknown', reason: item.reason });
      expect(JSON.stringify(result)).not.toContain('secret');
    }

    // Malformed answers → shape.
    const malformed = makeAdapter({
      fetch: (async () =>
        makeResponse({
          model: 'typesafe/jev-1.14-20261014',
          answers: { merge: { type: 'choice' } },
          usage: { cost: 0.001 },
          id: 'r1',
        })) as typeof fetch,
    });
    expect(await malformed.adapter.adviseMergeVeto(REQUEST)).toEqual({
      status: 'unknown',
      reason: 'shape',
    });

    // Confidence below holdConfidence → low-confidence.
    const lowConfidence = JSON.parse(
      JSON.stringify(RECORDED_CHOICE_PAYLOAD),
    ) as { answers: Record<string, { confidence: number }> };
    lowConfidence.answers.merge.confidence = 0.4;
    const low = makeAdapter({
      fetch: (async () => makeResponse(lowConfidence)) as typeof fetch,
    });
    expect(await low.adapter.adviseMergeVeto(REQUEST)).toEqual({
      status: 'unknown',
      reason: 'low-confidence',
    });

    // A synchronously-throwing fetch still returns, never throws.
    const syncThrow: typeof fetch = (() => {
      throw new Error('synchronous');
    }) as typeof fetch;
    const sync = makeAdapter({ fetch: syncThrow });
    const syncResult = await sync.adapter.adviseMergeVeto(REQUEST);
    expect(syncResult).toEqual({ status: 'unknown', reason: 'transport' });
  });

  it('returns the payload id as decisionReceiptId and omits it when unusable', async () => {
    const { adapter } = makeAdapter();
    const answered = await adapter.adviseMergeVeto(REQUEST);
    expect(answered.status).toBe('answered');
    if (answered.status === 'answered') {
      expect(answered.decisionReceiptId).toBe('gen-fixture-merge-veto');
    }

    const noId = JSON.parse(
      JSON.stringify(RECORDED_CHOICE_PAYLOAD),
    ) as Record<string, unknown>;
    delete noId.id;
    const noIdAdapter = makeAdapter({
      fetch: (async () => makeResponse(noId)) as typeof fetch,
    });
    const noIdResult = await noIdAdapter.adapter.adviseMergeVeto(REQUEST);
    expect(noIdResult).toEqual({
      status: 'answered',
      choice: 'merge-safe',
      confidence: 0.99,
      mode: 'shadow',
    });
  });

  it('answers deadline when expired, keeps the reservation counted when it expires after reserve, and bounds the injected timeout', async () => {
    // Expired or unparsable deadline: no fetch, no reservation.
    for (const deadlineIso of [new Date(NOW_MS).toISOString(), 'not-a-date']) {
      const { adapter, journal, events } = makeAdapter();
      const result = await adapter.adviseMergeVeto({ ...REQUEST, deadlineIso });
      expect(result).toEqual({ status: 'unknown', reason: 'deadline' });
      expect(events).toEqual([]);
      expect(journal.reserves).toHaveLength(0);
    }

    // The deadline passes at first and expires after the reservation: the
    // reservation stays counted — settled as estimated with the deadline reason.
    let clockCalls = 0;
    const advancingNow = () => {
      clockCalls += 1;
      return clockCalls === 1 ? NOW_MS : NOW_MS + 3_600_000;
    };
    const postReserve = makeAdapter({ now: advancingNow });
    const postReserveResult = await postReserve.adapter.adviseMergeVeto(REQUEST);
    expect(postReserveResult).toEqual({ status: 'unknown', reason: 'deadline' });
    expect(postReserve.events).toEqual(['reserve', 'settle']);
    expect(postReserve.journal.reserves).toHaveLength(1);
    expect(postReserve.journal.settles).toHaveLength(1);
    expect(postReserve.journal.settles[0].receipt.unknownReason).toBe('deadline');

    // A fresh future deadline bounds the injected timeout to the remaining ms:
    // with a 10 s adapter timeout and 200 ms left, the call must abort by the
    // remaining 200 ms, never at 10 s.
    vi.useFakeTimers();
    try {
      const base = Date.now();
      const deadlineIso = new Date(base + 200).toISOString();
      let abortedAt = -1;
      const hangingFetch: typeof fetch = (async (_url, init) => {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            abortedAt = Date.now() - base;
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        });
      }) as typeof fetch;
      const bounded = makeAdapter({
        fetch: hangingFetch,
        timeoutMs: 10000,
        now: () => Date.now(),
      });
      const pending = bounded.adapter.adviseMergeVeto({ ...REQUEST, deadlineIso });
      await vi.advanceTimersByTimeAsync(150);
      expect(abortedAt).toBe(-1);
      await vi.advanceTimersByTimeAsync(60);
      expect(abortedAt).toBeGreaterThanOrEqual(150);
      expect(abortedAt).toBeLessThanOrEqual(210);
      expect(await pending).toEqual({ status: 'unknown', reason: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });
});
