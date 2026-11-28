import { describe, expect, it } from 'vitest';

import {
  MAX_PERMISSIONS,
  MAX_QUESTIONS,
  MAX_RESPONSE_BYTES,
  createTuiApiClient,
  exchangeSessionToken,
} from './api.js';

const BASE = 'http://api.test';
const TOKEN = 'tok-in-memory';

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function fakeFetch(
  status: number,
  body: unknown,
  calls: Call[] = [],
): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { status, text: async () => text } as unknown as Response;
  }) as unknown as typeof fetch;
}

const question = (over: Record<string, unknown> = {}) => ({
  questionId: 'q-1',
  revision: 2,
  title: 'Pick one',
  body: 'Body text',
  options: [{ id: 'o-1', label: 'One', consequence: 'does one' }],
  recommendation: { optionId: 'o-1', because: 'it is simplest' },
  doorKind: 'two-way',
  state: 'open',
  ...over,
});

const okQuestions = (questions: unknown[]) => ({ operationId: 'op', code: 'OK', result: { questions } });
const client = (fetchImpl: typeof fetch, token: string | null = TOKEN, extra: object = {}) =>
  createTuiApiClient({ baseUrl: BASE, ...(token === null ? {} : { token }), fetchImpl, ...extra });

describe('createTuiApiClient', () => {
  it('lists open questions with a bearer header and never a token in the URL', async () => {
    const calls: Call[] = [];
    const result = await client(fakeFetch(200, okQuestions([question()]), calls)).listOpenQuestions();
    expect(result).toMatchObject({ ok: true, truncated: false });
    expect(result.ok && result.questions[0].questionId).toBe('q-1');
    expect(calls[0].url).toBe(`${BASE}/v1/questions?state=open`);
    expect(calls[0].url).not.toContain(TOKEN);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('refuses when baseUrl is empty', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return {} as Response;
    }) as unknown as typeof fetch;
    const api = createTuiApiClient({ baseUrl: '   ', token: TOKEN, fetchImpl });
    expect(await api.listOpenQuestions()).toEqual({ ok: false, reason: 'api-not-configured' });
    expect(await api.listPendingPermissions('t')).toEqual({ ok: false, reason: 'api-not-configured' });
    expect(called).toBe(false);
  });

  it('refuses write and verdict calls when token is missing', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return {} as Response;
    }) as unknown as typeof fetch;
    const api = client(fetchImpl, null);
    expect(await api.answerQuestion({ questionId: 'q', questionRevision: 1, shape: 'accept' })).toEqual({ ok: false, reason: 'missing-token' });
    expect(await api.givePermissionVerdict('t', 'r', 'allow')).toEqual({ ok: false, reason: 'missing-token' });
    expect(await client(fetchImpl, '').listOpenQuestions()).toEqual({ ok: false, reason: 'missing-token' });
    expect(called).toBe(false);
  });

  it('returns request-timeout when fetch aborts', async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })) as unknown as typeof fetch;
    const result = await client(fetchImpl, TOKEN, { timeoutMs: 10 }).listOpenQuestions();
    expect(result).toEqual({ ok: false, reason: 'request-timeout' });
  });

  it('returns network-error when fetch rejects', async () => {
    const fetchImpl = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;
    expect(await client(fetchImpl).listOpenQuestions()).toEqual({ ok: false, reason: 'network-error' });
  });

  it('returns invalid-response on empty or non-JSON body', async () => {
    expect(await client(fakeFetch(200, '')).listOpenQuestions()).toEqual({ ok: false, reason: 'invalid-response' });
    expect(await client(fakeFetch(200, '<html>')).listOpenQuestions()).toEqual({ ok: false, reason: 'invalid-response' });
  });

  it('refuses responses exceeding MAX_RESPONSE_BYTES', async () => {
    const big = JSON.stringify(okQuestions([question({ body: 'x'.repeat(10) })])) + ' '.repeat(MAX_RESPONSE_BYTES);
    expect(await client(fakeFetch(200, big)).listOpenQuestions()).toEqual({ ok: false, reason: 'response-too-large' });
  });

  it('does not buffer a streamed body past MAX_RESPONSE_BYTES', async () => {
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(65_536));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = (async () => ({ status: 200, body: stream, text: async () => 'unused' }) as unknown as Response) as unknown as typeof fetch;
    expect(await client(fetchImpl).listOpenQuestions()).toEqual({ ok: false, reason: 'response-too-large' });
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
  });

  it('refuses non-object envelopes and a response whose status getter throws', async () => {
    for (const body of ['null', '42', '"text"', '[]', JSON.stringify({ code: 'NOPE', result: {} }), JSON.stringify({ code: 'OK', result: null })]) {
      expect(await client(fakeFetch(200, body)).listOpenQuestions()).toEqual({ ok: false, reason: 'malformed-envelope' });
    }
    const hostile = (async () =>
      ({
        get status(): number {
          throw new Error('getter ran');
        },
        text: async () => '{}',
      }) as unknown as Response) as unknown as typeof fetch;
    expect(await client(hostile).listOpenQuestions()).toEqual({ ok: false, reason: 'malformed-envelope' });
  });

  it('refuses non-array questions or requests', async () => {
    expect(await client(fakeFetch(200, { code: 'OK', result: { questions: {} } })).listOpenQuestions()).toEqual({ ok: false, reason: 'malformed-list' });
    expect(await client(fakeFetch(200, { code: 'OK', result: { requests: 'x' } })).listPendingPermissions('t')).toEqual({ ok: false, reason: 'malformed-list' });
    expect(await client(fakeFetch(200, okQuestions([question({ doorKind: 'both' })]))).listOpenQuestions()).toEqual({ ok: false, reason: 'malformed-list' });
    expect(await client(fakeFetch(200, okQuestions([null]))).listOpenQuestions()).toEqual({ ok: false, reason: 'malformed-list' });
  });

  it('caps lists at the limit and says so', async () => {
    const many = Array.from({ length: MAX_QUESTIONS + 5 }, (_v, i) => question({ questionId: `q-${i}` }));
    const questions = await client(fakeFetch(200, okQuestions(many))).listOpenQuestions();
    expect(questions.ok && questions.questions.length).toBe(MAX_QUESTIONS);
    expect(questions.ok && questions.truncated).toBe(true);
    const reqs = Array.from({ length: MAX_PERMISSIONS + 1 }, (_v, i) => ({ requestId: `r-${i}`, toolCode: 'tool', deadlineAt: '2026-11-03T10:00:00.000Z' }));
    const perms = await client(fakeFetch(200, { code: 'OK', result: { requests: reqs } })).listPendingPermissions('t');
    expect(perms.ok && perms.requests.length).toBe(MAX_PERMISSIONS);
    expect(perms.ok && perms.truncated).toBe(true);
  });

  it('maps HTTP error statuses to typed refusals', async () => {
    const cases: ReadonlyArray<readonly [number, unknown, string]> = [
      [403, { code: 'FORBIDDEN', result: { reason: 'no scope' } }, 'forbidden'],
      [404, { code: 'NOT_FOUND', result: null }, 'not-found'],
      [409, { code: 'EXPIRED', result: null }, 'expired'],
      [422, { code: 'REFUSED', result: { reason: 'stale revision' } }, 'stale revision'],
      [400, { code: 'REFUSED', result: null }, 'refused'],
      [500, { code: 'INTERNAL_ERROR', result: null }, 'server-error'],
      [501, { code: 'NOT_IMPLEMENTED', result: null }, 'not-implemented'],
      [503, { code: 'STORE_UNAVAILABLE', result: null }, 'store-unavailable'],
      [418, {}, 'unexpected-status'],
    ];
    for (const [status, body, reason] of cases) {
      expect(await client(fakeFetch(status, body)).answerQuestion({ questionId: 'q', questionRevision: 1, shape: 'accept' })).toEqual({ ok: false, reason });
    }
  });

  it('posts an answer with the revision and reports a replay', async () => {
    const calls: Call[] = [];
    const result = await client(fakeFetch(200, { code: 'OK', result: { outcome: 'answered', replayed: true } }, calls)).answerQuestion({
      questionId: 'q/1',
      questionRevision: 3,
      shape: 'answer',
      optionId: 'o-1',
      text: 'because',
    });
    expect(result).toEqual({ ok: true, outcome: 'answered', replayed: true });
    expect(calls[0].url).toBe(`${BASE}/v1/questions/q%2F1/answers`);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ questionRevision: 3, shape: 'answer', optionId: 'o-1', text: 'because' });
  });

  it('refuses ids that cannot be URL-encoded and answers without a boolean replayed flag', async () => {
    let called = false;
    const spy = (async () => {
      called = true;
      return {} as Response;
    }) as unknown as typeof fetch;
    const api = client(spy);
    expect(await api.answerQuestion({ questionId: '\ud800', questionRevision: 1, shape: 'accept' })).toEqual({ ok: false, reason: 'invalid-id' });
    expect(await api.listPendingPermissions('\ud800')).toEqual({ ok: false, reason: 'invalid-id' });
    expect(await api.givePermissionVerdict('t', '\ud800', 'allow')).toEqual({ ok: false, reason: 'invalid-id' });
    expect(called).toBe(false);
    const noFlag = await client(fakeFetch(200, { code: 'OK', result: { outcome: 'answered' } })).answerQuestion({ questionId: 'q', questionRevision: 1, shape: 'accept' });
    expect(noFlag).toEqual({ ok: false, reason: 'malformed-envelope' });
  });

  it('lists pending permissions and carries the first verdict of a 409 conflict', async () => {
    const perms = await client(fakeFetch(200, { code: 'OK', result: { requests: [{ requestId: 'r-1', toolCode: 'edit', deadlineAt: '2026-11-03T10:30:00.000Z' }] } })).listPendingPermissions('th-1');
    expect(perms.ok && perms.requests[0].requestId).toBe('r-1');
    const conflict = await client(fakeFetch(409, { code: 'OK', result: { requestId: 'r-1', decision: 'allow' } })).givePermissionVerdict('th-1', 'r-1', 'deny');
    expect(conflict).toEqual({ ok: true, decision: 'allow', conflict: true });
    const first = await client(fakeFetch(200, { code: 'OK', result: { requestId: 'r-1', decision: 'deny' } })).givePermissionVerdict('th-1', 'r-1', 'deny');
    expect(first).toEqual({ ok: true, decision: 'deny', conflict: false });
  });
});

describe('exchangeSessionToken', () => {
  it('returns the in-memory token with the header and no token in the URL', async () => {
    const calls: Call[] = [];
    const result = await exchangeSessionToken(BASE, 'secret-1', ['read'], {
      fetchImpl: fakeFetch(200, { token: 'minted', scopes: ['read'] }, calls),
    });
    expect(result).toEqual({ ok: true, token: 'minted', scopes: ['read'] });
    expect(calls[0].url).toBe(`${BASE}/sessions/exchange`);
    expect((calls[0].init.headers as Record<string, string>)['x-fleet-session-exchange']).toBe('secret-1');
  });

  it('returns refusal when session exchange returns 403', async () => {
    for (const [status, body] of [[403, { error: 'Forbidden' }], [415, {}], [200, { scopes: ['read'] }]] as const) {
      expect(await exchangeSessionToken(BASE, 's', ['read'], { fetchImpl: fakeFetch(status, body) })).toEqual({ ok: false, reason: 'session-exchange-refused' });
    }
    const down = (async () => {
      throw new Error('down');
    }) as unknown as typeof fetch;
    expect(await exchangeSessionToken(BASE, 's', ['read'], { fetchImpl: down })).toEqual({ ok: false, reason: 'session-exchange-refused' });
    expect(await exchangeSessionToken('', 's', ['read'])).toEqual({ ok: false, reason: 'api-not-configured' });
  });
});
