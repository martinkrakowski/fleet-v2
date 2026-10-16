// Lane D5a tests: BudgetedRankingAdviceAdapter and createRankingAdvice.
// The inner advice port is always a fake; the journal is the real
// FileDecisionReceiptJournalAdapter under a temp dir. 64-hex state hashes come
// from buildRankingAdviceState. No real network: fetch is a spy or a stub
// returning the owner-recorded fixture.
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile as readFileCb } from 'node:fs';
import { promisify } from 'node:util';
import {
  BudgetedRankingAdviceAdapter,
} from '../BudgetedRankingAdviceAdapter.adapter.js';
import {
  createRankingAdvice,
  type RankingAdviceDecisions,
} from '../ranking-advice-factory.js';
import { FileDecisionReceiptJournalAdapter } from '../FileDecisionReceiptJournalAdapter.adapter.js';
import { buildRankingAdviceState } from '../jev-advice-state.js';
import type {
  AdviseRankingQuery,
  KnowledgeRankingAdvicePort,
  RankingAdvice,
} from '../../../application/ports/out/KnowledgeRankingAdvicePort.out-port.js';
import type {
  DecisionReceiptJournalPort,
} from '../../../application/ports/out/DecisionReceiptJournalPort.out-port.js';
import type { BudgetedInnerReceipt } from '../BudgetedRankingAdviceAdapter.adapter.js';

const readFileAsync = promisify(readFileCb);
const FIXTURE_RESPONSE = JSON.parse(
  await readFileAsync(
    fileURLToPath(new URL('../__fixtures__/jev/jev-score-response.json', import.meta.url)),
    'utf8',
  ),
) as unknown;

const QUERY: AdviseRankingQuery = {
  projectId: 'proj-1',
  taskSummary: 'Fix the failing date parsing test in src/utils/date.ts',
  pathPrefixes: ['src/utils'],
  candidates: [
    { id: 'entry-a', claimText: 'Date strings are parsed with parseISO; never use new Date(string).' },
    { id: 'entry-b', claimText: 'The README badge links to the CI workflow.' },
  ],
};

const SECRET_QUERY: AdviseRankingQuery = {
  ...QUERY,
  candidates: [
    { id: 'entry-a', claimText: 'The token is sk-abcdefghijklmnopqrstuvwx and must not leave.' },
    { id: 'entry-b', claimText: QUERY.candidates[1].claimText },
  ],
};

interface JournalLine {
  kind: string;
  [field: string]: unknown;
}

async function newTempStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-d5a-'));
  return dir;
}

function monthFilePath(stateDir: string): string {
  const now = new Date();
  const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return join(stateDir, 'decision-receipts', `${monthKey}.jsonl`);
}

async function readJournal(stateDir: string): Promise<JournalLine[]> {
  let raw: string;
  try {
    raw = await readFile(monthFilePath(stateDir), 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as JournalLine);
}

/** Fake inner port with a configurable answer and receipt. */
class FakeInner implements KnowledgeRankingAdvicePort {
  readonly calls: AdviseRankingQuery[] = [];
  constructor(
    private readonly answer: RankingAdvice,
    public readonly lastReceipt: BudgetedInnerReceipt | null = null,
  ) {}

  async adviseRanking(req: AdviseRankingQuery): Promise<RankingAdvice> {
    this.calls.push(req);
    return this.answer;
  }
}

interface MakeDepsOverrides {
  answer?: RankingAdvice;
  receipt?: BudgetedInnerReceipt | null;
  assumedCostUsd?: number;
  monthlyBudgetUsd?: number;
  journal?: DecisionReceiptJournalPort;
  query?: AdviseRankingQuery;
}

function makeBudgeted(stateDir: string, overrides: MakeDepsOverrides = {}): {
  adapter: BudgetedRankingAdviceAdapter;
  inner: FakeInner;
} {
  const inner = new FakeInner(
    overrides.answer ?? { status: 'unknown', reason: 'transport' },
    overrides.receipt ?? null,
  );
  const adapter = new BudgetedRankingAdviceAdapter({
    inner,
    journal:
      overrides.journal ??
      new FileDecisionReceiptJournalAdapter(stateDir, () => new Date()),
    provider: 'jev',
    assumedCostUsd: overrides.assumedCostUsd ?? 0.00002,
    monthlyBudgetUsd: overrides.monthlyBudgetUsd ?? 0.01,
  });
  return { adapter, inner };
}

describe('BudgetedRankingAdviceAdapter', () => {
  it('refuses a secret-bearing claimText with no reserve line and no inner call', async () => {
    const stateDir = await newTempStateDir();
    try {
      const { adapter, inner } = makeBudgeted(stateDir, {
        query: SECRET_QUERY,
        answer: { status: 'advised', scores: { 'entry-a': 1, 'entry-b': 0 }, model: 'm', confidence: 0.9 },
        receipt: { requestId: 'r', costUsd: 0.00002, servedModel: 'm' },
      });
      const result = await adapter.adviseRanking(SECRET_QUERY);
      expect(result).toEqual({ status: 'unknown', reason: 'redaction-refused' });
      expect(inner.calls).toHaveLength(0);
      expect(await readJournal(stateDir)).toEqual([]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('refuses with unknown/budget when the budget is exhausted and never calls the inner port', async () => {
    const stateDir = await newTempStateDir();
    try {
      const { adapter, inner } = makeBudgeted(stateDir, {
        assumedCostUsd: 0.00002,
        monthlyBudgetUsd: 0.00001,
      });
      const result = await adapter.adviseRanking(QUERY);
      expect(result).toEqual({ status: 'unknown', reason: 'budget' });
      expect(inner.calls).toHaveLength(0);
      // Refused calls reserve nothing.
      expect(await readJournal(stateDir)).toEqual([]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('advised: one reserved and one settled line; settled costUsd equals the inner receipt; decidedOrder by score', async () => {
    const stateDir = await newTempStateDir();
    try {
      const { adapter } = makeBudgeted(stateDir, {
        answer: {
          status: 'advised',
          scores: { 'entry-a': 0.4, 'entry-b': 0.9 },
          model: 'jev-model-1',
          confidence: 0.9,
        },
        receipt: { requestId: 'req-1', costUsd: 0.00003, servedModel: 'jev-served-1' },
      });
      const result = await adapter.adviseRanking(QUERY);
      expect(result.status).toBe('advised');

      const lines = await readJournal(stateDir);
      expect(lines).toHaveLength(2);
      const reserved = lines[0];
      const settled = lines[1];
      expect(reserved.kind).toBe('reserved');
      const state = buildRankingAdviceState(QUERY);
      expect(state.ok).toBe(true);
      expect(reserved.stateSha256).toBe(state.ok ? state.stateSha256 : '');
      expect(settled.kind).toBe('settled');
      expect(settled.reservationId).toBe(reserved.id);
      expect(settled.provider).toBe('jev');
      expect(settled.model).toBe('jev-served-1');
      expect(settled.requestId).toBe('req-1');
      expect(settled.costUsd).toBe(0.00003);
      expect(settled.estimated).toBe(false);
      expect(settled.lexicalOrder).toEqual(['entry-a', 'entry-b']);
      expect(settled.decidedOrder).toEqual(['entry-b', 'entry-a']);
      expect(settled.unknownReason).toBeUndefined();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('inner reports no cost: settled line is estimated with the assumed cost', async () => {
    const stateDir = await newTempStateDir();
    try {
      const { adapter } = makeBudgeted(stateDir, {
        answer: {
          status: 'advised',
          scores: { 'entry-a': 0.9, 'entry-b': 0.4 },
          model: 'jev-model-1',
          confidence: 0.9,
        },
        receipt: { requestId: 'req-2', servedModel: 'jev-served-1' },
      });
      await adapter.adviseRanking(QUERY);
      const lines = await readJournal(stateDir);
      expect(lines).toHaveLength(2);
      const settled = lines[1];
      expect(settled.kind).toBe('settled');
      expect(settled.costUsd).toBe(0.00002);
      expect(settled.estimated).toBe(true);
      expect(settled.decidedOrder).toEqual(['entry-a', 'entry-b']);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('inner unknown: settled line carries the unknownReason and decidedOrder equals lexicalOrder', async () => {
    const stateDir = await newTempStateDir();
    try {
      const { adapter } = makeBudgeted(stateDir, {
        answer: { status: 'unknown', reason: 'timeout' },
        receipt: null,
      });
      const result = await adapter.adviseRanking(QUERY);
      expect(result).toEqual({ status: 'unknown', reason: 'timeout' });
      const lines = await readJournal(stateDir);
      expect(lines).toHaveLength(2);
      const settled = lines[1];
      expect(settled.unknownReason).toBe('timeout');
      expect(settled.lexicalOrder).toEqual(['entry-a', 'entry-b']);
      expect(settled.decidedOrder).toEqual(['entry-a', 'entry-b']);
      expect(settled.model).toBe('jev');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('settle failure: unknown/not-configured and the answer is not used', async () => {
    const stateDir = await newTempStateDir();
    try {
      const realJournal = new FileDecisionReceiptJournalAdapter(stateDir, () => new Date());
      const journal: DecisionReceiptJournalPort = {
        reserve: (query) => realJournal.reserve(query),
        settle: async () => {
          throw new Error('append failed');
        },
        monthSpendUsd: (month) => realJournal.monthSpendUsd(month),
      };
      const { adapter } = makeBudgeted(stateDir, {
        answer: {
          status: 'advised',
          scores: { 'entry-a': 1, 'entry-b': 0 },
          model: 'm',
          confidence: 0.9,
        },
        receipt: { requestId: 'r', costUsd: 0.00002, servedModel: 'm' },
        journal,
      });
      const result = await adapter.adviseRanking(QUERY);
      expect(result).toEqual({ status: 'unknown', reason: 'not-configured' });
      // The reservation still counts: a paid call is never invisible.
      const lines = await readJournal(stateDir);
      expect(lines).toHaveLength(1);
      expect(lines[0].kind).toBe('reserved');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe('createRankingAdvice', () => {
  function spyFetch(body: unknown): typeof fetch & { calls: unknown[] } {
    const calls: unknown[] = [];
    const fn = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch & { calls: unknown[] };
    fn.calls = calls;
    return fn;
  }

  const JEV_DECISIONS: RankingAdviceDecisions = {
    provider: 'jev',
    model: 'typesafe/jev-1.14',
    keyFile: '/keys/jev.key',
    minConfidence: 0.5,
    monthlyBudgetUsd: 0.01,
    assumedCostPerCallUsd: 0.00002,
    acknowledgeProseLeavesHost: true as const,
  };

  it("provider 'none' never calls fetch", async () => {
    const fetch = spyFetch(FIXTURE_RESPONSE);
    const port = createRankingAdvice({ decisions: { provider: 'none' }, stateDir: '/tmp', fetch });
    const result = await port.adviseRanking(QUERY);
    expect(result).toEqual({ status: 'unknown', reason: 'not-configured' });
    expect(fetch.calls).toHaveLength(0);
  });

  it('undefined decisions behave as none', async () => {
    const fetch = spyFetch(FIXTURE_RESPONSE);
    const port = createRankingAdvice({ stateDir: '/tmp', fetch });
    const result = await port.adviseRanking(QUERY);
    expect(result).toEqual({ status: 'unknown', reason: 'not-configured' });
    expect(fetch.calls).toHaveLength(0);
  });

  it('jev without a stateDir answers unknown/not-configured and fetch is never called', async () => {
    const fetch = spyFetch(FIXTURE_RESPONSE);
    const port = createRankingAdvice({ decisions: JEV_DECISIONS, fetch, readKey: async () => 'k' });
    const result = await port.adviseRanking(QUERY);
    expect(result).toEqual({ status: 'unknown', reason: 'not-configured' });
    expect(fetch.calls).toHaveLength(0);
  });

  it('jev with a stateDir and a stub fetch returning the recorded fixture is advised and receipted', async () => {
    const stateDir = await newTempStateDir();
    try {
      const fetch = spyFetch(FIXTURE_RESPONSE);
      const port = createRankingAdvice({
        decisions: JEV_DECISIONS,
        stateDir,
        fetch,
        readKey: async () => 'sk-test-key-value-not-real',
      });
      const result = await port.adviseRanking(QUERY);
      expect(result.status).toBe('advised');
      expect(fetch.calls).toHaveLength(1);

      const lines = await readJournal(stateDir);
      expect(lines).toHaveLength(2);
      expect(lines[0].kind).toBe('reserved');
      expect(lines[1].kind).toBe('settled');
      expect(lines[1].provider).toBe('jev');
      expect(lines[1].requestId).toBe('gen-fixture');
      expect(lines[1].costUsd).toBe(0.000018102);
      expect(lines[1].estimated).toBe(false);
      expect(lines[1].decidedOrder).toEqual(['entry-a', 'entry-b']);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
