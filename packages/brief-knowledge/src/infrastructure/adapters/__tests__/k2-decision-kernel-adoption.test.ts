// Lane K2 (decision-kernel plan, 2026-10-16, §3): the kernel adoption and the
// receipt fields it adds. No real network and no key material: the advice
// port is a fake, the journal is the real file adapter over a temp dir.
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir, appendFile } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

import { FileDecisionReceiptJournalAdapter } from '../FileDecisionReceiptJournalAdapter.adapter.js';
import { BudgetedRankingAdviceAdapter } from '../BudgetedRankingAdviceAdapter.adapter.js';
import { AdvisedKnowledgeRetrievalAdapter } from '../AdvisedKnowledgeRetrievalAdapter.adapter.js';
import { NullRankingAdviceAdapter } from '../NullRankingAdviceAdapter.adapter.js';
import { AnswerFileRankingAdviceAdapter } from '../AnswerFileRankingAdviceAdapter.adapter.js';
import { JevRankingAdviceAdapter } from '../JevRankingAdviceAdapter.adapter.js';
import { rankingContextRef } from '../jev-advice-state.js';
import { ProposeBriefContextUseCase } from '../../../application/use-cases/ProposeBriefContextUseCase.use-case.js';
import type {
  AdviseRankingQuery,
  KnowledgeRankingAdvicePort,
  RankingAdvice,
} from '../../../application/ports/out/KnowledgeRankingAdvicePort.out-port.js';
import type { KnowledgeEntryRepositoryPort } from '../../../application/ports/out/KnowledgeEntryRepositoryPort.out-port.js';
import type { KnowledgeRetrievalPort, RankedKeeperMatch } from '../../../application/ports/out/KnowledgeRetrievalPort.out-port.js';
import type {
  AppendDecisionOutcome,
  DecisionCallReceipt,
  DecisionReceiptJournalPort,
  DecisionJournalSnapshot,
  ReadDecisionJournalQuery,
  ReserveDecisionQuery,
  ReserveDecisionResult,
} from '../../../application/ports/out/DecisionReceiptJournalPort.out-port.js';
import type { KnowledgeEntryRecord } from '../../../domain/knowledge-records.js';
import type { ContextSelectionProps } from '../../../domain/value-objects/ContextSelection.vo.js';

const SHA = 'e'.repeat(64);
const AT_JANUARY = () => new Date('2026-01-15T10:00:00.000Z');

const QUERY: AdviseRankingQuery = {
  projectId: 'proj-k2',
  laneId: 'lane-k2',
  taskSummary: 'Fix the failing date parsing test in src/utils/date.ts',
  pathPrefixes: ['src/utils'],
  candidates: [
    { id: 'bk-1', claimText: 'Date strings are parsed with parseISO.' },
    { id: 'bk-2', claimText: 'The README badge links to the CI workflow.' },
  ],
};

/** Advances by one second per read so a settled `at` is a real instant. */
function clockFrom(start: string): () => Date {
  let tick = 0;
  return () => new Date(Date.parse(start) + tick++ * 1000);
}

async function newStateDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'fleet-k2-'));
}

function monthPath(stateDir: string, month = '2026-01'): string {
  return path.join(stateDir, 'decision-receipts', `${month}.jsonl`);
}

function outcomesPath(stateDir: string, month = '2026-01'): string {
  return path.join(stateDir, 'decision-receipts', `outcomes-${month}.jsonl`);
}

interface RawLine {
  kind: string;
  [field: string]: unknown;
}

async function readLines(filePath: string): Promise<RawLine[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RawLine);
}

/** Advice answer the ranking path treats as applied, with no provider receipt. */
const ADVISED: RankingAdvice = {
  status: 'advised',
  scores: { 'bk-1': 0.9, 'bk-2': 0.1 },
  model: 'jev-k2',
  confidence: 0.91,
};

function fakeAdvice(answer: RankingAdvice): KnowledgeRankingAdvicePort {
  return { adviseRanking: async () => answer };
}

describe('rankingContextRef', () => {
  it('is the same for the same inputs whatever order the candidates arrive in', () => {
    const first = rankingContextRef({
      laneId: 'lane-k2',
      taskSummary: QUERY.taskSummary,
      candidates: QUERY.candidates,
    });
    const reversed = rankingContextRef({
      laneId: 'lane-k2',
      taskSummary: QUERY.taskSummary,
      candidates: [...QUERY.candidates].reverse(),
    });
    expect(first).toBe(reversed);
    expect(first).toMatch(/^ranking:lane-k2:[0-9a-f]{64}$/);
  });

  it('separates lanes and task summaries, and scopes a missing lane', () => {
    const base = { taskSummary: QUERY.taskSummary, candidates: QUERY.candidates };
    const laneA = rankingContextRef({ ...base, laneId: 'lane-a' });
    const laneB = rankingContextRef({ ...base, laneId: 'lane-b' });
    const otherTask = rankingContextRef({ ...base, laneId: 'lane-a', taskSummary: 'another task' });
    expect(laneA).not.toBe(laneB);
    expect(laneA).not.toBe(otherTask);
    expect(rankingContextRef({ ...base })).toMatch(/^ranking:unscoped:[0-9a-f]{64}$/);
  });

  it('carries neither the claim text nor the task summary', () => {
    const contextRef = rankingContextRef({
      laneId: 'lane-k2',
      taskSummary: QUERY.taskSummary,
      candidates: QUERY.candidates,
    });
    for (const candidate of QUERY.candidates) {
      expect(contextRef).not.toContain(candidate.claimText);
    }
    expect(contextRef).not.toContain(QUERY.taskSummary);
  });

  it('keeps a usable lane and replaces every other lane with its own digest prefix', () => {
    const base = { taskSummary: QUERY.taskSummary, candidates: QUERY.candidates };
    // 64 chars is the cap; 65 is the first lane that must be replaced.
    expect(rankingContextRef({ ...base, laneId: 'a'.repeat(64) })).toContain(
      `ranking:${'a'.repeat(64)}:`,
    );
    const unusableLanes = [
      'a'.repeat(65),
      'lane:with:colons',
      'lane/with/slashes',
      'ghp_abcdefghijklmnopqrstuvwxyz012345',
    ];
    for (const laneId of unusableLanes) {
      const contextRef = rankingContextRef({ ...base, laneId });
      expect(contextRef).toMatch(/^ranking:[0-9a-f]{16}:[0-9a-f]{64}$/);
      // Nothing of the declared lane survives, and the whole reference stays
      // inside the journal's 256-character cap.
      expect(contextRef).not.toContain(laneId);
      expect(contextRef.length).toBeLessThanOrEqual(256);
      // Deterministic: the same lane always names the same ranking.
      expect(rankingContextRef({ ...base, laneId })).toBe(contextRef);
    }
    // Distinct lanes never collide once they are replaced.
    expect(new Set(unusableLanes.map((laneId) => rankingContextRef({ ...base, laneId }))).size).toBe(
      unusableLanes.length,
    );
  });

  it('scopes a blank lane to unscoped and never leaks a secret-shaped one', () => {
    const base = { taskSummary: QUERY.taskSummary, candidates: QUERY.candidates };
    expect(rankingContextRef({ ...base, laneId: '   ' })).toMatch(/^ranking:unscoped:[0-9a-f]{64}$/);
    for (const laneId of [
      'sk-abcdefghijklmnopqrstuvwx',
      'AKIAIOSFODNN7EXAMPLE',
      'ghp_abcdefghijklmnopqrstuvwxyz012345',
    ]) {
      expect(rankingContextRef({ ...base, laneId })).toMatch(/^ranking:[0-9a-f]{16}:[0-9a-f]{64}$/);
    }
  });
});

describe('a hostile laneId still settles a receipt', () => {
  it('writes the reference with the lane replaced by its digest prefix', async () => {
    const stateDir = await newStateDir();
    try {
      const adapter = new FileDecisionReceiptJournalAdapter(stateDir, AT_JANUARY);
      const advice = new BudgetedRankingAdviceAdapter({
        inner: fakeAdvice(ADVISED),
        journal: adapter,
        provider: 'jev',
        assumedCostUsd: 0.001,
        monthlyBudgetUsd: 1,
      });
      const laneIds = [
        'lane'.repeat(40),
        'lane:with:colons',
        'ghp_abcdefghijklmnopqrstuvwxyz012345',
      ];
      const refs: string[] = [];
      for (const laneId of laneIds) {
        const answer = await advice.adviseRanking({ ...QUERY, laneId });
        // The settlement succeeded, so the answer is used and names its own
        // reference rather than failing on an unusable lane segment.
        expect(answer.status).toBe('advised');
        expect(answer.contextRef).toMatch(/^ranking:[0-9a-f]{16}:[0-9a-f]{64}$/);
        refs.push(answer.contextRef ?? '');
      }
      const settled = (await readLines(monthPath(stateDir))).filter(
        (line) => line.kind === 'settled',
      );
      expect(settled.map((line) => line.contextRef)).toEqual(refs);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe('receipt lines written before K2 still parse', () => {
  it('reads a D4-era month file and charges its spend to knowledge-ranking', async () => {
    const stateDir = await newStateDir();
    try {
      await mkdir(path.dirname(monthPath(stateDir)), { recursive: true });
      await writeFile(
        monthPath(stateDir),
        [
          JSON.stringify({
            kind: 'reserved',
            id: 'old-reservation',
            assumedCostUsd: 0.25,
            stateSha256: SHA,
            at: '2026-01-02T00:00:00.000Z',
          }),
          JSON.stringify({
            kind: 'settled',
            reservationId: 'old-reservation',
            provider: 'jev',
            model: 'typesafe/jev-1.14',
            costUsd: 0.2,
            estimated: false,
            lexicalOrder: ['bk-1'],
            decidedOrder: ['bk-1'],
            at: '2026-01-02T00:00:01.000Z',
          }),
          '',
        ].join('\n'),
        'utf8',
      );
      const adapter = new FileDecisionReceiptJournalAdapter(stateDir, AT_JANUARY);

      expect(await adapter.monthSpendUsd(new Date('2026-01-20T00:00:00.000Z'))).toBe(0.2);

      // No consumer declared anywhere: the old spend is the ranking
      // sub-budget's, so a ranking reserve at its cap is refused…
      const atRankingCap = await adapter.reserve({
        assumedCostUsd: 0.1,
        monthlyBudgetUsd: 1,
        consumerBudgetUsd: 0.3,
        stateSha256: SHA,
      });
      expect(atRankingCap).toEqual({ ok: false, reason: 'budget-exhausted' });

      // …while another consumer's own sub-budget is untouched by it.
      const triage = await adapter.reserve({
        consumer: 'claim-triage',
        assumedCostUsd: 0.1,
        monthlyBudgetUsd: 1,
        consumerBudgetUsd: 0.2,
        stateSha256: SHA,
      });
      expect(triage.ok).toBe(true);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('parses a settled claim-triage line with empty orders, so a rollback keeps reading', async () => {
    const stateDir = await newStateDir();
    try {
      await mkdir(path.dirname(monthPath(stateDir)), { recursive: true });
      await writeFile(
        monthPath(stateDir),
        `${JSON.stringify({
          kind: 'settled',
          reservationId: 'triage-1',
          consumer: 'claim-triage',
          contextRef: 'triage:attempt-1',
          provider: 'jev',
          model: 'typesafe/jev-1.14',
          costUsd: 0.05,
          estimated: false,
          questionKinds: ['choice', 'score'],
          minConfidenceObserved: 0.8,
          latencyMs: 412,
          lexicalOrder: [],
          decidedOrder: [],
          dispositions: [{ candidateId: 'bk-9', chosenClass: 'policy-proposal', reusability: 0.2 }],
          at: '2026-01-03T00:00:00.000Z',
        })}\n`,
        'utf8',
      );
      const adapter = new FileDecisionReceiptJournalAdapter(stateDir, AT_JANUARY);

      expect(await adapter.monthSpendUsd(new Date('2026-01-20T00:00:00.000Z'))).toBe(0.05);
      const ranking = await adapter.reserve({
        assumedCostUsd: 0.4,
        monthlyBudgetUsd: 1,
        consumerBudgetUsd: 0.5,
        stateSha256: SHA,
      });
      expect(ranking.ok).toBe(true);
      // An outcome may join a triage receipt exactly as it joins a ranking one.
      await adapter.appendOutcome({
        consumer: 'claim-triage',
        contextRef: 'triage:attempt-1',
        kind: 'triage-disposition',
        value: ['bk-9', 'rejected'],
        at: '2026-01-15T10:00:00.000Z',
      });
      expect(await readLines(outcomesPath(stateDir))).toHaveLength(1);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe('consumer sub-budgets', () => {
  it('refuses at the cap, allows below it and still enforces the total', async () => {
    const stateDir = await newStateDir();
    try {
      const adapter = new FileDecisionReceiptJournalAdapter(stateDir, AT_JANUARY);
      const first = await adapter.reserve({
        consumer: 'knowledge-ranking',
        assumedCostUsd: 0.25,
        monthlyBudgetUsd: 10,
        consumerBudgetUsd: 0.5,
        stateSha256: SHA,
      });
      expect(first.ok).toBe(true);

      // 0.25 + 0.25 reaches the 0.5 sub-budget exactly: refused.
      const atCap = await adapter.reserve({
        consumer: 'knowledge-ranking',
        assumedCostUsd: 0.25,
        monthlyBudgetUsd: 10,
        consumerBudgetUsd: 0.5,
        stateSha256: SHA,
      });
      expect(atCap).toEqual({ ok: false, reason: 'budget-exhausted' });

      // The same cost under another consumer has its own untouched budget.
      const triage = await adapter.reserve({
        consumer: 'claim-triage',
        assumedCostUsd: 0.5,
        monthlyBudgetUsd: 10,
        consumerBudgetUsd: 0.5,
        stateSha256: SHA,
      });
      expect(triage.ok).toBe(false);

      // No sub-budget clause at all: only the monthly total applies.
      const totalRefused = await adapter.reserve({
        consumer: 'knowledge-ranking',
        assumedCostUsd: 10,
        monthlyBudgetUsd: 0.5,
        stateSha256: SHA,
      });
      expect(totalRefused).toEqual({ ok: false, reason: 'budget-exhausted' });

      const lines = await readLines(monthPath(stateDir));
      expect(lines).toHaveLength(1);
      expect(lines[0]?.consumer).toBe('knowledge-ranking');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('refuses a sub-budget that is not a positive number', async () => {
    const stateDir = await newStateDir();
    try {
      const adapter = new FileDecisionReceiptJournalAdapter(stateDir, AT_JANUARY);
      for (const consumerBudgetUsd of [0, -1, Number.NaN]) {
        await expect(
          adapter.reserve({
            assumedCostUsd: 0.25,
            monthlyBudgetUsd: 1,
            consumerBudgetUsd,
            stateSha256: SHA,
          }),
        ).rejects.toThrow(/consumerBudgetUsd/);
      }
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe('outcomes', () => {
  async function settledAdapter(stateDir: string): Promise<{
    adapter: FileDecisionReceiptJournalAdapter;
    contextRef: string;
  }> {
    const adapter = new FileDecisionReceiptJournalAdapter(stateDir, clockFrom('2026-01-15T10:00:00.000Z'));
    const advice = new BudgetedRankingAdviceAdapter({
      inner: fakeAdvice(ADVISED),
      journal: adapter,
      provider: 'jev',
      assumedCostUsd: 0.001,
      monthlyBudgetUsd: 1,
    });
    const answer = await advice.adviseRanking(QUERY);
    expect(answer.status).toBe('advised');
    return { adapter, contextRef: answer.contextRef ?? '' };
  }

  it('is skipped when no settled receipt has that contextRef', async () => {
    const stateDir = await newStateDir();
    try {
      const adapter = new FileDecisionReceiptJournalAdapter(stateDir, AT_JANUARY);
      await adapter.appendOutcome({
        consumer: 'knowledge-ranking',
        contextRef: `ranking:lane-k2:${'a'.repeat(64)}`,
        kind: 'ranking-selection',
        value: ['bk-1'],
        at: '2026-01-15T10:00:00.000Z',
      });
      // The month file was read, no receipt matched, nothing was written.
      expect(await readLines(outcomesPath(stateDir))).toEqual([]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('is appended once for a settled contextRef, in its own file', async () => {
    const stateDir = await newStateDir();
    try {
      const { adapter, contextRef } = await settledAdapter(stateDir);
      await adapter.appendOutcome({
        consumer: 'knowledge-ranking',
        contextRef,
        kind: 'ranking-selection',
        value: ['bk-1', 'bk-2'],
        at: '2026-01-15T10:00:02.000Z',
      });
      const outcomes = await readLines(outcomesPath(stateDir));
      expect(outcomes).toHaveLength(1);
      expect(Object.keys(outcomes[0] ?? {}).sort()).toEqual([
        'at',
        'consumer',
        'contextRef',
        'kind',
        'value',
      ]);
      expect(outcomes[0]?.contextRef).toBe(contextRef);
      expect(outcomes[0]?.value).toEqual(['bk-1', 'bk-2']);
      // The budget file never learns about the outcome line kind.
      expect((await readLines(monthPath(stateDir))).every((line) => line.kind !== 'outcome')).toBe(
        true,
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('never throws at the caller, even when the budget file is corrupt', async () => {
    const stateDir = await newStateDir();
    try {
      const { adapter, contextRef } = await settledAdapter(stateDir);
      await appendFile(monthPath(stateDir), '{"kind":"settl\n', 'utf8');

      await expect(
        adapter.appendOutcome({
          consumer: 'knowledge-ranking',
          contextRef,
          kind: 'ranking-selection',
          value: ['bk-1'],
          at: '2026-01-15T10:00:02.000Z',
        }),
      ).resolves.toBeUndefined();
      expect(await readLines(outcomesPath(stateDir))).toEqual([]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('skips a credential-shaped or unusable value rather than recording it', async () => {
    const stateDir = await newStateDir();
    try {
      const { adapter, contextRef } = await settledAdapter(stateDir);
      // A credential-shaped value is refused outright, like an empty one.
      for (const value of [['ghp_abcdefghijklmnopqrstuvwxyz012345'], [], ['ok', '']]) {
        await adapter.appendOutcome({
          consumer: 'knowledge-ranking',
          contextRef,
          kind: 'ranking-selection',
          value,
          at: '2026-01-15T10:00:02.000Z',
        });
      }
      await adapter.appendOutcome({
        consumer: 'knowledge-ranking',
        contextRef,
        kind: 'not-a-kind' as 'ranking-selection',
        value: ['bk-1'],
        at: '2026-01-15T10:00:02.000Z',
      });
      await adapter.appendOutcome({
        consumer: 'knowledge-ranking',
        contextRef,
        kind: 'ranking-selection',
        value: ['bk-1'],
        at: 'not-a-date',
      });
      expect(await readLines(outcomesPath(stateDir))).toEqual([]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe('the ranking receipt envelope', () => {
  it('carries consumer, contextRef, latencyMs, question kinds and confidence', async () => {
    const stateDir = await newStateDir();
    try {
      const adapter = new FileDecisionReceiptJournalAdapter(stateDir, AT_JANUARY);
      const advice = new BudgetedRankingAdviceAdapter({
        inner: fakeAdvice(ADVISED),
        journal: adapter,
        provider: 'jev',
        assumedCostUsd: 0.001,
        monthlyBudgetUsd: 1,
      });
      const answer = await advice.adviseRanking(QUERY);

      const [reserved, settled] = await readLines(monthPath(stateDir));
      expect(reserved?.kind).toBe('reserved');
      expect(reserved?.consumer).toBe('knowledge-ranking');
      const expectedRef = rankingContextRef({
        laneId: QUERY.laneId,
        taskSummary: QUERY.taskSummary,
        candidates: QUERY.candidates,
      });
      expect(settled?.contextRef).toBe(expectedRef);
      // The reference travels back on the answer, never as port state.
      expect(answer.contextRef).toBe(expectedRef);
      expect(settled?.questionKinds).toEqual(['score']);
      expect(settled?.minConfidenceObserved).toBe(0.91);
      expect(typeof settled?.latencyMs).toBe('number');
      expect(Number(settled?.latencyMs)).toBeGreaterThanOrEqual(0);
      expect(settled?.unknownReason).toBeUndefined();
      expect(settled?.estimated).toBe(true);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('records an unknown answer with its reason and no confidence', async () => {
    const stateDir = await newStateDir();
    try {
      const adapter = new FileDecisionReceiptJournalAdapter(stateDir, AT_JANUARY);
      const advice = new BudgetedRankingAdviceAdapter({
        inner: fakeAdvice({ status: 'unknown', reason: 'timeout' }),
        journal: adapter,
        provider: 'jev',
        assumedCostUsd: 0.001,
        monthlyBudgetUsd: 1,
      });
      const answer = await advice.adviseRanking(QUERY);
      const settled = (await readLines(monthPath(stateDir)))[1];
      expect(settled?.unknownReason).toBe('timeout');
      expect(settled?.minConfidenceObserved).toBeUndefined();
      // A settled receipt still names its reference: its outcome joins on it.
      expect(typeof settled?.contextRef).toBe('string');
      expect(answer.contextRef).toBe(settled?.contextRef);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('carries no reference when the budget refuses the call', async () => {
    const stateDir = await newStateDir();
    try {
      const adapter = new FileDecisionReceiptJournalAdapter(stateDir, AT_JANUARY);
      const advice = new BudgetedRankingAdviceAdapter({
        inner: fakeAdvice(ADVISED),
        journal: adapter,
        provider: 'jev',
        assumedCostUsd: 1,
        monthlyBudgetUsd: 0.5,
      });
      const answer = await advice.adviseRanking(QUERY);
      expect(answer).toEqual({ status: 'unknown', reason: 'budget' });
      // Nothing was settled, so the answer names no reference at all.
      expect(answer.contextRef).toBeUndefined();
      expect(await readLines(monthPath(stateDir))).toEqual([]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe('ProposeBriefContextUseCase reports the ranking contextRef', () => {
  function keeper(id: string, claimText: string): KnowledgeEntryRecord {
    return {
      id,
      version: '1.0.0',
      projectId: 'proj-k2',
      sourceAttemptId: 'attempt-1',
      sourceCommitSha: '0'.repeat(40),
      claimText,
      pathPrefixes: ['src/utils'],
      sharedAcrossProjects: false,
      disposition: 'accepted',
      verification: 'supported',
      checkerId: 'checker-1',
      dispositionReason: 'verified',
      supersededById: null,
      checks: [],
      reuses: [],
      revision: 1,
      createdAtIso: '2026-10-16T00:00:00.000Z',
      updatedAtIso: '2026-10-16T00:00:00.000Z',
    };
  }

  function repoWith(entries: readonly KnowledgeEntryRecord[]): KnowledgeEntryRepositoryPort {
    return {
      saveEntry: async () => undefined,
      findEntryById: async (entryId) => entries.find((entry) => entry.id === entryId) ?? null,
      listEntriesByProject: async (projectId) =>
        projectId === undefined ? entries : entries.filter((entry) => entry.projectId === projectId),
      listEntriesBySourceAttempt: async () => [],
      setTriageFlag: async () => undefined,
      saveContextSelections: async (_attemptId: string, _selections: readonly ContextSelectionProps[]) => undefined,
      listContextSelections: async () => [],
    };
  }

  function retrievalOf(matches: readonly RankedKeeperMatch[]): KnowledgeRetrievalPort {
    return { rankEligibleKeepers: async () => matches };
  }

  const MATCHES: readonly RankedKeeperMatch[] = [
    { entry: keeper('bk-1', 'Date strings are parsed with parseISO.'), score: 1, matchReason: 'lexical overlap' },
    { entry: keeper('bk-2', 'The README badge links to the CI workflow.'), score: 0.5, matchReason: 'lexical overlap' },
  ];

  const REQUEST = {
    projectId: 'proj-k2',
    laneId: 'lane-k2',
    taskSummary: QUERY.taskSummary,
    pathPrefixes: ['src/utils'],
  } as const;

  it('reports it when an advised call settled a receipt', async () => {
    const stateDir = await newStateDir();
    try {
      const journal = new FileDecisionReceiptJournalAdapter(stateDir, AT_JANUARY);
      const advice = new BudgetedRankingAdviceAdapter({
        inner: fakeAdvice(ADVISED),
        journal,
        provider: 'jev',
        assumedCostUsd: 0.001,
        monthlyBudgetUsd: 1,
      });
      const useCase = new ProposeBriefContextUseCase({
        repo: repoWith(MATCHES.map((match) => match.entry)),
        retrieval: new AdvisedKnowledgeRetrievalAdapter(retrievalOf(MATCHES), advice),
      });

      const result = await useCase.proposeBriefContext(REQUEST);
      expect(result.outcome).toBe('proposed');
      if (result.outcome !== 'proposed') {
        throw new Error('expected proposed outcome');
      }
      const contextRef = result.rankingContextRef;
      expect(contextRef).toMatch(/^ranking:lane-k2:[0-9a-f]{64}$/);
      // The reference the caller reports back is the one the receipt carries.
      expect((await readLines(monthPath(stateDir)))[1]?.contextRef).toBe(contextRef);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('reports none when advice is off: the result is exactly what it was', async () => {
    const stateDir = await newStateDir();
    try {
      const useCase = new ProposeBriefContextUseCase({
        repo: repoWith(MATCHES.map((match) => match.entry)),
        retrieval: new AdvisedKnowledgeRetrievalAdapter(
          retrievalOf(MATCHES),
          new NullRankingAdviceAdapter(),
        ),
      });
      const result = await useCase.proposeBriefContext(REQUEST);
      expect(Object.keys(result).sort()).toEqual(['outcome', 'proposals']);
      expect(await readLines(monthPath(stateDir))).toEqual([]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('reports none when fewer than two entries make an advice call pointless', async () => {
    const stateDir = await newStateDir();
    try {
      const journal = new FileDecisionReceiptJournalAdapter(stateDir, AT_JANUARY);
      const advice = new BudgetedRankingAdviceAdapter({
        inner: fakeAdvice(ADVISED),
        journal,
        provider: 'jev',
        assumedCostUsd: 0.001,
        monthlyBudgetUsd: 1,
      });
      const useCase = new ProposeBriefContextUseCase({
        repo: repoWith([MATCHES[0]!.entry]),
        retrieval: new AdvisedKnowledgeRetrievalAdapter(retrievalOf([MATCHES[0]!]), advice),
      });
      const result = await useCase.proposeBriefContext(REQUEST);
      expect(result.outcome).toBe('proposed');
      if (result.outcome !== 'proposed') {
        throw new Error('expected proposed outcome');
      }
      expect(result.rankingContextRef).toBeUndefined();
      expect(await readLines(monthPath(stateDir))).toEqual([]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('gives each of two concurrent proposals its own contextRef', async () => {
    const journal = new InterleavedJournal();
    const advice = new BudgetedRankingAdviceAdapter({
      // Both calls are held inside the inner port until each has arrived, so
      // they settle one after the other with both in flight.
      inner: interleavedAdvice(ADVISED),
      journal,
      provider: 'jev',
      assumedCostUsd: 0.001,
      monthlyBudgetUsd: 1,
    });
    const useCase = new ProposeBriefContextUseCase({
      repo: repoWith(MATCHES.map((match) => match.entry)),
      retrieval: new AdvisedKnowledgeRetrievalAdapter(delayedRetrievalOf(MATCHES), advice),
    });

    const [first, second] = await Promise.all([
      useCase.proposeBriefContext({ ...REQUEST, laneId: 'lane-concurrent-a' }),
      useCase.proposeBriefContext({ ...REQUEST, laneId: 'lane-concurrent-b' }),
    ]);
    expect(first.outcome).toBe('proposed');
    expect(second.outcome).toBe('proposed');
    if (first.outcome !== 'proposed' || second.outcome !== 'proposed') {
      throw new Error('expected two proposed outcomes');
    }

    // Each proposal names the reference its own call settled: no shared state
    // hands one proposal the other's reference.
    expect(first.rankingContextRef).toBe(expectedRefFor('lane-concurrent-a'));
    expect(second.rankingContextRef).toBe(expectedRefFor('lane-concurrent-b'));
    expect(first.rankingContextRef).not.toBe(second.rankingContextRef);
    expect(journal.settledContextRefs.slice().sort()).toEqual(
      [first.rankingContextRef, second.rankingContextRef].sort(),
    );
  });
});

/** The reference one lane's proposal must report, from the same inputs. */
function expectedRefFor(laneId: string): string {
  return rankingContextRef({
    laneId,
    taskSummary: QUERY.taskSummary,
    candidates: [
      { id: 'bk-1', claimText: 'Date strings are parsed with parseISO.' },
      { id: 'bk-2', claimText: 'The README badge links to the CI workflow.' },
    ],
  });
}

/** Holds every call in the advice port until two of them have arrived. */
function interleavedAdvice(answer: RankingAdvice): KnowledgeRankingAdvicePort {
  let arrived = 0;
  let release!: () => void;
  const bothArrived = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    async adviseRanking(): Promise<RankingAdvice> {
      arrived += 1;
      if (arrived >= 2) {
        release();
      }
      await bothArrived;
      return answer;
    },
  };
}

/** The deterministic set, handed over a tick later than the call asked. */
function delayedRetrievalOf(matches: readonly RankedKeeperMatch[]): KnowledgeRetrievalPort {
  return {
    rankEligibleKeepers: async () => {
      await Promise.resolve();
      return matches;
    },
  };
}

/**
 * In-memory journal: `settle` resolves without touching a filesystem, so the
 * two calls' settlements interleave the same way on every run.
 */
class InterleavedJournal implements DecisionReceiptJournalPort {
  readonly settledContextRefs: string[] = [];
  private reservations = 0;

  async reserve(_query: ReserveDecisionQuery): Promise<ReserveDecisionResult> {
    this.reservations += 1;
    return { ok: true, reservationId: `reservation-${this.reservations}` };
  }

  async settle(_reservationId: string, receipt: DecisionCallReceipt): Promise<void> {
    this.settledContextRefs.push(receipt.contextRef);
  }

  async monthSpendUsd(_monthUtc: Date): Promise<number> {
    return 0;
  }

  async appendOutcome(_outcome: AppendDecisionOutcome): Promise<void> {
    // Outcomes are not what this journal is here to observe.
  }

  async readJournal(_query: ReadDecisionJournalQuery): Promise<DecisionJournalSnapshot> {
    return { receipts: [], outcomes: [] };
  }
}

describe('a non-finite minConfidence is a configuration error at the call site', () => {
  it('answers not-configured without reading the answer file', async () => {
    let readerCalls = 0;
    const adapter = new AnswerFileRankingAdviceAdapter(
      '/answers.json',
      async () => {
        readerCalls += 1;
        return '{}';
      },
      0.5,
    );
    // The constructor already refuses one; the call site refuses it too.
    (adapter as unknown as { minConfidence: number }).minConfidence = Number.NaN;
    expect(await adapter.adviseRanking(QUERY)).toEqual({
      status: 'unknown',
      reason: 'not-configured',
    });
    expect(readerCalls).toBe(0);
  });

  it('answers not-configured without fetching or reading the key', async () => {
    let fetchCalls = 0;
    let readKeyCalls = 0;
    const adapter = new JevRankingAdviceAdapter({
      model: 'typesafe/jev-1.14',
      keyFile: '/keys/jev.key',
      minConfidence: 0.5,
      fetch: (async () => {
        fetchCalls += 1;
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
      readKey: async () => {
        readKeyCalls += 1;
        return 'stub-key-not-real';
      },
    });
    (adapter as unknown as { minConfidence: number }).minConfidence = Number.NaN;
    expect(await adapter.adviseRanking(QUERY)).toEqual({
      status: 'unknown',
      reason: 'not-configured',
    });
    expect(fetchCalls).toBe(0);
    expect(readKeyCalls).toBe(0);
  });
});