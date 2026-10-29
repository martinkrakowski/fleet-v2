/**
 * OT3b-2 tests for the real OTLP/HTTP transport (`OtlpHttpTransport.helper`):
 * the endpoint loopback rule, the token-file read, the fetch post against a
 * `node:http` fake receiver on 127.0.0.1 (port 0, scripted per request), the
 * retry and deadline wrapper, the misconfiguration breaker through the
 * factory, and the plan's redaction rule — no failure result ever carries the
 * endpoint URL, the token, a header or a response body marker. The token is
 * built from fragments in a temp file, never a token-shaped literal, and no
 * test reaches anything but 127.0.0.1.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spanDispositionText } from '../../../domain/run-telemetry-ids.js';
import { TelemetrySpan, type TelemetrySpanInput } from '../../../domain/run-telemetry.js';
import type { RunTelemetrySendDeadline } from '../../../application/ports/out/RunTelemetryPort.out-port.js';
import {
  OtlpHttpRunTelemetryAdapter,
  createOtlpHttpRunTelemetryAdapter,
  type OtlpPost,
  type OtlpPostOutcome,
} from '../OtlpHttpRunTelemetryAdapter.adapter.js';
import {
  checkOtlpEndpoint,
  createFetchOtlpPost,
  otlpRetrySleep,
  readOtlpTokenFile,
  withOtlpRetry,
} from '../OtlpHttpTransport.helper.js';

const TRACE_ID = '0123456789abcdef0123456789abcdef';
const RESOURCE = { serviceVersion: '1.2.3', projectName: 'fleet-v2' };

let spanCounter = 0;

/** A branded, encodable span with a unique non-zero hex span id. */
function makeSpan(overrides: Partial<TelemetrySpanInput> = {}): TelemetrySpan {
  spanCounter += 1;
  const input: TelemetrySpanInput = {
    traceId: TRACE_ID,
    spanId: spanCounter.toString(16).padStart(16, '0'),
    parentSpanId: null,
    name: 'lane-run',
    kind: 'CHAIN',
    startIso: '2026-01-01T00:00:00Z',
    endIso: '2026-01-01T00:01:00Z',
    status: { code: 'ok', reasonCode: null },
    attributes: {},
    events: [],
    ...overrides,
  };
  const span = TelemetrySpan.build(input);
  expect(span).not.toBeNull();
  return span as TelemetrySpan;
}

// ---------------------------------------------------------------------------
// The fake receiver: a node:http server on 127.0.0.1 port 0, scripted per
// request; each response body carries a unique marker string so the redaction
// assertions can prove no body text leaks into a result.
// ---------------------------------------------------------------------------

interface RecordedRequest {
  authorization: string | null;
  contentType: string | null;
  body: Buffer;
}

type ScriptedResponse = {
  status: number;
  headers?: Record<string, string>;
  /** A unique marker embedded in the response body. */
  marker: string;
  bodyJson?: unknown;
  /** When true, send the head and a truncated body then hang (the client aborts). */
  hang?: boolean;
};

let server: Server | null = null;
let serverRequests: RecordedRequest[] = [];
let serverScript: ScriptedResponse[] = [];

/** Starts the fake receiver with the given per-request script. */
async function startReceiver(script: ScriptedResponse[]): Promise<string> {
  serverRequests = [];
  serverScript = script;
  server = createServer((req, res) => {
    // Clients cancel unread bodies; never let that surface as an uncaught error.
    req.on('error', () => {});
    res.on('error', () => {});
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const scripted = serverScript.shift();
      serverRequests.push({
        authorization: req.headers.authorization ?? null,
        contentType: req.headers['content-type'] ?? null,
        body: Buffer.concat(chunks),
      });
      if (scripted === undefined) {
        res.statusCode = 500;
        res.end();
        return;
      }
      res.statusCode = scripted.status;
      for (const [name, value] of Object.entries(scripted.headers ?? {})) {
        res.setHeader(name, value);
      }
      if (scripted.hang === true) {
        // Send the head and a truncated partial-success body, then never end:
        // the client's body read aborts on its timeout or stop signal.
        res.setHeader('content-type', 'application/json');
        res.write('{"partialSuccess":{"rejectedSpans":"12"');
        return;
      }
      const body = JSON.stringify({ marker: scripted.marker, ...(scripted.bodyJson as object) });
      res.setHeader('content-type', 'application/json');
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => {
    server!.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  expect(address).not.toBeNull();
  // The receiver answers any path; the endpoint rule appends `/v1/traces`, so
  // the base itself carries no path (it was doubled before).
  return `http://127.0.0.1:${(address as { port: number }).port}`;
}

afterEach(async () => {
  const closing = server;
  server = null;
  serverRequests = [];
  serverScript = [];
  if (closing !== null) {
    closing.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      closing.close((error) => (error === undefined || error === null ? resolve() : reject(error)));
    });
  }
});

// Token file: content built from fragments, never a token-shaped literal.
const TOKEN_FRAGMENTS = ['test', 'token', 'value'];
const TOKEN = TOKEN_FRAGMENTS.join('-');
const ENDPOINT_TEXT = '/v1/traces';

let tokenDir: string | null = null;

/** Writes the token file (from fragments) into a fresh temp directory. */
function writeTokenFile(content: string): string {
  tokenDir = mkdtempSync(join(tmpdir(), 'otlp-transport-test-'));
  const path = join(tokenDir, 'token.txt');
  writeFileSync(path, content, 'utf8');
  return path;
}

afterEach(() => {
  if (tokenDir !== null) {
    rmSync(tokenDir, { recursive: true, force: true });
    tokenDir = null;
  }
});

interface SleepRecord {
  waits: number[];
  now: number;
}

/** A fake sleep/clock pair: the sleep advances the clock. */
function fakeClock(startNow = 0): { nowMs: () => number; sleep: (ms: number) => Promise<void>; record: SleepRecord } {
  const record: SleepRecord = { waits: [], now: startNow };
  return {
    record,
    nowMs: () => record.now,
    sleep: async (ms: number) => {
      record.waits.push(ms);
      record.now += ms;
    },
  };
}

/** Narrows an outcome to its `http` shape for field assertions. */
function expectHttp(
  outcome: OtlpPostOutcome,
): { status: number; retryAfterSeconds: number | null; rejectedSpans: number | null } {
  expect(outcome.kind).toBe('http');
  return outcome as { status: number; retryAfterSeconds: number | null; rejectedSpans: number | null };
}

/** The validated endpoint URL for the fake receiver's base address. */
function endpointUrl(base: string): URL {
  const checked = checkOtlpEndpoint(base + ENDPOINT_TEXT);
  expect(checked.ok).toBe(true);
  return (checked as { ok: true; url: URL }).url;
}

// ---------------------------------------------------------------------------
// Step 1: the endpoint rule.
// ---------------------------------------------------------------------------

describe('checkOtlpEndpoint (OT3b-2)', () => {
  it('accepts https anywhere and http only to the exact loopback hosts', () => {
    expect(checkOtlpEndpoint('https://collector.example/v1/traces')).toEqual({
      ok: true,
      url: new URL('https://collector.example/v1/traces'),
    });
    expect(checkOtlpEndpoint('http://127.0.0.1:4318/v1/traces').ok).toBe(true);
    expect(checkOtlpEndpoint('http://[::1]:4318/v1/traces').ok).toBe(true);
  });

  it('refuses every other http host, credentials and scheme with fixed reasons', () => {
    for (const raw of ['http://localhost/', 'http://localhost./', 'http://127.0.0.2/', 'http://[::2]/']) {
      const checked = checkOtlpEndpoint(raw);
      expect(checked).toEqual({ ok: false, reason: 'endpoint-needs-https' });
    }
    expect(checkOtlpEndpoint('http://user@127.0.0.1/')).toEqual({ ok: false, reason: 'endpoint-invalid' });
    for (const raw of ['ftp://127.0.0.1/', 'not a url', '', 42, null, undefined]) {
      expect(checkOtlpEndpoint(raw)).toEqual({ ok: false, reason: 'endpoint-invalid' });
    }
    // No reason ever echoes the input.
    for (const raw of ['http://localhost/', 'http://user@127.0.0.1/', 'ftp://127.0.0.1/']) {
      expect(JSON.stringify(checkOtlpEndpoint(raw))).not.toContain(raw);
    }
  });
});

// ---------------------------------------------------------------------------
// Step 2: the token file.
// ---------------------------------------------------------------------------

describe('readOtlpTokenFile (OT3b-2)', () => {
  it('reads the file once and trims one trailing newline', () => {
    const path = writeTokenFile(`${TOKEN_FRAGMENTS.join('-')}\n`);
    expect(readOtlpTokenFile(path)).toEqual({ ok: true, token: TOKEN });
  });

  it('refuses unreadable, empty and whitespace-carrying files with fixed reasons', () => {
    expect(readOtlpTokenFile('/nonexistent/token/file')).toEqual({ ok: false, reason: 'token-file-unreadable' });
    expect(readOtlpTokenFile(undefined)).toEqual({ ok: false, reason: 'token-file-unreadable' });
    const empty = writeTokenFile('');
    expect(readOtlpTokenFile(empty)).toEqual({ ok: false, reason: 'token-empty' });
    const newline = writeTokenFile(`${TOKEN_FRAGMENTS[0]}\n${TOKEN_FRAGMENTS[1]}\n`);
    expect(readOtlpTokenFile(newline)).toEqual({ ok: false, reason: 'token-empty' });
    const spaced = writeTokenFile(`${TOKEN_FRAGMENTS.join(' ')}`);
    expect(readOtlpTokenFile(spaced)).toEqual({ ok: false, reason: 'token-empty' });
    // No reason carries file content.
    expect(JSON.stringify(readOtlpTokenFile(newline))).not.toContain(TOKEN_FRAGMENTS[0]);
  });
});

// ---------------------------------------------------------------------------
// Step 3: the fetch post against the fake receiver.
// ---------------------------------------------------------------------------

describe('createFetchOtlpPost (OT3b-2)', () => {
  it('posts once with the bearer and content-type headers and reads a 2xx body', async () => {
    const base = await startReceiver([
      { status: 200, marker: 'marker-post-ok', bodyJson: { partialSuccess: { rejectedSpans: '3' } } },
    ]);
    const post = createFetchOtlpPost({ url: endpointUrl(base), token: TOKEN, nowMs: () => 0 });
    const outcome = await post(new Uint8Array([1, 2, 3]));
    expect(outcome).toEqual({ kind: 'http', status: 200, retryAfterSeconds: null, rejectedSpans: 3 } satisfies OtlpPostOutcome);
    expect(serverRequests).toHaveLength(1);
    expect(serverRequests[0].authorization).toBe(`Bearer ${TOKEN}`);
    expect(serverRequests[0].contentType).toBe('application/json');
    expect(Array.from(serverRequests[0].body)).toEqual([1, 2, 3]);
  });

  it('passes a number rejectedSpans and null when the body is absent or unparsable', async () => {
    const base = await startReceiver([
      { status: 200, marker: 'marker-post-num', bodyJson: { partialSuccess: { rejectedSpans: 5 } } },
      { status: 200, marker: 'marker-post-empty' },
      { status: 200, marker: 'marker-post-garbage', bodyJson: { partialSuccess: { rejectedSpans: 'many' } } },
    ]);
    const post = createFetchOtlpPost({ url: endpointUrl(base), token: TOKEN });
    expect(expectHttp(await post(new Uint8Array())).rejectedSpans).toBe(5);
    expect(expectHttp(await post(new Uint8Array())).rejectedSpans).toBeNull();
    expect(expectHttp(await post(new Uint8Array())).rejectedSpans).toBeNull();
  });

  it('reads Retry-After as seconds or as an HTTP date against the injected clock', async () => {
    const base = await startReceiver([
      { status: 429, marker: 'marker-ra-seconds', headers: { 'retry-after': '7' } },
      { status: 503, marker: 'marker-ra-date', headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:10 GMT' } },
    ]);
    const fixedNow = Date.parse('2026-10-21T07:27:40Z');
    const post = createFetchOtlpPost({ url: endpointUrl(base), token: TOKEN, nowMs: () => fixedNow });
    expect(expectHttp(await post(new Uint8Array())).retryAfterSeconds).toBe(7);
    expect(expectHttp(await post(new Uint8Array())).retryAfterSeconds).toBe(30);
  });

  it('returns null Retry-After for shapes that are neither delta-seconds nor an HTTP date', async () => {
    const base = await startReceiver([
      { status: 429, marker: 'marker-ra-frac', headers: { 'retry-after': '1.5' } },
      { status: 429, marker: 'marker-ra-neg', headers: { 'retry-after': '-1' } },
    ]);
    const post = createFetchOtlpPost({ url: endpointUrl(base), token: TOKEN });
    expect(expectHttp(await post(new Uint8Array())).retryAfterSeconds).toBeNull();
    expect(expectHttp(await post(new Uint8Array())).retryAfterSeconds).toBeNull();
  });

  it('maps a 2xx whose body read aborts mid-body to timeout, never an http result', async () => {
    const base = await startReceiver([{ status: 200, marker: MARKERS.hang, hang: true }]);
    const post = createFetchOtlpPost({ url: endpointUrl(base), token: TOKEN, timeoutMs: 100 });
    const outcome = await post(new Uint8Array());
    expect(outcome).toEqual({ kind: 'timeout' });
  });

  it('maps a stop-signal abort with any reason to timeout', async () => {
    const base = await startReceiver([]);
    const controller = new AbortController();
    const post = createFetchOtlpPost({
      url: endpointUrl(base),
      token: TOKEN,
      stopSignal: controller.signal,
      fetchImpl: (async () => {
        controller.abort('stop');
        throw new Error('stop');
      }) as typeof fetch,
    });
    expect(await post(new Uint8Array())).toEqual({ kind: 'timeout' });
  });

  it('never reads a non-2xx body and maps aborts to timeout and failures to network', async () => {
    const base = await startReceiver([{ status: 400, marker: 'marker-4xx-body' }]);
    const post = createFetchOtlpPost({ url: endpointUrl(base), token: TOKEN });
    const outcome = await post(new Uint8Array());
    expect(outcome).toEqual({ kind: 'http', status: 400, retryAfterSeconds: null, rejectedSpans: null });
    // The 4xx body was cancelled, never read: nothing but the post outcome
    // exists to check, and the outcome carries no body, header or endpoint.
    expectRedacted(JSON.stringify(outcome), base, ['marker-4xx-body']);

    const aborting = createFetchOtlpPost({
      url: endpointUrl(base),
      token: TOKEN,
      fetchImpl: (async () => {
        throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
      }) as typeof fetch,
    });
    expect(await aborting(new Uint8Array())).toEqual({ kind: 'timeout' });

    const failing = createFetchOtlpPost({
      url: endpointUrl(base),
      token: TOKEN,
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    expect(await failing(new Uint8Array())).toEqual({ kind: 'network' });
    expect(JSON.stringify(await failing(new Uint8Array()))).not.toContain(ENDPOINT_TEXT);
  });
});

// ---------------------------------------------------------------------------
// Step 4: retry and deadline.
// ---------------------------------------------------------------------------

describe('withOtlpRetry (OT3b-2)', () => {
  const http = (status: number, retryAfterSeconds: number | null = null): OtlpPostOutcome => ({
    kind: 'http',
    status,
    retryAfterSeconds,
    rejectedSpans: null,
  });

  it('retries 429/502/503/504 at most twice, waiting 1s then 4s or Retry-After capped at 30s', async () => {
    const clock = fakeClock();
    const posts: number[] = [];
    const record = async (payload: Uint8Array): Promise<OtlpPostOutcome> => {
      void payload;
      posts.push(clock.record.now);
      return clock.record.waits.length === 0 ? http(429, 45) : http(200);
    };
    const wrapped = withOtlpRetry(record, { deadline: null, ...clock });
    expect(await wrapped(new Uint8Array())).toEqual(http(200));
    expect(posts).toEqual([0, 30_000]);
    expect(clock.record.waits).toEqual([30_000]);

    const clock2 = fakeClock();
    const waits: number[] = [];
    let attempt = 0;
    const flaky: OtlpPost = async () => {
      attempt += 1;
      return attempt <= 2 ? http(503) : http(200);
    };
    const wrapped2 = withOtlpRetry(flaky, {
      deadline: null,
      nowMs: clock2.nowMs,
      sleep: async (ms: number) => {
        waits.push(ms);
        await clock2.sleep(ms);
      },
    });
    expect(await wrapped2(new Uint8Array())).toEqual(http(200));
    expect(waits).toEqual([1_000, 4_000]);
    expect(await otlpRetrySleep(0)).toBeUndefined();
  });

  it('stops retrying at the deadline: timeout with no further post', async () => {
    const clock = fakeClock();
    let posts = 0;
    const always503: OtlpPost = async () => {
      posts += 1;
      return http(503, 10);
    };
    const deadline: RunTelemetrySendDeadline = { atMs: 500 };
    const wrapped = withOtlpRetry(always503, { deadline, ...clock });
    expect(await wrapped(new Uint8Array())).toEqual({ kind: 'timeout' });
    expect(posts).toBe(1);
    expect(clock.record.waits).toEqual([]);
  });

  it('reports timeout without posting when the deadline is already reached', async () => {
    let posts = 0;
    const counting: OtlpPost = async () => {
      posts += 1;
      return http(200);
    };
    const wrapped = withOtlpRetry(counting, { deadline: { atMs: 0 }, nowMs: () => 10, sleep: async () => undefined });
    expect(await wrapped(new Uint8Array())).toEqual({ kind: 'timeout' });
    expect(posts).toBe(0);
  });

  it('does not sleep when the retry wait exactly reaches the deadline', async () => {
    const clock = fakeClock();
    let posts = 0;
    const retryOnce: OtlpPost = async () => {
      posts += 1;
      return http(503, 1);
    };
    const wrapped = withOtlpRetry(retryOnce, { deadline: { atMs: 1_000 }, ...clock });
    expect(await wrapped(new Uint8Array())).toEqual({ kind: 'timeout' });
    expect(posts).toBe(1);
    expect(clock.record.waits).toEqual([]);
  });

  it('wakes the retry sleep on the stop signal and posts nothing more', async () => {
    const controller = new AbortController();
    let posts = 0;
    const always503: OtlpPost = async () => {
      posts += 1;
      return http(503, 30);
    };
    const slept: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      slept.push(ms);
      await new Promise<void>(() => {});
    };
    const wrapped = withOtlpRetry(always503, {
      deadline: null,
      stopSignal: controller.signal,
      sleep,
    });
    const outcomePromise = wrapped(new Uint8Array());
    // Let the first post and the retry sleep begin, then abort the stop signal.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    controller.abort();
    expect(await outcomePromise).toEqual({ kind: 'timeout' });
    expect(posts).toBe(1);
    expect(slept).toEqual([30_000]);
  });

  it('returns the final outcome after two retries even while the deadline stands', async () => {
    const clock = fakeClock();
    let posts = 0;
    const always503: OtlpPost = async () => {
      posts += 1;
      return http(503);
    };
    const wrapped = withOtlpRetry(always503, { deadline: { atMs: 1_000_000 }, ...clock });
    expect(await wrapped(new Uint8Array())).toEqual(http(503));
    expect(posts).toBe(3);
    expect(clock.record.waits).toEqual([1_000, 4_000]);
  });
});

// ---------------------------------------------------------------------------
// Steps 5–8: the factory, the breaker, the fake-receiver send cases and the
// plan's redaction test 6.
// ---------------------------------------------------------------------------

/** The unique response-body markers handed to the fake receiver per case. */
const MARKERS = {
  ok: 'marker-ok-2xx',
  rateLimit: 'marker-429-1s',
  serviceDown: 'marker-503-1',
  serviceDown2: 'marker-503-2',
  serviceDown3: 'marker-503-3',
  split: 'marker-400-split',
  partial: 'marker-partial-success',
  breaker: 'marker-400-breaker',
  auth: 'marker-401-auth',
  hang: 'marker-hang-body',
};

function factoryFor(base: string, overrides: Partial<Parameters<typeof createOtlpHttpRunTelemetryAdapter>[0]> = {}) {
  const clock = fakeClock();
  const tokenPath = writeTokenFile(`${TOKEN_FRAGMENTS.join('-')}\n`);
  const built = createOtlpHttpRunTelemetryAdapter({
    endpoint: base + ENDPOINT_TEXT,
    tokenFile: tokenPath,
    route: 'collector',
    resource: RESOURCE,
    nowMs: clock.nowMs,
    sleep: clock.sleep,
    ...overrides,
  });
  expect(built.ok).toBe(true);
  return { adapter: (built as { ok: true; adapter: OtlpHttpRunTelemetryAdapter }).adapter, clock };
}

/**
 * The shared redaction assertion (brief Step 8): a serialized result carries
 * no endpoint URL, no token, no sent header name or value, and no response
 * body marker (plan §3.9).
 */
function expectRedacted(text: string, base: string, markers: readonly string[]): void {
  expect(text).not.toContain(base);
  expect(text).not.toContain(`${base}${ENDPOINT_TEXT}`);
  expect(text).not.toContain(ENDPOINT_TEXT);
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain('authorization');
  expect(text).not.toContain('Bearer');
  expect(text).not.toContain('content-type');
  expect(text).not.toContain('application/json');
  for (const marker of markers) {
    expect(text).not.toContain(marker);
  }
}

describe('the OTLP HTTP transport through the fake receiver (OT3b-2)', () => {
  it('exports every span on a 2xx and sends the bearer and content-type headers', async () => {
    const base = await startReceiver([{ status: 200, marker: MARKERS.ok }]);
    const { adapter } = factoryFor(base);
    const spans = [makeSpan(), makeSpan()];
    const result = await adapter.send(spans, null);
    expect(result.errorKind).toBeNull();
    expect(result.dispositions.map((d) => spanDispositionText(d.disposition))).toEqual([
      'exported@collector',
      'exported@collector',
    ]);
    expect(serverRequests).toHaveLength(1);
    expect(serverRequests[0].authorization).toBe(`Bearer ${TOKEN}`);
    expect(serverRequests[0].contentType).toBe('application/json');
    // Redaction test 6: no endpoint, token, header or body marker in the result.
    const text = JSON.stringify(result);
    expect(text).not.toContain(base + ENDPOINT_TEXT);
    expect(text).not.toContain(ENDPOINT_TEXT);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('authorization');
    expect(text).not.toContain(MARKERS.ok);
  });

  it('retries a 429 with Retry-After: 1 once through the fake sleep, then exports', async () => {
    const base = await startReceiver([
      { status: 429, marker: MARKERS.rateLimit, headers: { 'retry-after': '1' } },
      { status: 200, marker: MARKERS.ok },
    ]);
    const { adapter, clock } = factoryFor(base);
    const span = makeSpan();
    const result = await adapter.send([span], null);
    expect(result.errorKind).toBeNull();
    expect(spanDispositionText(result.dispositions[0].disposition)).toBe('exported@collector');
    expect(serverRequests).toHaveLength(2);
    expect(clock.record.waits).toEqual([1_000]);
    expect(JSON.stringify(result)).not.toContain(MARKERS.rateLimit);
  });

  it('gives up after two 503 retries: spans pending with http-5xx', async () => {
    const base = await startReceiver([
      { status: 503, marker: MARKERS.serviceDown },
      { status: 503, marker: MARKERS.serviceDown2 },
      { status: 503, marker: MARKERS.serviceDown3 },
    ]);
    const { adapter, clock } = factoryFor(base);
    const spans = [makeSpan(), makeSpan()];
    const result = await adapter.send(spans, null);
    expect(result.errorKind).toBe('http-5xx');
    expect(result.dispositions.map((d) => spanDispositionText(d.disposition))).toEqual(['pending', 'pending']);
    expect(serverRequests).toHaveLength(3);
    expect(clock.record.waits).toEqual([1_000, 4_000]);
    expect(adapter.takeCounters()).toEqual({ queueDrops: 0, errorKinds: { 'http-5xx': 1 } });
    const text = JSON.stringify({ ...result, ...adapter.takeCounters() });
    expectRedacted(text, base, [MARKERS.serviceDown, MARKERS.serviceDown2, MARKERS.serviceDown3]);
  });

  it('splits a 400 batch and exports each single-span resend', async () => {
    const base = await startReceiver([
      { status: 400, marker: MARKERS.split },
      { status: 200, marker: MARKERS.ok },
      { status: 200, marker: MARKERS.ok },
    ]);
    const { adapter } = factoryFor(base);
    const spans = [makeSpan(), makeSpan()];
    const result = await adapter.send(spans, null);
    expect(result.errorKind).toBeNull();
    expect(result.dispositions.map((d) => spanDispositionText(d.disposition))).toEqual([
      'exported@collector',
      'exported@collector',
    ]);
    expect(serverRequests.map((request) => JSON.parse(request.body.toString('utf8')).resourceSpans[0].scopeSpans[0].spans)).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain(MARKERS.split);
  });

  it('splits on a partial success with rejectedSpans > 0 and not with 0', async () => {
    const base = await startReceiver([
      { status: 200, marker: MARKERS.partial, bodyJson: { partialSuccess: { rejectedSpans: '2' } } },
      { status: 200, marker: MARKERS.ok },
      { status: 200, marker: MARKERS.ok },
      { status: 200, marker: MARKERS.partial, bodyJson: { partialSuccess: { rejectedSpans: '1' } } },
    ]);
    const { adapter } = factoryFor(base);
    const spans = [makeSpan(), makeSpan(), makeSpan()];
    const result = await adapter.send(spans, null);
    expect(result.errorKind).toBe('partial');
    expect(result.dispositions.map((d) => spanDispositionText(d.disposition))).toEqual([
      'exported@collector',
      'exported@collector',
      'rejected:partial-rejected',
    ]);
    expect(serverRequests).toHaveLength(4);
    expect(JSON.stringify(result)).not.toContain(MARKERS.partial);

    const zeroBase = await startReceiver([
      { status: 200, marker: MARKERS.ok, bodyJson: { partialSuccess: { rejectedSpans: 0 } } },
    ]);
    const zero = factoryFor(zeroBase);
    const zeroResult = await zero.adapter.send([makeSpan(), makeSpan()], null);
    expect(zeroResult.errorKind).toBeNull();
    expect(serverRequests).toHaveLength(1);
    expect(zeroResult.dispositions.every((d) => spanDispositionText(d.disposition) === 'exported@collector')).toBe(true);
  });

  it('trips the misconfiguration breaker on three single-span 400s: three pending, http-4xx, nothing more posted', async () => {
    const base = await startReceiver([
      { status: 400, marker: MARKERS.breaker },
      { status: 400, marker: MARKERS.breaker },
      { status: 400, marker: MARKERS.breaker },
      { status: 400, marker: MARKERS.breaker },
    ]);
    const { adapter } = factoryFor(base);
    const spans = [makeSpan(), makeSpan(), makeSpan()];
    const result = await adapter.send(spans, null);
    expect(result.errorKind).toBe('http-4xx');
    expect(result.dispositions.map((d) => spanDispositionText(d.disposition))).toEqual(['pending', 'pending', 'pending']);
    // The batch post plus exactly three single-span posts, never a fourth.
    expect(serverRequests).toHaveLength(4);
    expect(adapter.takeCounters()).toEqual({ queueDrops: 0, errorKinds: { 'http-4xx': 1 } });
    const text = JSON.stringify({ ...result, ...adapter.takeCounters() });
    expectRedacted(text, base, [MARKERS.breaker]);
  });

  it('stops on a 401 with error kind auth and the stopping request is the recorded kind', async () => {
    const base = await startReceiver([{ status: 401, marker: MARKERS.auth }]);
    const { adapter } = factoryFor(base);
    const spans = [makeSpan(), makeSpan()];
    const result = await adapter.send(spans, null);
    expect(result.errorKind).toBe('auth');
    expect(result.dispositions.map((d) => spanDispositionText(d.disposition))).toEqual(['pending', 'pending']);
    expect(serverRequests).toHaveLength(1);
    expectRedacted(JSON.stringify(result), base, [MARKERS.auth]);
  });

  it('maps a request that never answers within the timeout to error kind timeout', async () => {
    // A receiver that accepts connections but never answers.
    const hanging: Server = createServer(() => {
      // Intentionally no response.
    });
    server = hanging;
    await new Promise<void>((resolve) => {
      hanging.listen(0, '127.0.0.1', () => resolve());
    });
    const address = hanging.address();
    expect(address).not.toBeNull();
    const base = `http://127.0.0.1:${(address as { port: number }).port}`;
    const { adapter } = factoryFor(base, { timeoutMs: 100 });
    const span = makeSpan();
    const result = await adapter.send([span], null);
    expect(result.errorKind).toBe('timeout');
    expect(spanDispositionText(result.dispositions[0].disposition)).toBe('pending');
    expectRedacted(JSON.stringify(result), base, []);
  });

  it('reports timeout when the deadline ends before a retry wait, with no further post', async () => {
    const base = await startReceiver([
      { status: 503, marker: MARKERS.serviceDown, headers: { 'retry-after': '30' } },
      { status: 200, marker: MARKERS.ok },
    ]);
    const clock = fakeClock(1_000);
    const tokenPath = writeTokenFile(`${TOKEN_FRAGMENTS.join('-')}\n`);
    const built = createOtlpHttpRunTelemetryAdapter({
      endpoint: base + ENDPOINT_TEXT,
      tokenFile: tokenPath,
      route: 'collector',
      resource: RESOURCE,
      nowMs: clock.nowMs,
      sleep: clock.sleep,
    });
    expect(built.ok).toBe(true);
    const adapter = (built as { ok: true; adapter: OtlpHttpRunTelemetryAdapter }).adapter;
    const span = makeSpan();
    const result = await adapter.send([span], { atMs: 2_000 });
    expect(result.errorKind).toBe('timeout');
    expect(spanDispositionText(result.dispositions[0].disposition)).toBe('pending');
    expect(serverRequests).toHaveLength(1);
    expect(clock.record.waits).toEqual([]);
    expectRedacted(JSON.stringify(result), base, [MARKERS.serviceDown, MARKERS.ok]);
  });

  it('enforces the send deadline inside the transport: no post at all when it is already past', async () => {
    const base = await startReceiver([{ status: 200, marker: MARKERS.ok }]);
    const { adapter } = factoryFor(base);
    const span = makeSpan();
    const result = await adapter.send([span], { atMs: 0 });
    expect(result.errorKind).toBe('timeout');
    expect(spanDispositionText(result.dispositions[0].disposition)).toBe('pending');
    expect(serverRequests).toHaveLength(0);
    expectRedacted(JSON.stringify(result), base, [MARKERS.ok]);
  });

  it('never exports spans whose 2xx body read aborts: timeout, pending', async () => {
    const base = await startReceiver([{ status: 200, marker: MARKERS.hang, hang: true }]);
    const { adapter } = factoryFor(base, { timeoutMs: 100 });
    const span = makeSpan();
    const result = await adapter.send([span], null);
    expect(result.errorKind).toBe('timeout');
    expect(spanDispositionText(result.dispositions[0].disposition)).toBe('pending');
    expectRedacted(JSON.stringify(result), base, [MARKERS.hang]);
  });

  it('treats a malformed Retry-After as the default backoff, not an explicit zero wait', async () => {
    const base = await startReceiver([
      { status: 429, marker: MARKERS.rateLimit, headers: { 'retry-after': '1.5' } },
      { status: 200, marker: MARKERS.ok },
    ]);
    const fixedNow = Date.parse('2026-10-21T07:27:40Z');
    const clock = fakeClock(fixedNow);
    const tokenPath = writeTokenFile(`${TOKEN_FRAGMENTS.join('-')}\n`);
    const built = createOtlpHttpRunTelemetryAdapter({
      endpoint: base + ENDPOINT_TEXT,
      tokenFile: tokenPath,
      route: 'collector',
      resource: RESOURCE,
      nowMs: clock.nowMs,
      sleep: clock.sleep,
    });
    expect(built.ok).toBe(true);
    const adapter = (built as { ok: true; adapter: OtlpHttpRunTelemetryAdapter }).adapter;
    const span = makeSpan();
    const result = await adapter.send([span], null);
    expect(result.errorKind).toBeNull();
    expect(spanDispositionText(result.dispositions[0].disposition)).toBe('exported@collector');
    expect(serverRequests).toHaveLength(2);
    expect(clock.record.waits).toEqual([1_000]);
  });

  it('trips the breaker across batches and reverts the earlier batch rejected spans to pending', async () => {
    const base = await startReceiver([
      { status: 400, marker: MARKERS.breaker },
      { status: 400, marker: MARKERS.breaker },
      { status: 400, marker: MARKERS.breaker },
      { status: 400, marker: MARKERS.breaker },
      { status: 400, marker: MARKERS.breaker },
    ]);
    const { adapter } = factoryFor(base, { maxBatchSpans: 2 });
    const spans = [makeSpan(), makeSpan(), makeSpan(), makeSpan()];
    const result = await adapter.send(spans, null);
    expect(result.errorKind).toBe('http-4xx');
    expect(result.dispositions.map((d) => spanDispositionText(d.disposition))).toEqual(['pending', 'pending', 'pending', 'pending']);
    expect(serverRequests).toHaveLength(5);
    expectRedacted(JSON.stringify(result), base, [MARKERS.breaker]);
  });

  it('resets the breaker on an accepted batch 2xx between splits', async () => {
    const base = await startReceiver([
      { status: 400, marker: MARKERS.breaker },
      { status: 400, marker: MARKERS.breaker },
      { status: 400, marker: MARKERS.breaker },
      { status: 200, marker: MARKERS.ok },
      { status: 400, marker: MARKERS.breaker },
      { status: 400, marker: MARKERS.breaker },
      { status: 400, marker: MARKERS.breaker },
    ]);
    const { adapter } = factoryFor(base, { maxBatchSpans: 2 });
    const spans = [makeSpan(), makeSpan(), makeSpan(), makeSpan(), makeSpan(), makeSpan()];
    const result = await adapter.send(spans, null);
    expect(result.errorKind).toBeNull();
    expect(result.dispositions.map((d) => spanDispositionText(d.disposition))).toEqual([
      'rejected:http-4xx',
      'rejected:http-4xx',
      'exported@collector',
      'exported@collector',
      'rejected:http-4xx',
      'rejected:http-4xx',
    ]);
    expect(serverRequests).toHaveLength(7);
    expectRedacted(JSON.stringify(result), base, [MARKERS.breaker, MARKERS.ok]);
  });

  it('keeps an earlier 4xx rejected after an accepted 2xx when the split later stops', async () => {
    const base = await startReceiver([
      { status: 200, marker: MARKERS.partial, bodyJson: { partialSuccess: { rejectedSpans: '4' } } },
      { status: 400, marker: MARKERS.split },
      { status: 200, marker: MARKERS.ok },
      { status: 401, marker: MARKERS.auth },
    ]);
    const { adapter } = factoryFor(base);
    const spans = [makeSpan(), makeSpan(), makeSpan(), makeSpan()];
    const result = await adapter.send(spans, null);
    expect(result.errorKind).toBe('auth');
    expect(result.dispositions.map((d) => spanDispositionText(d.disposition))).toEqual([
      'rejected:http-4xx',
      'exported@collector',
      'pending',
      'pending',
    ]);
    expect(serverRequests).toHaveLength(4);
    expectRedacted(JSON.stringify(result), base, [MARKERS.partial, MARKERS.split, MARKERS.ok, MARKERS.auth]);
  });

  it('counts single-span 400s on 1-span batches and never resets on a partial 2xx', async () => {
    const base = await startReceiver([
      { status: 400, marker: MARKERS.breaker },
      { status: 200, marker: MARKERS.partial, bodyJson: { partialSuccess: { rejectedSpans: '1' } } },
      { status: 400, marker: MARKERS.breaker },
      { status: 400, marker: MARKERS.breaker },
    ]);
    const { adapter } = factoryFor(base, { maxBatchSpans: 1 });
    const spans = [makeSpan(), makeSpan(), makeSpan(), makeSpan()];
    const result = await adapter.send(spans, null);
    expect(result.errorKind).toBe('http-4xx');
    expect(result.dispositions.map((d) => spanDispositionText(d.disposition))).toEqual([
      'pending',
      'rejected:partial-rejected',
      'pending',
      'pending',
    ]);
    expect(serverRequests).toHaveLength(4);
    expectRedacted(JSON.stringify(result), base, [MARKERS.breaker, MARKERS.partial]);
  });

  it('keeps a 2-span split of 400s rejected below the breaker threshold with errorKind null', async () => {
    const base = await startReceiver([
      { status: 400, marker: MARKERS.split },
      { status: 400, marker: MARKERS.split },
      { status: 400, marker: MARKERS.split },
    ]);
    const { adapter } = factoryFor(base);
    const spans = [makeSpan(), makeSpan()];
    const result = await adapter.send(spans, null);
    expect(result.errorKind).toBeNull();
    expect(result.dispositions.map((d) => spanDispositionText(d.disposition))).toEqual([
      'rejected:http-4xx',
      'rejected:http-4xx',
    ]);
    expect(serverRequests).toHaveLength(3);
    expectRedacted(JSON.stringify(result), base, [MARKERS.split]);
  });
});

// ---------------------------------------------------------------------------
// Step 6: the factory's refusals.
// ---------------------------------------------------------------------------

describe('createOtlpHttpRunTelemetryAdapter refusals (OT3b-2)', () => {
  it('refuses a bad endpoint, a credentials endpoint, an unreadable and an empty token file', async () => {
    const base = await startReceiver([]);
    const tokenPath = writeTokenFile(`${TOKEN_FRAGMENTS.join('-')}\n`);
    const refusals = [
      createOtlpHttpRunTelemetryAdapter({ endpoint: 'http://localhost/v1/traces', tokenFile: tokenPath, route: 'collector', resource: RESOURCE }),
      createOtlpHttpRunTelemetryAdapter({ endpoint: 'http://user@127.0.0.1/v1/traces', tokenFile: tokenPath, route: 'collector', resource: RESOURCE }),
      createOtlpHttpRunTelemetryAdapter({ endpoint: 'ftp://127.0.0.1/v1/traces', tokenFile: tokenPath, route: 'collector', resource: RESOURCE }),
      createOtlpHttpRunTelemetryAdapter({ endpoint: base + ENDPOINT_TEXT, tokenFile: '/nonexistent/token', route: 'collector', resource: RESOURCE }),
      createOtlpHttpRunTelemetryAdapter({ endpoint: base + ENDPOINT_TEXT, tokenFile: writeTokenFile(''), route: 'collector', resource: RESOURCE }),
    ];
    const expected = ['endpoint-needs-https', 'endpoint-invalid', 'endpoint-invalid', 'token-file-unreadable', 'token-empty'];
    refusals.forEach((refusal, index) => {
      expect(refusal).toEqual({ ok: false, reason: expected[index] });
      // Redaction: no refusal echoes the endpoint, the token path or the token.
      const text = JSON.stringify(refusal);
      expect(text).not.toContain(base);
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain('token.txt');
    });
  });
});

// ---------------------------------------------------------------------------
// The carried review fixes.
// ---------------------------------------------------------------------------

describe('carried review fixes (OT3b-2)', () => {
  it('a split that stops on a 401 keeps the real auth kind and pulls the earlier 4xx back to pending', async () => {
    // partial success with rejectedSpans 3 splits into three singles: 400,
    // 400, then 401. The call's error kind is auth (the stopping request's
    // real kind, never a blanket http-4xx) and the two single-span 400s go
    // back to pending (plan §3.5).
    const base = await startReceiver([
      { status: 200, marker: MARKERS.partial, bodyJson: { partialSuccess: { rejectedSpans: '3' } } },
      { status: 400, marker: MARKERS.split },
      { status: 400, marker: MARKERS.split },
      { status: 401, marker: MARKERS.auth },
    ]);
    const { adapter } = factoryFor(base);
    const spans = [makeSpan(), makeSpan(), makeSpan()];
    const result = await adapter.send(spans, null);
    expect(result.errorKind).toBe('auth');
    expect(result.dispositions.map((d) => spanDispositionText(d.disposition))).toEqual(['pending', 'pending', 'pending']);
    expect(serverRequests).toHaveLength(4);
    expectRedacted(JSON.stringify(result), base, [MARKERS.partial, MARKERS.split, MARKERS.auth]);
  });

  it('a split that stops on a final 503 keeps the real http-5xx kind and pulls the earlier 4xx back to pending', async () => {
    const base = await startReceiver([
      { status: 200, marker: MARKERS.partial, bodyJson: { partialSuccess: { rejectedSpans: '3' } } },
      { status: 400, marker: MARKERS.split },
      { status: 400, marker: MARKERS.split },
      { status: 503, marker: MARKERS.serviceDown },
      { status: 503, marker: MARKERS.serviceDown2 },
      { status: 503, marker: MARKERS.serviceDown3 },
    ]);
    const { adapter, clock } = factoryFor(base);
    const spans = [makeSpan(), makeSpan(), makeSpan()];
    const result = await adapter.send(spans, null);
    expect(result.errorKind).toBe('http-5xx');
    expect(result.dispositions.map((d) => spanDispositionText(d.disposition))).toEqual(['pending', 'pending', 'pending']);
    // One batch, two single-span 400s, then the 503 retried twice.
    expect(serverRequests).toHaveLength(6);
    expect(clock.record.waits).toEqual([1_000, 4_000]);
    expectRedacted(JSON.stringify(result), base, [
      MARKERS.partial,
      MARKERS.split,
      MARKERS.serviceDown,
      MARKERS.serviceDown2,
      MARKERS.serviceDown3,
    ]);
  });

  it('an unexpected final status (302) is the network kind with spans left pending', async () => {
    const base = await startReceiver([{ status: 302, marker: MARKERS.ok, headers: { location: '/elsewhere' } }]);
    const { adapter } = factoryFor(base);
    const spans = [makeSpan(), makeSpan()];
    const result = await adapter.send(spans, null);
    expect(result.errorKind).toBe('network');
    expect(result.dispositions.map((d) => spanDispositionText(d.disposition))).toEqual(['pending', 'pending']);
    expect(serverRequests).toHaveLength(1);
    expectRedacted(JSON.stringify(result), base, [MARKERS.ok]);
  });

  it('a split that stops on a timeout keeps the real timeout kind and pulls the earlier 4xx back to pending', async () => {
    const base = await startReceiver([
      { status: 200, marker: MARKERS.partial, bodyJson: { partialSuccess: { rejectedSpans: '3' } } },
      { status: 400, marker: MARKERS.split },
      { status: 400, marker: MARKERS.split },
      { status: 200, marker: MARKERS.hang, hang: true },
    ]);
    const { adapter } = factoryFor(base, { timeoutMs: 100 });
    const spans = [makeSpan(), makeSpan(), makeSpan()];
    const result = await adapter.send(spans, null);
    expect(result.errorKind).toBe('timeout');
    expect(result.dispositions.map((d) => spanDispositionText(d.disposition))).toEqual(['pending', 'pending', 'pending']);
    expect(serverRequests).toHaveLength(4);
    expectRedacted(JSON.stringify(result), base, [MARKERS.partial, MARKERS.split, MARKERS.hang]);
  });
});
