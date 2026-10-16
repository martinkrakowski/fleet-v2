// Lane D2 tests: JevRankingAdviceAdapter, AnswerFileRankingAdviceAdapter and
// readKeyFile. No real network: fetch is always a spy or a failing stub.
import { beforeAll, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { readFile as readFileCb } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { JevRankingAdviceAdapter } from '../JevRankingAdviceAdapter.adapter.js';
import { AnswerFileRankingAdviceAdapter } from '../AnswerFileRankingAdviceAdapter.adapter.js';
import { readKeyFile } from '../JevRankingAdviceAdapter.adapter.js';
import { buildRankingAdviceState } from '../jev-advice-state.js';
import type { RankingAdvice } from '../../../application/ports/out/KnowledgeRankingAdvicePort.out-port.js';

const readFileAsync = promisify(readFileCb);
const FIXTURE_RESPONSE = JSON.parse(
  await readFileAsync(
    fileURLToPath(new URL('../__fixtures__/jev/jev-score-response.json', import.meta.url)),
    'utf8',
  ),
) as unknown;

const QUERY = {
  projectId: 'proj-1',
  taskSummary: 'Fix the failing date parsing test in src/utils/date.ts',
  pathPrefixes: ['src/utils'],
  candidates: [
    { id: 'entry-a', claimText: 'Date strings are parsed with parseISO; never use new Date(string).' },
    { id: 'entry-b', claimText: 'The README badge links to the CI workflow.' },
  ],
} as const;

const KEY_TEXT = 'sk-test-key-value-not-real';
const okFetch = (): typeof fetch => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (_url: unknown, init?: RequestInit) => {
    calls.push({ url: String(_url), init: init ?? {} });
    return new Response(JSON.stringify(FIXTURE_RESPONSE), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  (fn as unknown as { calls: unknown }).calls = calls;
  return fn;
};

function responseFor(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

describe('JevRankingAdviceAdapter', () => {
  function makeAdapter(overrides?: {
    fetch?: typeof fetch;
    disabledProjects?: string[];
    minConfidence?: number;
    timeoutMs?: number;
  }): JevRankingAdviceAdapter {
    return new JevRankingAdviceAdapter({
      model: 'typesafe/jev-1.14',
      keyFile: '/keys/jev.key',
      minConfidence: overrides?.minConfidence ?? 0.5,
      disabledProjects: overrides?.disabledProjects,
      fetch: overrides?.fetch ?? okFetch(),
      readKey: async () => KEY_TEXT,
      timeoutMs: overrides?.timeoutMs,
    });
  }

  it('advises from the recorded fixture with k0 above k1 and records a receipt', async () => {
    const adapter = makeAdapter();
    const result = await adapter.adviseRanking(QUERY);
    expect(result.status).toBe('advised');
    if (result.status !== 'advised') return;
    expect(result.scores['entry-a']).toBeGreaterThan(result.scores['entry-b']);
    expect(result.model).toBe('typesafe/jev-1.14-20261014');
    expect(result.confidence).toBe(0.91);

    const receipt = adapter.lastReceipt;
    expect(receipt).not.toBeNull();
    expect(receipt?.requestId).toBe('gen-fixture');
    expect(receipt?.costUsd).toBeCloseTo(0.000018102, 12);
    expect(receipt?.servedModel).toBe('typesafe/jev-1.14-20261014');
    const expectedSha = buildRankingAdviceState(QUERY);
    expect(receipt?.stateSha256).toBe(expectedSha.ok ? expectedSha.stateSha256 : '');
  });

  it('sends the key only in the Authorization header and bodies never leak into results', async () => {
    const fetchFn = okFetch();
    const adapter = makeAdapter({ fetch: fetchFn });
    const result: RankingAdvice = await adapter.adviseRanking(QUERY);
    const calls = (fetchFn as unknown as { calls: Array<{ init: RequestInit }> }).calls;
    expect(calls).toHaveLength(1);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY_TEXT}`);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(KEY_TEXT);
    expect(serialized).not.toContain(QUERY.taskSummary);
  });

  it('refuses a secret-pattern taskSummary with zero fetch calls', async () => {
    const fetchFn = okFetch();
    const adapter = makeAdapter({ fetch: fetchFn });
    const result = await adapter.adviseRanking({
      ...QUERY,
      taskSummary: 'rotate the token sk-abcdefghijklmnopqrstuvwx today',
    });
    expect(result).toEqual({ status: 'unknown', reason: 'redaction-refused' });
    expect((fetchFn as unknown as { calls: unknown[] }).calls).toHaveLength(0);
  });

  it('refuses an over-cap state with zero fetch calls', async () => {
    const fetchFn = okFetch();
    const adapter = makeAdapter({ fetch: fetchFn });
    const result = await adapter.adviseRanking({
      ...QUERY,
      taskSummary: 'x'.repeat(8 * 1024 + 1),
    });
    expect(result).toEqual({ status: 'unknown', reason: 'redaction-refused' });
    expect((fetchFn as unknown as { calls: unknown[] }).calls).toHaveLength(0);
  });

  it('answers not-configured for a disabled project with zero fetch calls', async () => {
    const fetchFn = okFetch();
    const adapter = makeAdapter({ fetch: fetchFn, disabledProjects: ['proj-1'] });
    const result = await adapter.adviseRanking(QUERY);
    expect(result).toEqual({ status: 'unknown', reason: 'not-configured' });
    expect((fetchFn as unknown as { calls: unknown[] }).calls).toHaveLength(0);
  });

  it('answers timeout when the abort signal fires', async () => {
    const hangingFetch = (async (_url: unknown, init?: RequestInit) => {
      return await new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }) as typeof fetch;
    const adapter = makeAdapter({ fetch: hangingFetch, timeoutMs: 20 });
    const result = await adapter.adviseRanking(QUERY);
    expect(result).toEqual({ status: 'unknown', reason: 'timeout' });
  });

  it('answers transport on a non-2xx status without exposing the body', async () => {
    const fetchFn = (async () => responseFor('{"error":"secret details"}', 500)) as typeof fetch;
    const adapter = makeAdapter({ fetch: fetchFn });
    const result = await adapter.adviseRanking(QUERY);
    expect(result).toEqual({ status: 'unknown', reason: 'transport' });
    expect(JSON.stringify(result)).not.toContain('secret details');
  });

  it('answers transport when fetch rejects', async () => {
    const fetchFn = (async () => {
      throw new Error('connection refused');
    }) as typeof fetch;
    const adapter = makeAdapter({ fetch: fetchFn });
    const result = await adapter.adviseRanking(QUERY);
    expect(result).toEqual({ status: 'unknown', reason: 'transport' });
  });

  it('answers shape for unparsable JSON, an over-64-KiB body and a missing key', async () => {
    const notJson = makeAdapter({ fetch: (async () => responseFor('<html>bad</html>')) as typeof fetch });
    expect(await notJson.adviseRanking(QUERY)).toEqual({ status: 'unknown', reason: 'shape' });

    const huge = makeAdapter({
      fetch: (async () => responseFor('"' + 'y'.repeat(64 * 1024 + 1) + '"')) as typeof fetch,
    });
    expect(await huge.adviseRanking(QUERY)).toEqual({ status: 'unknown', reason: 'shape' });

    const missingKey = makeAdapter({
      fetch: (async () => responseFor({ model: 'm', answers: {} })) as typeof fetch,
    });
    expect(await missingKey.adviseRanking(QUERY)).toEqual({ status: 'unknown', reason: 'shape' });
  });

  it('answers low-confidence when the served confidence is below minConfidence', async () => {
    const lowConfidence = JSON.parse(JSON.stringify(FIXTURE_RESPONSE)) as {
      answers: Record<string, { confidence: number }>;
    };
    lowConfidence.answers.k0.confidence = 0.2;
    const adapter = makeAdapter({
      fetch: (async () => responseFor(lowConfidence)) as typeof fetch,
      minConfidence: 0.5,
    });
    const result = await adapter.adviseRanking(QUERY);
    expect(result).toEqual({ status: 'unknown', reason: 'low-confidence' });
    expect(adapter.lastReceipt).toBeNull();
  });

  it('answers not-configured when the key cannot be read', async () => {
    const fetchFn = okFetch();
    const adapter = new JevRankingAdviceAdapter({
      model: 'typesafe/jev-1.14',
      keyFile: '/keys/jev.key',
      minConfidence: 0.5,
      fetch: fetchFn,
      readKey: async () => {
        throw new Error('Decision key file inaccessible');
      },
    });
    const result = await adapter.adviseRanking(QUERY);
    expect(result).toEqual({ status: 'unknown', reason: 'not-configured' });
    expect((fetchFn as unknown as { calls: unknown[] }).calls).toHaveLength(0);
  });
});

describe('readKeyFile', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fleet-jev-key-'));
  });

  it('returns the trimmed key for a mode-600 regular file', async () => {
    const path = join(dir, 'good.key');
    await writeFile(path, `  ${KEY_TEXT}  \n`, { mode: 0o600 });
    await chmod(path, 0o600);
    await expect(readKeyFile(path)).resolves.toBe(KEY_TEXT);
  });

  it('rejects mode 0644 and never includes the key in the error', async () => {
    const path = join(dir, 'loose.key');
    await writeFile(path, KEY_TEXT);
    await chmod(path, 0o644);
    await expect(readKeyFile(path)).rejects.toThrow(/invalid mode/);
    let message = '';
    try {
      await readKeyFile(path);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(KEY_TEXT);
  });

  it('rejects a symlink', async () => {
    const target = join(dir, 'target.key');
    await writeFile(target, KEY_TEXT, { mode: 0o600 });
    await chmod(target, 0o600);
    const link = join(dir, 'link.key');
    await symlink(target, link);
    await expect(readKeyFile(link)).rejects.toThrow(/not a symlink/);
  });

  it('rejects an empty key file', async () => {
    const path = join(dir, 'empty.key');
    await writeFile(path, '   \n', { mode: 0o600 });
    await chmod(path, 0o600);
    await expect(readKeyFile(path)).rejects.toThrow(/empty/);
  });
});

describe('AnswerFileRankingAdviceAdapter', () => {
  function stateSha(): string {
    const state = buildRankingAdviceState(QUERY);
    if (!state.ok) throw new Error('state unexpectedly refused');
    return state.stateSha256;
  }

  function readerFor(content: string | null): (path: string, encoding: 'utf8') => Promise<string> {
    return async (path) => {
      if (content === null) {
        const error = Object.assign(new Error(`ENOENT: no such file ${path}`), { code: 'ENOENT' });
        throw error;
      }
      return content;
    };
  }

  it('advises from a recorded entry keyed by the state digest', async () => {
    const map = JSON.stringify({ [stateSha()]: FIXTURE_RESPONSE });
    const adapter = new AnswerFileRankingAdviceAdapter('/answers.json', readerFor(map), 0.5);
    const result = await adapter.adviseRanking(QUERY);
    expect(result.status).toBe('advised');
    if (result.status !== 'advised') return;
    expect(result.scores['entry-a']).toBeGreaterThan(result.scores['entry-b']);
    expect(result.model).toBe('typesafe/jev-1.14-20261014');
  });

  it('answers not-configured for a missing file', async () => {
    const adapter = new AnswerFileRankingAdviceAdapter('/answers.json', readerFor(null));
    expect(await adapter.adviseRanking(QUERY)).toEqual({
      status: 'unknown',
      reason: 'not-configured',
    });
  });

  it('answers not-configured when no entry matches the state digest', async () => {
    const adapter = new AnswerFileRankingAdviceAdapter(
      '/answers.json',
      readerFor(JSON.stringify({ ['0'.repeat(64)]: FIXTURE_RESPONSE })),
    );
    expect(await adapter.adviseRanking(QUERY)).toEqual({
      status: 'unknown',
      reason: 'not-configured',
    });
  });

  it('answers shape for unparsable or non-map file content', async () => {
    const unparsable = new AnswerFileRankingAdviceAdapter('/answers.json', readerFor('{nope'));
    expect(await unparsable.adviseRanking(QUERY)).toEqual({ status: 'unknown', reason: 'shape' });

    const array = new AnswerFileRankingAdviceAdapter('/answers.json', readerFor('[]'));
    expect(await array.adviseRanking(QUERY)).toEqual({ status: 'unknown', reason: 'shape' });
  });

  it('answers shape for a malformed recorded entry', async () => {
    const broken = JSON.parse(JSON.stringify(FIXTURE_RESPONSE)) as {
      answers: Record<string, Record<string, unknown>>;
    };
    delete broken.answers.k1;
    const adapter = new AnswerFileRankingAdviceAdapter(
      '/answers.json',
      readerFor(JSON.stringify({ [stateSha()]: broken })),
    );
    expect(await adapter.adviseRanking(QUERY)).toEqual({ status: 'unknown', reason: 'shape' });
  });

  it('answers low-confidence through the same validator', async () => {
    const low = JSON.parse(JSON.stringify(FIXTURE_RESPONSE)) as {
      answers: Record<string, { confidence: number }>;
    };
    low.answers.k1.confidence = 0.1;
    const adapter = new AnswerFileRankingAdviceAdapter(
      '/answers.json',
      readerFor(JSON.stringify({ [stateSha()]: low })),
      0.5,
    );
    expect(await adapter.adviseRanking(QUERY)).toEqual({
      status: 'unknown',
      reason: 'low-confidence',
    });
  });

  it('never includes the key file text in any answer', async () => {
    const map = JSON.stringify({ [stateSha()]: FIXTURE_RESPONSE });
    const adapter = new AnswerFileRankingAdviceAdapter('/answers.json', readerFor(map));
    const result = await adapter.adviseRanking(QUERY);
    expect(JSON.stringify(result)).not.toContain(KEY_TEXT);
    expect(JSON.stringify(result)).not.toContain(QUERY.taskSummary);
  });
});
