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
import { buildRankingAdviceState, rankingContextRef } from '../jev-advice-state.js';
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

/** The reference QUERY's receipts carry: QUERY declares no lane. */
const QUERY_CONTEXT_REF = rankingContextRef({
  taskSummary: QUERY.taskSummary,
  candidates: QUERY.candidates,
});

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

/** Fake inner port whose adviseRanking always throws. */
class ThrowingInner implements KnowledgeRankingAdvicePort {
  readonly calls: AdviseRankingQuery[] = [];
  readonly lastReceipt: BudgetedInnerReceipt | null = null;

  async adviseRanking(req: AdviseRankingQuery): Promise<RankingAdvice> {
    this.calls.push(req);
    throw new Error('inner transport failure');
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
      expect(result).toEqual({
        status: 'unknown',
        reason: 'timeout',
        // A settled receipt names its reference: this answer's outcome joins
        // on it even though no score was applied.
        contextRef: QUERY_CONTEXT_REF,
      });
      const lines = await readJournal(stateDir);
      expect(lines).toHaveLength(2);
      const settled = lines[1];
      expect(settled.unknownReason).toBe('timeout');
      expect(settled.contextRef).toBe(QUERY_CONTEXT_REF);
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
        appendOutcome: (outcome) => realJournal.appendOutcome(outcome),
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

  it('empty requestId and servedModel in the receipt are absent: advised answer returned; settled line has no requestId, the receipt cost, estimated false', async () => {
    const stateDir = await newTempStateDir();
    try {
      const { adapter } = makeBudgeted(stateDir, {
        answer: {
          status: 'advised',
          scores: { 'entry-a': 1, 'entry-b': 0 },
          model: 'jev-model-1',
          confidence: 0.9,
        },
        // The Jev adapter reports '' when the response id or model is
        // missing or invalid; an empty requestId must never reach the
        // journal (it refuses one, so settle would throw).
        receipt: { requestId: '', servedModel: '', costUsd: 0.00001 },
      });
      const result = await adapter.adviseRanking(QUERY);
      expect(result.status).toBe('advised');

      const lines = await readJournal(stateDir);
      expect(lines).toHaveLength(2);
      const settled = lines[1];
      expect(settled.kind).toBe('settled');
      expect(settled.requestId).toBeUndefined();
      expect(settled.costUsd).toBe(0.00001);
      expect(settled.estimated).toBe(false);
      expect(settled.model).toBe('jev-model-1');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('a journal whose reserve throws: unknown/not-configured and zero inner calls', async () => {
    const stateDir = await newTempStateDir();
    try {
      const journal: DecisionReceiptJournalPort = {
        reserve: async () => {
          throw new Error('journal unavailable');
        },
        settle: async () => {
          throw new Error('journal unavailable');
        },
        monthSpendUsd: async () => 0,
        appendOutcome: async () => {
          throw new Error('journal unavailable');
        },
      };
      const { adapter, inner } = makeBudgeted(stateDir, { journal });
      const result = await adapter.adviseRanking(QUERY);
      expect(result).toEqual({ status: 'unknown', reason: 'not-configured' });
      expect(inner.calls).toHaveLength(0);
      // Nothing was made, so nothing was recorded either.
      expect(await readJournal(stateDir)).toEqual([]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('inner throws: unknown/transport and a settled line exists with unknownReason transport', async () => {
    const stateDir = await newTempStateDir();
    try {
      const adapter = new BudgetedRankingAdviceAdapter({
        inner: new ThrowingInner(),
        journal: new FileDecisionReceiptJournalAdapter(stateDir, () => new Date()),
        provider: 'jev',
        assumedCostUsd: 0.00002,
        monthlyBudgetUsd: 0.01,
      });
      const result = await adapter.adviseRanking(QUERY);
      expect(result).toEqual({
        status: 'unknown',
        reason: 'transport',
        contextRef: QUERY_CONTEXT_REF,
      });

      const lines = await readJournal(stateDir);
      expect(lines).toHaveLength(2);
      expect(lines[0].kind).toBe('reserved');
      const settled = lines[1];
      expect(settled.kind).toBe('settled');
      expect(settled.unknownReason).toBe('transport');
      expect(settled.contextRef).toBe(QUERY_CONTEXT_REF);
      expect(settled.lexicalOrder).toEqual(['entry-a', 'entry-b']);
      expect(settled.decidedOrder).toEqual(['entry-a', 'entry-b']);
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

  const JEV_DECISIONS = {
    provider: 'jev',
    model: 'typesafe/jev-1.14',
    keyFile: '/keys/jev.key',
    minConfidence: 0.5,
    monthlyBudgetUsd: 0.01,
    assumedCostPerCallUsd: 0.00002,
    acknowledgeProseLeavesHost: true as const,
  } satisfies RankingAdviceDecisions;

  it("provider 'none' never calls fetch", async () => {
    const stateDir = await newTempStateDir();
    try {
      const fetch = spyFetch(FIXTURE_RESPONSE);
      const port = createRankingAdvice({ decisions: { provider: 'none' }, stateDir, fetch });
      const result = await port.adviseRanking(QUERY);
      expect(result).toEqual({ status: 'unknown', reason: 'not-configured' });
      expect(fetch.calls).toHaveLength(0);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('undefined decisions behave as none', async () => {
    const stateDir = await newTempStateDir();
    try {
      const fetch = spyFetch(FIXTURE_RESPONSE);
      const port = createRankingAdvice({ stateDir, fetch });
      const result = await port.adviseRanking(QUERY);
      expect(result).toEqual({ status: 'unknown', reason: 'not-configured' });
      expect(fetch.calls).toHaveLength(0);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
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

  it('the month file text contains neither the claimText, the taskSummary nor the key string', async () => {
    const stateDir = await newTempStateDir();
    try {
      const key = 'sk-d5a-privacy-check-key-not-real';
      const fetch = spyFetch(FIXTURE_RESPONSE);
      const port = createRankingAdvice({
        decisions: JEV_DECISIONS,
        stateDir,
        fetch,
        readKey: async () => key,
      });
      const result = await port.adviseRanking(QUERY);
      expect(result.status).toBe('advised');

      const raw = await readFile(monthFilePath(stateDir), 'utf8');
      expect(raw).not.toContain(QUERY.candidates[0].claimText);
      expect(raw).not.toContain(QUERY.candidates[1].claimText);
      expect(raw).not.toContain(QUERY.taskSummary);
      expect(raw).not.toContain(key);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("answer-file without a stateDir answers unknown/not-configured and the injected reader is never called", async () => {
    let readerCalls = 0;
    const readAnswerFile = async (): Promise<string> => {
      readerCalls += 1;
      return '{}';
    };
    const port = createRankingAdvice({
      decisions: { provider: 'answer-file', answerFile: '/answers/recorded.json' },
      readAnswerFile,
    });
    const result = await port.adviseRanking(QUERY);
    expect(result).toEqual({ status: 'unknown', reason: 'not-configured' });
    expect(readerCalls).toBe(0);
  });

  it('answer-file with a stateDir and a fixture-shaped answer for the state hash is advised; settled line provider answer-file, costUsd 0, estimated true', async () => {
    const stateDir = await newTempStateDir();
    try {
      const state = buildRankingAdviceState(QUERY);
      expect(state.ok).toBe(true);
      const stateSha256 = state.ok ? state.stateSha256 : '';
      const readAnswerFile = async (): Promise<string> =>
        JSON.stringify({ [stateSha256]: FIXTURE_RESPONSE });
      const port = createRankingAdvice({
        decisions: { provider: 'answer-file', answerFile: '/answers/recorded.json' },
        stateDir,
        readAnswerFile,
      });
      const result = await port.adviseRanking(QUERY);
      expect(result.status).toBe('advised');

      const lines = await readJournal(stateDir);
      expect(lines).toHaveLength(2);
      expect(lines[0].kind).toBe('reserved');
      const settled = lines[1];
      expect(settled.kind).toBe('settled');
      expect(settled.provider).toBe('answer-file');
      expect(settled.costUsd).toBe(0);
      expect(settled.estimated).toBe(true);
      expect(settled.decidedOrder).toEqual(['entry-a', 'entry-b']);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("jev with the query's project disabled: zero fetch calls", async () => {
    const stateDir = await newTempStateDir();
    try {
      const fetch = spyFetch(FIXTURE_RESPONSE);
      const decisions: RankingAdviceDecisions = {
        ...JEV_DECISIONS,
        disabledProjects: ['proj-1'],
      };
      const port = createRankingAdvice({
        decisions,
        stateDir,
        fetch,
        readKey: async () => 'sk-test-key-value-not-real',
      });
      const result = await port.adviseRanking(QUERY);
      expect(result).toEqual({
        status: 'unknown',
        reason: 'not-configured',
        // The inner port never ran, but the reservation was still settled, so
        // the reference names the ranking this project never got advice for.
        contextRef: QUERY_CONTEXT_REF,
      });
      expect(fetch.calls).toHaveLength(0);

      // The reserve happened and the unknown inner answer was still settled.
      const lines = await readJournal(stateDir);
      expect(lines).toHaveLength(2);
      expect(lines[1].kind).toBe('settled');
      expect(lines[1].contextRef).toBe(QUERY_CONTEXT_REF);
      expect(lines[1].unknownReason).toBe('not-configured');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('minConfidence 0.95 with the recorded fixture (confidence 0.91): unknown/low-confidence, settled line with the fixture cost; readKey receives the keyFile path', async () => {
    const stateDir = await newTempStateDir();
    try {
      const fetch = spyFetch(FIXTURE_RESPONSE);
      const readKeyPaths: string[] = [];
      const decisions: RankingAdviceDecisions = { ...JEV_DECISIONS, minConfidence: 0.95 };
      const port = createRankingAdvice({
        decisions,
        stateDir,
        fetch,
        readKey: async (path) => {
          readKeyPaths.push(path);
          return 'sk-test-key-value-not-real';
        },
      });
      const result = await port.adviseRanking(QUERY);
      expect(result).toEqual({
        status: 'unknown',
        reason: 'low-confidence',
        contextRef: QUERY_CONTEXT_REF,
      });
      expect(readKeyPaths).toEqual([JEV_DECISIONS.keyFile]);

      const lines = await readJournal(stateDir);
      expect(lines).toHaveLength(2);
      const settled = lines[1];
      expect(settled.kind).toBe('settled');
      expect(settled.costUsd).toBe(0.000018102);
      expect(settled.estimated).toBe(false);
      expect(settled.contextRef).toBe(QUERY_CONTEXT_REF);
      expect(settled.unknownReason).toBe('low-confidence');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("a stricter consumer minConfidence gates the answer the block's threshold would accept", async () => {
    const stateDir = await newTempStateDir();
    try {
      // The same served answers, one notch less confident: 0.87 clears the
      // block's 0.5 but not a consumer's 0.9.
      const served = JSON.parse(JSON.stringify(FIXTURE_RESPONSE)) as {
        answers: Record<string, { confidence: number }>;
      };
      served.answers.k0!.confidence = 0.87;
      served.answers.k1!.confidence = 0.87;

      const withoutConsumer = createRankingAdvice({
        decisions: JEV_DECISIONS,
        stateDir,
        fetch: spyFetch(served),
        readKey: async () => 'sk-test-key-value-not-real',
      });
      const advised = await withoutConsumer.adviseRanking(QUERY);
      expect(advised.status).toBe('advised');
      if (advised.status === 'advised') {
        expect(advised.confidence).toBe(0.87);
      }

      const withConsumer = createRankingAdvice({
        decisions: {
          ...JEV_DECISIONS,
          consumers: { 'knowledge-ranking': { minConfidence: 0.9 } },
        },
        stateDir,
        fetch: spyFetch(served),
        readKey: async () => 'sk-test-key-value-not-real',
      });
      const answered = await withConsumer.adviseRanking(QUERY);
      expect(answered.status).toBe('unknown');
      if (answered.status !== 'unknown') {
        throw new Error('expected the consumer threshold to refuse the answer');
      }
      expect(answered.reason).toBe('low-confidence');
      expect(answered.contextRef).toBe(QUERY_CONTEXT_REF);

      // The refused answer is still receipted: the call was paid.
      const settled = (await readJournal(stateDir)).filter((line) => line.kind === 'settled');
      expect(settled).toHaveLength(2);
      expect(settled[1]?.unknownReason).toBe('low-confidence');
      expect(settled[1]?.minConfidenceObserved).toBeUndefined();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("a consumer minConfidence equal to the block's changes nothing", async () => {
    const stateDir = await newTempStateDir();
    try {
      const port = createRankingAdvice({
        decisions: {
          ...JEV_DECISIONS,
          consumers: { 'knowledge-ranking': { minConfidence: 0.5, monthlyBudgetUsd: 0.01 } },
        },
        stateDir,
        fetch: spyFetch(FIXTURE_RESPONSE),
        readKey: async () => 'sk-test-key-value-not-real',
      });
      const result = await port.adviseRanking(QUERY);
      expect(result.status).toBe('advised');
      // The declared sub-budget is enforced alongside the threshold.
      const lines = await readJournal(stateDir);
      expect(lines.filter((line) => line.kind === 'settled')).toHaveLength(1);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
