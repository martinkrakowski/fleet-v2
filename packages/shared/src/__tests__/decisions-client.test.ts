// Lane DT-V1 tests: the Jev decision client in @fleet/shared, one per rule.
// No real network: fetch is always a stub or a spy.

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { postJevDecision } from '../decisions/client.js';
import type { JevDecisionClientRequest } from '../decisions/client.js';

const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
const KEY = 'sk-test-key-not-real';

function makeResponse(
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> },
): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, {
    status: init?.status ?? 200,
    headers: init?.headers ?? { 'content-type': 'application/json' },
  });
}

function request(overrides?: Partial<JevDecisionClientRequest>): JevDecisionClientRequest {
  return {
    fetch: (async () => makeResponse({ id: 'gen-fixture', model: 'm1', usage: { cost: 0.001 } })) as typeof fetch,
    key: KEY,
    model: 'typesafe/jev-1.14',
    stateJson: '{"taskSummary":"t"}',
    questions: { k0: { type: 'score', instructions: 'i', criteria: ['low', 'high'] } },
    stateSha256: 'sha256-hex',
    ...overrides,
  };
}

describe('postJevDecision transport taxonomy (rule 3)', () => {
  it('maps a non-2xx response to transport without touching the body', async () => {
    const result = await postJevDecision(
      request({
        fetch: (async () => makeResponse('{"error":"secret details"}', { status: 500 })) as typeof fetch,
      }),
    );
    expect(result).toEqual({ ok: false, reason: 'transport' });
    expect(JSON.stringify(result)).not.toContain('secret details');
  });

  it('maps an aborting fetch to timeout', async () => {
    const hangingFetch = (async (_url: unknown, init?: RequestInit) => {
      return await new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    }) as typeof fetch;
    const result = await postJevDecision(request({ fetch: hangingFetch, timeoutMs: 20 }));
    expect(result).toEqual({ ok: false, reason: 'timeout' });
  });

  it('refuses an over-cap content-length header without reading the body', async () => {
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull() {
          reads += 1;
          throw new Error('body must not be read when content-length is over the cap');
        },
      },
      { highWaterMark: 0 },
    );
    const response = {
      ok: true,
      headers: new Headers({ 'content-length': '100000' }),
      body: stream,
    } as unknown as Response;
    const result = await postJevDecision(
      request({ fetch: (async () => response) as typeof fetch }),
    );
    expect(result).toEqual({ ok: false, reason: 'shape' });
    expect(reads).toBe(0);
  });

  it('refuses a body over 64 KiB by accumulated bytes', async () => {
    const result = await postJevDecision(
      request({
        fetch: (async () => makeResponse('"' + 'y'.repeat(64 * 1024 + 1) + '"')) as typeof fetch,
      }),
    );
    expect(result).toEqual({ ok: false, reason: 'shape' });
  });

  it('maps an unparsable body to shape', async () => {
    const result = await postJevDecision(
      request({ fetch: (async () => makeResponse('<html>bad</html>')) as typeof fetch }),
    );
    expect(result).toEqual({ ok: false, reason: 'shape' });
  });

  it('resolves timeout when the body stream stalls past the deadline', async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        // Enqueue nothing: the body never closes on its own.
      },
    });
    const hangingFetch = (async (_url: unknown, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => {
        streamController.error(init.signal?.reason ?? new Error('aborted'));
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;
    const result = await postJevDecision(request({ fetch: hangingFetch, timeoutMs: 100 }));
    expect(result).toEqual({ ok: false, reason: 'timeout' });
  });

  it('maps a broken fetch error and never propagates it with the body', async () => {
    const brokenFetch = (async () => {
      throw new Error(`connection refused with ${KEY}`);
    }) as typeof fetch;
    let threw = false;
    let result: Awaited<ReturnType<typeof postJevDecision>> | null = null;
    try {
      result = await postJevDecision(request({ fetch: brokenFetch }));
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result).toEqual({ ok: false, reason: 'transport' });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
});

describe('postJevDecision hygiene (rules 3, hygiene clause)', () => {
  it('keeps the key out of success results, receipts and parsed bodies', async () => {
    const result = await postJevDecision(request());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.stringify(result)).not.toContain(KEY);
      expect(JSON.stringify(result.receipt)).not.toContain(KEY);
      expect(JSON.stringify(result.parsed)).not.toContain(KEY);
    }
  });

  it('never logs, including on a thrown fetch path', async () => {
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
    ];
    try {
      await postJevDecision(
        request({ fetch: (async () => { throw new Error('fail'); }) as typeof fetch }),
      );
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });
});

describe('postJevDecision receipt (rule 4)', () => {
  it('sanitizes id and model outside isValidIdOrModel', async () => {
    const hostile = { id: 'has space', model: 'x'.repeat(200), usage: { cost: 0.001 } };
    const result = await postJevDecision(
      request({ fetch: (async () => makeResponse(hostile)) as typeof fetch }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.receipt.requestId).toBe('');
      expect(result.receipt.servedModel).toBe('');
      expect(result.receipt.stateSha256).toBe('sha256-hex');
      expect(JSON.stringify(result.receipt)).not.toContain('has space');
    }
  });

  it('keeps a missing or non-finite usage cost as undefined, never 0', async () => {
    const missing = await postJevDecision(
      request({ fetch: (async () => makeResponse({ id: 'r', model: 'm', usage: {} })) as typeof fetch }),
    );
    expect(missing.ok).toBe(true);
    if (missing.ok) {
      expect(missing.receipt.costUsd).toBeUndefined();
    }

    const nonFinite = await postJevDecision(
      request({ fetch: (async () => makeResponse({ id: 'r', model: 'm', usage: { cost: Number.NaN } })) as typeof fetch }),
    );
    expect(nonFinite.ok).toBe(true);
    if (nonFinite.ok) {
      expect(nonFinite.receipt.costUsd).toBeUndefined();
    }
  });

  it('echoes stateSha256 from the request', async () => {
    const result = await postJevDecision(request());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.receipt.stateSha256).toBe('sha256-hex');
    }
  });
});

describe('postJevDecision purity (rule 1)', () => {
  it('imports no node:* modules and never touches console', () => {
    const source = readFileSync(new URL('../decisions/client.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from\s+['"]node:/);
    expect(source).not.toMatch(/console/);
  });

  it('posts to the OpenRouter decisions endpoint with the expected body', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return makeResponse({ id: 'gen-fixture', model: 'm1' });
    }) as typeof fetch;
    const result = await postJevDecision(request({ fetch: fetchFn }));
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(ENDPOINT);
    const sent = JSON.parse(calls[0].init.body as string) as {
      model: string;
      state: string;
      questions: Record<string, unknown>;
    };
    expect(sent.model).toBe('typesafe/jev-1.14');
    expect(sent.state).toBe('{"taskSummary":"t"}');
    expect(sent.questions.k0).toEqual({ type: 'score', instructions: 'i', criteria: ['low', 'high'] });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(sent)).not.toContain(KEY);
  });
});
