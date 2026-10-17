// Lane K4 tests: the pure trial-figure computation (decision-kernel plan
// §4) over a fixed journal fixture. The function invents nothing: a figure
// the persisted lines cannot carry reads as `null` or the not-persisted
// sentinel, never as a fabricated number.
import { describe, expect, it } from 'vitest';

import {
  FIGURE_NOT_PERSISTED,
  computeRankingTrialFigures,
  type DecisionJournalSnapshot,
  type SettledDecisionReceiptRecord,
} from './DecisionReceiptJournalPort.out-port.js';

const REF_REORDERED = 'ranking:lane-k4:' + 'a'.repeat(64);
const REF_STABLE = 'ranking:lane-k4:' + 'b'.repeat(64);
const REF_PRE_K2 = 'ranking:lane-k4:' + 'c'.repeat(64);

function receipt(overrides: Partial<SettledDecisionReceiptRecord> & { contextRef: string }): SettledDecisionReceiptRecord {
  return {
    consumer: 'knowledge-ranking',
    provider: 'jev',
    model: 'typesafe/jev-1.14',
    costUsd: 0.00002,
    estimated: false,
    questionKinds: ['score'],
    lexicalOrder: [],
    decidedOrder: [],
    at: '2026-10-17T10:00:00.000Z',
    ...overrides,
  };
}

const SNAPSHOT: DecisionJournalSnapshot = {
  receipts: [
    // Reordered call: lexical [a,b,c], decided [c,a,b].
    receipt({
      contextRef: REF_REORDERED,
      lexicalOrder: ['ke-a', 'ke-b', 'ke-c'],
      decidedOrder: ['ke-c', 'ke-a', 'ke-b'],
      minConfidenceObserved: 0.9,
      latencyMs: 200,
    }),
    // Unknown call under the same reference: unknown reason and lower
    // confidence, with the identical order (unknown keeps the lexical order).
    receipt({
      contextRef: REF_REORDERED,
      lexicalOrder: ['ke-a', 'ke-b', 'ke-c'],
      decidedOrder: ['ke-a', 'ke-b', 'ke-c'],
      minConfidenceObserved: 0.4,
      latencyMs: 400,
      unknownReason: 'low-confidence',
      estimated: true,
      costUsd: 0.00003,
    }),
    // Stable call under a second reference: no reorder at all.
    receipt({
      contextRef: REF_STABLE,
      lexicalOrder: ['ke-a', 'ke-b'],
      decidedOrder: ['ke-a', 'ke-b'],
      minConfidenceObserved: 0.8,
      latencyMs: 100,
    }),
    // A pre-K2 line carries no latency measurement at all.
    receipt({
      contextRef: REF_PRE_K2,
      lexicalOrder: ['ke-a'],
      decidedOrder: ['ke-a'],
      costUsd: 0.00002,
    }),
  ],
  outcomes: [
    {
      consumer: 'knowledge-ranking',
      contextRef: REF_REORDERED,
      kind: 'ranking-selection',
      // The orchestrator picked [b, a]: closer to the lexical order's shared
      // pair than to the decided order's (both taus read -1 here, so the
      // agreement figures are computable and lexical is not strictly better).
      value: ['ke-b', 'ke-a'],
      at: '2026-10-17T10:05:00.000Z',
    },
  ],
};

describe('computeRankingTrialFigures', () => {
  it('computes the per-contextRef trial figures from the fixed fixture', () => {
    const figures = computeRankingTrialFigures(SNAPSHOT);

    // First-appearance order, one record per contextRef.
    expect(figures.map((figure) => figure.contextRef)).toEqual([
      REF_REORDERED,
      REF_STABLE,
      REF_PRE_K2,
    ]);

    const reordered = figures[0];
    expect(reordered.calls).toBe(2);
    expect(reordered.orderChanged).toBe(true);
    expect(reordered.top1Changed).toBe(true);
    // The order-derived figures read the latest call, whose decided order
    // equals its lexical order (unknown keeps the lexical order): tau 1.
    expect(reordered.kendallTau).toBe(1);
    expect(reordered.unknownRateByReason).toEqual({ 'low-confidence': 0.5 });
    expect(reordered.lowestConfidence).toBe(0.4);
    // Nearest-rank percentiles over sorted [200, 400], rank = ceil(p·N/100):
    // p50 → ceil(1) = 1 → 200; p95 → ceil(1.9) = 2 → 400.
    expect(reordered.latencyP50Ms).toBe(200);
    expect(reordered.latencyP95Ms).toBe(400);
    expect(reordered.costUsd).toBeCloseTo(0.00005, 12);
    expect(reordered.estimatedCalls).toBe(1);
    expect(reordered.selectionRecorded).toBe(true);
    expect(reordered.selectionKendallTauDecided).toBe(-1);
    expect(reordered.selectionKendallTauLexical).toBe(-1);
    expect(reordered.selectionAgreesWithDecided).toBe(true);
    expect(reordered.selectionAgreesWithLexical).toBe(false);

    const stable = figures[1];
    expect(stable.orderChanged).toBe(false);
    expect(stable.top1Changed).toBe(false);
    expect(stable.kendallTau).toBe(1);
    expect(stable.unknownRateByReason).toEqual({});
    expect(stable.selectionRecorded).toBe(false);
    expect(stable.selectionAgreesWithDecided).toBeNull();

    const preK2 = figures[2];
    expect(preK2.latencyP50Ms).toBe(FIGURE_NOT_PERSISTED);
    expect(preK2.latencyP95Ms).toBe(FIGURE_NOT_PERSISTED);
    expect(preK2.selectionRecorded).toBe(false);
  });

  it('reports an outcome joined to a reference with no settled call rather than dropping it', () => {
    const snapshot: DecisionJournalSnapshot = {
      receipts: [],
      outcomes: [
        {
          consumer: 'knowledge-ranking',
          contextRef: REF_REORDERED,
          kind: 'ranking-selection',
          value: ['ke-a'],
          at: '2026-10-17T10:05:00.000Z',
        },
      ],
    };
    const figures = computeRankingTrialFigures(snapshot);
    expect(figures).toHaveLength(1);
    expect(figures[0].calls).toBe(0);
    expect(figures[0].selectionRecorded).toBe(true);
    expect(figures[0].selectionAgreesWithDecided).toBeNull();
    expect(figures[0].latencyP50Ms).toBe(FIGURE_NOT_PERSISTED);
  });

  it('ignores another consumer\'s receipts and outcomes', () => {
    const snapshot: DecisionJournalSnapshot = {
      receipts: [
        receipt({
          contextRef: 'triage:att-1',
          consumer: 'claim-triage',
          lexicalOrder: ['k0'],
          decidedOrder: ['k0'],
        }),
      ],
      outcomes: [
        {
          consumer: 'claim-triage',
          contextRef: 'triage:att-1',
          kind: 'triage-disposition',
          value: ['k0', 'lesson'],
          at: '2026-10-17T10:05:00.000Z',
        },
      ],
    };
    expect(computeRankingTrialFigures(snapshot)).toEqual([]);
  });

  it('returns null tau when fewer than two entries are shared', () => {
    const snapshot: DecisionJournalSnapshot = {
      receipts: [
        receipt({
          contextRef: REF_REORDERED,
          lexicalOrder: ['ke-a', 'ke-b'],
          decidedOrder: ['ke-c', 'ke-a'],
        }),
      ],
      outcomes: [],
    };
    const figures = computeRankingTrialFigures(snapshot);
    expect(figures[0].kendallTau).toBeNull();
  });
});
