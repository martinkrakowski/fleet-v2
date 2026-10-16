// Tests for lane D1 (decision port plan, 2026-10-16): the advised retrieval
// decorator's pure reorder, reference-equal unknown behaviour and spy checks.
import { describe, expect, it, vi } from 'vitest';
import { AdvisedKnowledgeRetrievalAdapter } from '../AdvisedKnowledgeRetrievalAdapter.adapter.js';
import { NullRankingAdviceAdapter } from '../NullRankingAdviceAdapter.adapter.js';
import type { KnowledgeRetrievalPort, RankKeepersQuery, RankedKeeperMatch } from '../../../application/ports/out/KnowledgeRetrievalPort.out-port.js';
import type { AdviseRankingQuery, KnowledgeRankingAdvicePort, RankingAdvice } from '../../../application/ports/out/KnowledgeRankingAdvicePort.out-port.js';
import type { KnowledgeEntryRecord } from '../../../domain/knowledge-records.js';

const UNKNOWN_REASONS = [
  'not-configured',
  'timeout',
  'transport',
  'shape',
  'redaction-refused',
  'budget',
  'low-confidence',
] as const;

function entry(id: string, claimText: string): KnowledgeEntryRecord {
  return {
    id,
    version: '1.0.0',
    projectId: 'p1',
    sourceAttemptId: 'attempt-1',
    sourceCommitSha: 'commit-1',
    claimText,
    pathPrefixes: [],
    sharedAcrossProjects: false,
    disposition: 'accepted',
    verification: 'supported',
    checkerId: null,
    dispositionReason: null,
    supersededById: null,
    checks: [],
    reuses: [],
    revision: 1,
    createdAtIso: '2026-10-16T00:00:00.000Z',
    updatedAtIso: '2026-10-16T00:00:00.000Z',
  } as KnowledgeEntryRecord;
}

function match(id: string, score: number, claimText = `claim ${id}`): RankedKeeperMatch {
  return { entry: entry(id, claimText), score, matchReason: 'lexical overlap' };
}

function query(matchList: readonly RankedKeeperMatch[]): RankKeepersQuery {
  return {
    projectId: 'p1',
    taskSummary: 'task',
    pathPrefixes: [],
    maxEntries: 10,
    maxTotalChars: 1000,
    candidateKeepers: matchList.map((m) => m.entry),
  };
}

/** Deterministic seeded PRNG (mulberry32) for the property-style loop. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function spyAdvice(answer: RankingAdvice): KnowledgeRankingAdvicePort & { calls: AdviseRankingQuery[] } {
  const calls: AdviseRankingQuery[] = [];
  return {
    calls,
    async adviseRanking(req: AdviseRankingQuery) {
      calls.push(req);
      return answer;
    },
  };
}

function spyInner(result: RankedKeeperMatch[]): KnowledgeRetrievalPort {
  return {
    rankEligibleKeepers: vi.fn(async (_q: RankKeepersQuery) => result),
  };
}

function advised(scores: Record<string, number>, model = 'jev-1.14', confidence = 0.9): RankingAdvice {
  return { status: 'advised', scores, model, confidence };
}

function makeDecorator(
  innerResult: RankedKeeperMatch[],
  adviceAnswer: RankingAdvice,
  weight?: number,
): { decorator: AdvisedKnowledgeRetrievalAdapter; inner: KnowledgeRetrievalPort; advice: ReturnType<typeof spyAdvice> } {
  const inner = spyInner(innerResult);
  const advice = spyAdvice(adviceAnswer);
  const decorator =
    weight === undefined
      ? new AdvisedKnowledgeRetrievalAdapter(inner, advice)
      : new AdvisedKnowledgeRetrievalAdapter(inner, advice, weight);
  return { decorator, inner, advice };
}

describe('NullRankingAdviceAdapter', () => {
  it('always answers unknown/not-configured', async () => {
    const result = await new NullRankingAdviceAdapter().adviseRanking({
      projectId: 'p1',
      taskSummary: 't',
      pathPrefixes: [],
      candidates: [{ id: 'a', claimText: 'c' }],
    });
    expect(result).toEqual({ status: 'unknown', reason: 'not-configured' });
  });
});

describe('AdvisedKnowledgeRetrievalAdapter', () => {
  it('never calls advice with fewer than two entries', async () => {
    for (const size of [0, 1]) {
      const innerResult = [match('a', 1), match('b', 0.5), match('c', 0.25)].slice(0, size);
      const { decorator, advice } = makeDecorator(innerResult, advised({ a: 1, b: 0, c: 0.5 }));
      const result = await decorator.rankEligibleKeepers(query(innerResult));
      expect(advice.calls).toHaveLength(0);
      expect(result).toBe(innerResult);
    }
  });

  it('returns the same reference when the advice port throws', async () => {
    const innerResult = [match('a', 1), match('b', 0.5)];
    const inner: KnowledgeRetrievalPort = { rankEligibleKeepers: async () => innerResult };
    const throwing: KnowledgeRankingAdvicePort = {
      adviseRanking: async () => {
        throw new Error('boom');
      },
    };
    const decorator = new AdvisedKnowledgeRetrievalAdapter(inner, throwing);
    await expect(decorator.rankEligibleKeepers(query(innerResult))).resolves.toBe(innerResult);
  });

  for (const reason of UNKNOWN_REASONS) {
    it(`returns the same reference on unknown/${reason}`, async () => {
      const innerResult = [match('a', 1), match('b', 0.5)];
      const { decorator, advice } = makeDecorator(innerResult, { status: 'unknown', reason });
      const result = await decorator.rankEligibleKeepers(query(innerResult));
      expect(result).toBe(innerResult);
      expect(advice.calls).toHaveLength(1);
    });
  }

  it('passes the original query fields to advice and reorders on advised', async () => {
    const innerResult = [match('a', 1), match('b', 0.4)];
    const { decorator, advice, inner } = makeDecorator(
      innerResult,
      advised({ a: 0.1, b: 1 }),
      0.5,
    );
    const result = await decorator.rankEligibleKeepers(query(innerResult));
    expect(inner.rankEligibleKeepers).toHaveBeenCalledWith(query(innerResult));
    expect(advice.calls).toHaveLength(1);
    expect(advice.calls[0].projectId).toBe('p1');
    expect(advice.calls[0].taskSummary).toBe('task');
    expect(advice.calls[0].candidates).toEqual([
      { id: 'a', claimText: 'claim a' },
      { id: 'b', claimText: 'claim b' },
    ]);
    // combined: a = 1 + 0.5*0.1 = 1.05; b = 0.4 + 0.5 = 0.9 → a still first
    expect(result.map((m) => m.entry.id)).toEqual(['a', 'b']);
    // weight=1 lets the decision score overturn the lexical lead: a = 1+0, b = 0.4+1
    const flipped = makeDecorator(innerResult, advised({ a: 0, b: 1 }), 1);
    const flippedResult = await flipped.decorator.rankEligibleKeepers(query(innerResult));
    expect(flippedResult.map((m) => m.entry.id)).toEqual(['b', 'a']);
  });

  it('appends the decision suffix to matchReason on advised', async () => {
    const innerResult = [match('a', 1), match('b', 0.5)];
    const { decorator } = makeDecorator(innerResult, advised({ a: 0.5, b: 0.5 }, 'jev-1.14', 0.756));
    const result = await decorator.rankEligibleKeepers(query(innerResult));
    for (const m of result) {
      expect(m.matchReason).toBe(`lexical overlap; decision(jev-1.14, c=0.76)`);
    }
  });

  it('leaves matchReason untouched on unknown', async () => {
    const innerResult = [match('a', 1), match('b', 0.5)];
    const { decorator } = makeDecorator(innerResult, { status: 'unknown', reason: 'timeout' });
    const result = await decorator.rankEligibleKeepers(query(innerResult));
    expect(result[0].matchReason).toBe('lexical overlap');
  });

  it('returns the inner reference when a decision score is missing, non-finite or out of range', async () => {
    for (const scores of [
      { b: 0.5 }, // missing id
      { a: Number.NaN, b: 0.5 },
      { a: Number.POSITIVE_INFINITY, b: 0.5 },
      { a: -0.1, b: 0.5 },
      { a: 1.1, b: 0.5 },
    ] as Record<string, number>[]) {
      const innerResult = [match('a', 1), match('b', 0.5)];
      const { decorator } = makeDecorator(innerResult, advised(scores));
      const result = await decorator.rankEligibleKeepers(query(innerResult));
      expect(result).toBe(innerResult);
    }
  });

  it('treats malformed confidence or model as unknown', async () => {
    for (const advice of [
      { status: 'advised', scores: { a: 0.5, b: 0.5 }, model: 'jev-1.14', confidence: 1.5 },
      { status: 'advised', scores: { a: 0.5, b: 0.5 }, model: '', confidence: 0.5 },
    ] as const) {
      const innerResult = [match('a', 1), match('b', 0.5)];
      const { decorator } = makeDecorator(innerResult, advice);
      const result = await decorator.rankEligibleKeepers(query(innerResult));
      expect(result).toBe(innerResult);
    }
  });

  it('breaks ties by entry.id localeCompare', async () => {
    const innerResult = [match('b10', 1), match('b2', 1), match('a9', 1)];
    // All combined keys equal: normalized 1 + weight*0.5 for every entry.
    const { decorator } = makeDecorator(
      innerResult,
      advised({ b10: 0.5, b2: 0.5, a9: 0.5 }),
      0.5,
    );
    const result = await decorator.rankEligibleKeepers(query(innerResult));
    const expected = [...innerResult.map((m) => m.entry.id)].sort((a, b) => a.localeCompare(b));
    expect(result.map((m) => m.entry.id)).toEqual(expected);
    expect(new Set(result.map((m) => m.entry.id))).toEqual(new Set(['a9', 'b2', 'b10']));
  });

  it('keeps the same id set over 200 seeded random reorderings (membership never changes)', async () => {
    const rand = seededRandom(20261016);
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const size = 2 + Math.floor(rand() * 8);
      const ids = Array.from({ length: size }, (_, i) => `e${i}-${iteration}`);
      const innerResult = ids.map((id) => match(id, 0.1 + rand()));
      const scores: Record<string, number> = {};
      for (const id of ids) scores[id] = rand();
      const advice = spyAdvice(advised(scores));
      const inner = spyInner(innerResult);
      const decorator = new AdvisedKnowledgeRetrievalAdapter(inner, advice, rand());
      const result = await decorator.rankEligibleKeepers(query(innerResult));

      expect(result).toHaveLength(size);
      expect(new Set(result.map((m) => m.entry.id))).toEqual(new Set(ids));
      // No duplicates, no additions.
      expect(new Set(result.map((m) => m.entry.id)).size).toBe(size);
      // Same entry objects as the inner result produced (decorator reorders, never clones entries).
      expect(result.every((m) => innerResult.some((r) => r.entry === m.entry))).toBe(true);
      // Advice was asked exactly for the set members.
      expect(advice.calls[0].candidates.map((c) => c.id).sort()).toEqual([...ids].sort());
    }
  });
});
