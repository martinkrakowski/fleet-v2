/**
 * OT3b-1 tests for the OTLP send adapter's core (`OtlpHttpRunTelemetryAdapter`)
 * against an injected fake transport: the queue bound, batching, byte-limit
 * splitting, result mapping, split resends, dispositions, error kinds, the
 * serialisation chain and the counters. Spans are built only with
 * `TelemetrySpan.build`; the fake `post` is scripted per call, records every
 * payload, and the payloads are inspected by decoding the JSON.
 */

import { describe, expect, it } from 'vitest';
import { TelemetrySpan, type TelemetrySpanInput } from '../../../domain/run-telemetry.js';
import { spanDispositionText } from '../../../domain/run-telemetry-ids.js';
import { encodeOtlpTraces } from '../OtlpJsonEncoder.helper.js';
import {
  OtlpHttpRunTelemetryAdapter,
  type OtlpPost,
  type OtlpPostOutcome,
} from '../OtlpHttpRunTelemetryAdapter.adapter.js';
import type { RunTelemetrySendDeadline } from '../../../application/ports/out/RunTelemetryPort.out-port.js';

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

type ScriptedEntry = OtlpPostOutcome | 'throw';

/** A fake `OtlpPost`: records every payload and plays a scripted outcome per call. */
function scriptedPost(script: ReadonlyArray<ScriptedEntry>): { post: OtlpPost; calls: Uint8Array[] } {
  const calls: Uint8Array[] = [];
  let index = 0;
  const post: OtlpPost = async (payload) => {
    calls.push(payload);
    const entry = script[index];
    index += 1;
    if (entry === 'throw') {
      throw new Error('scripted post threw');
    }
    return entry;
  };
  return { post, calls };
}

function payloadSpanIds(payload: Uint8Array): string[] {
  const parsed = JSON.parse(new TextDecoder().decode(payload)) as {
    resourceSpans: { scopeSpans: { spans: { spanId: string }[] }[] }[];
  };
  return parsed.resourceSpans[0].scopeSpans[0].spans.map((span) => span.spanId);
}

const OK = { kind: 'http', status: 200, retryAfterSeconds: null, rejectedSpans: null } as const;

describe('OtlpHttpRunTelemetryAdapter core (OT3b-1)', () => {
  it('exports every span in input order when every request is a 2xx', async () => {
    const spans = [makeSpan(), makeSpan(), makeSpan()];
    const { post, calls } = scriptedPost([OK]);
    const adapter = new OtlpHttpRunTelemetryAdapter({ post, route: 'collector', resource: RESOURCE });
    const result = await adapter.send(spans, null);
    expect(result.errorKind).toBeNull();
    expect(result.dispositions.map((d) => spanDispositionText(d.disposition))).toEqual([
      'exported@collector',
      'exported@collector',
      'exported@collector',
    ]);
    expect(calls).toHaveLength(1);
    expect(payloadSpanIds(calls[0])).toEqual(spans.map((span) => span.spanId));
  });

  it('rejects a non-branded span as invalid and never sends it', async () => {
    const real = makeSpan();
    const castLiteral = {
      traceId: 'fedcba9876543210fedcba9876543210',
      spanId: 'f0f0f0f0f0f0f0',
      parentSpanId: null,
      name: 'attempt',
      kind: 'AGENT',
      startIso: '2026-01-01T00:00:00Z',
      endIso: '2026-01-01T00:01:00Z',
      status: { code: 'unset', reasonCode: null },
      attributes: { 'fleet.seat.role': 'first-pass' },
      events: [],
    } as unknown as TelemetrySpan;
    const { post, calls } = scriptedPost([OK]);
    const adapter = new OtlpHttpRunTelemetryAdapter({ post, route: 'phoenix', resource: RESOURCE });
    const result = await adapter.send([castLiteral, real], null);
    expect(spanDispositionText(result.dispositions[0].disposition)).toBe('rejected:invalid');
    expect(spanDispositionText(result.dispositions[1].disposition)).toBe('exported@phoenix');
    expect(result.errorKind).toBeNull();
    expect(calls).toHaveLength(1);
    expect(payloadSpanIds(calls[0])).toEqual([real.spanId]);
  });

  it('refuses a malformed deadline without posting; every span stays pending', async () => {
    const spans = [makeSpan(), makeSpan()];
    const calls: Uint8Array[] = [];
    const post: OtlpPost = async (payload) => {
      calls.push(payload);
      return OK;
    };
    const adapter = new OtlpHttpRunTelemetryAdapter({ post, route: 'collector', resource: RESOURCE });
    const result = await adapter.send(spans, { atMs: 'nope' } as unknown as RunTelemetrySendDeadline);
    expect(result.errorKind).toBeNull();
    expect(result.dispositions.map((d) => spanDispositionText(d.disposition))).toEqual(['pending', 'pending']);
    expect(calls).toHaveLength(0);
  });

  it('drops the oldest spans past the queue bound as pending and counts them', async () => {
    const spans = [makeSpan(), makeSpan(), makeSpan(), makeSpan(), makeSpan()];
    const { post, calls } = scriptedPost([OK]);
    const adapter = new OtlpHttpRunTelemetryAdapter({ post, route: 'collector', resource: RESOURCE, maxQueueSpans: 3 });
    const result = await adapter.send(spans, null);
    expect(result.dispositions.map((d) => spanDispositionText(d.disposition))).toEqual([
      'pending',
      'pending',
      'exported@collector',
      'exported@collector',
      'exported@collector',
    ]);
    expect(result.errorKind).toBeNull();
    expect(calls).toHaveLength(1);
    expect(payloadSpanIds(calls[0])).toEqual([spans[2].spanId, spans[3].spanId, spans[4].spanId]);
    expect(adapter.takeCounters()).toEqual({ queueDrops: 2, errorKinds: {} });
  });

  it('batches into maxBatchSpans-sized payloads in input order', async () => {
    const spans = Array.from({ length: 1100 }, () => makeSpan());
    const { post, calls } = scriptedPost([OK, OK, OK]);
    const adapter = new OtlpHttpRunTelemetryAdapter({ post, route: 'collector', resource: RESOURCE, maxBatchSpans: 512 });
    const result = await adapter.send(spans, null);
    expect(result.errorKind).toBeNull();
    expect(calls).toHaveLength(3);
    expect(calls.map((payload) => payloadSpanIds(payload).length)).toEqual([512, 512, 76]);
    expect(calls.flatMap(payloadSpanIds)).toEqual(spans.map((span) => span.spanId));
    expect(result.dispositions.every((d) => spanDispositionText(d.disposition) === 'exported@collector')).toBe(true);
  });

  it('splits an over-byte-limit batch and rejects a single over-limit span as too-large', async () => {
    const a = makeSpan();
    const b = makeSpan();
    const twoSize = encodeOtlpTraces([a, b], RESOURCE).payload!.byteLength;
    const oneSize = encodeOtlpTraces([a], RESOURCE).payload!.byteLength;

    const { post, calls } = scriptedPost([OK, OK]);
    const adapter = new OtlpHttpRunTelemetryAdapter({ post, route: 'collector', resource: RESOURCE, maxBatchBytes: twoSize - 1 });
    const result = await adapter.send([a, b], null);
    expect(result.errorKind).toBeNull();
    expect(result.dispositions.map((d) => spanDispositionText(d.disposition))).toEqual([
      'exported@collector',
      'exported@collector',
    ]);
    expect(calls).toHaveLength(2);
    expect(payloadSpanIds(calls[0])).toEqual([a.spanId]);
    expect(payloadSpanIds(calls[1])).toEqual([b.spanId]);

    const singleCalls: Uint8Array[] = [];
    const singlePost: OtlpPost = async (payload) => {
      singleCalls.push(payload);
      return OK;
    };
    const singleAdapter = new OtlpHttpRunTelemetryAdapter({
      post: singlePost,
      route: 'collector',
      resource: RESOURCE,
      maxBatchBytes: oneSize - 1,
    });
    const singleResult = await singleAdapter.send([a], null);
    expect(spanDispositionText(singleResult.dispositions[0].disposition)).toBe('rejected:too-large');
    expect(singleResult.errorKind).toBeNull();
    expect(singleCalls).toHaveLength(0);
  });

  it('splits a batch on a 2xx partial success and maps each single-span result', async () => {
    const spans = [makeSpan(), makeSpan(), makeSpan()];
    const { post, calls } = scriptedPost([
      { kind: 'http', status: 200, retryAfterSeconds: null, rejectedSpans: 2 },
      { kind: 'http', status: 200, retryAfterSeconds: null, rejectedSpans: 0 },
      { kind: 'http', status: 200, retryAfterSeconds: null, rejectedSpans: 1 },
      { kind: 'http', status: 400, retryAfterSeconds: null, rejectedSpans: null },
    ]);
    const adapter = new OtlpHttpRunTelemetryAdapter({ post, route: 'phoenix', resource: RESOURCE });
    const result = await adapter.send(spans, null);
    expect(calls).toHaveLength(4);
    expect(calls.slice(1).map((payload) => payloadSpanIds(payload).length)).toEqual([1, 1, 1]);
    expect(result.dispositions.map((d) => spanDispositionText(d.disposition))).toEqual([
      'exported@phoenix',
      'rejected:partial-rejected',
      'rejected:http-4xx',
    ]);
    expect(result.errorKind).toBe('partial');
  });

  it('treats a 2xx with rejectedSpans 0 as a full export without splitting', async () => {
    const spans = [makeSpan(), makeSpan(), makeSpan()];
    const { post, calls } = scriptedPost([{ kind: 'http', status: 200, retryAfterSeconds: null, rejectedSpans: 0 }]);
    const adapter = new OtlpHttpRunTelemetryAdapter({ post, route: 'collector', resource: RESOURCE });
    const result = await adapter.send(spans, null);
    expect(calls).toHaveLength(1);
    expect(result.dispositions.map((d) => spanDispositionText(d.disposition))).toEqual([
      'exported@collector',
      'exported@collector',
      'exported@collector',
    ]);
    expect(result.errorKind).toBeNull();
  });

  it('trips the OT3b-2 breaker on three single-span 400s in a split: the three spans go back to pending', async () => {
    const spans = [makeSpan(), makeSpan(), makeSpan()];
    const { post, calls } = scriptedPost([
      { kind: 'http', status: 400, retryAfterSeconds: null, rejectedSpans: null },
      { kind: 'http', status: 400, retryAfterSeconds: null, rejectedSpans: null },
      { kind: 'http', status: 400, retryAfterSeconds: null, rejectedSpans: null },
      { kind: 'http', status: 400, retryAfterSeconds: null, rejectedSpans: null },
    ]);
    const adapter = new OtlpHttpRunTelemetryAdapter({ post, route: 'collector', resource: RESOURCE });
    const result = await adapter.send(spans, null);
    expect(calls).toHaveLength(4);
    expect(result.dispositions.map((d) => spanDispositionText(d.disposition))).toEqual([
      'pending',
      'pending',
      'pending',
    ]);
    expect(result.errorKind).toBe('http-4xx');
  });

  it('maps a single-span 400 to rejected:http-4xx', async () => {
    const span = makeSpan();
    const { post, calls } = scriptedPost([{ kind: 'http', status: 400, retryAfterSeconds: null, rejectedSpans: null }]);
    const adapter = new OtlpHttpRunTelemetryAdapter({ post, route: 'collector', resource: RESOURCE });
    const result = await adapter.send([span], null);
    expect(spanDispositionText(result.dispositions[0].disposition)).toBe('rejected:http-4xx');
    expect(result.errorKind).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('maps a single-span 413 to rejected:too-large', async () => {
    const span = makeSpan();
    const { post, calls } = scriptedPost([{ kind: 'http', status: 413, retryAfterSeconds: null, rejectedSpans: null }]);
    const adapter = new OtlpHttpRunTelemetryAdapter({ post, route: 'collector', resource: RESOURCE });
    const result = await adapter.send([span], null);
    expect(spanDispositionText(result.dispositions[0].disposition)).toBe('rejected:too-large');
    expect(result.errorKind).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('stops on a 401: everything stays pending, error kind auth, nothing more posted', async () => {
    const spans = Array.from({ length: 600 }, () => makeSpan());
    const { post, calls } = scriptedPost([{ kind: 'http', status: 401, retryAfterSeconds: null, rejectedSpans: null }]);
    const adapter = new OtlpHttpRunTelemetryAdapter({ post, route: 'collector', resource: RESOURCE });
    const result = await adapter.send(spans, null);
    expect(calls).toHaveLength(1);
    expect(result.errorKind).toBe('auth');
    expect(result.dispositions).toHaveLength(600);
    expect(result.dispositions.every((d) => spanDispositionText(d.disposition) === 'pending')).toBe(true);
  });

  it('keeps spans pending with error kind http-4xx on a 404', async () => {
    const spans = [makeSpan(), makeSpan()];
    const { post, calls } = scriptedPost([{ kind: 'http', status: 404, retryAfterSeconds: null, rejectedSpans: null }]);
    const adapter = new OtlpHttpRunTelemetryAdapter({ post, route: 'collector', resource: RESOURCE });
    const result = await adapter.send(spans, null);
    expect(result.errorKind).toBe('http-4xx');
    expect(result.dispositions.map((d) => spanDispositionText(d.disposition))).toEqual(['pending', 'pending']);
    expect(calls).toHaveLength(1);
  });

  it('keeps spans pending with error kind http-5xx on a final 503', async () => {
    const spans = [makeSpan(), makeSpan()];
    const { post, calls } = scriptedPost([{ kind: 'http', status: 503, retryAfterSeconds: null, rejectedSpans: null }]);
    const adapter = new OtlpHttpRunTelemetryAdapter({ post, route: 'collector', resource: RESOURCE });
    const result = await adapter.send(spans, null);
    expect(result.errorKind).toBe('http-5xx');
    expect(result.dispositions.map((d) => spanDispositionText(d.disposition))).toEqual(['pending', 'pending']);
    expect(calls).toHaveLength(1);
  });

  it('maps timeout and network outcomes to pending spans with matching error kinds', async () => {
    const timeout = [makeSpan()];
    const { post: timeoutPost, calls: timeoutCalls } = scriptedPost([{ kind: 'timeout' }]);
    const timeoutAdapter = new OtlpHttpRunTelemetryAdapter({ post: timeoutPost, route: 'collector', resource: RESOURCE });
    const timeoutResult = await timeoutAdapter.send(timeout, null);
    expect(timeoutResult.errorKind).toBe('timeout');
    expect(spanDispositionText(timeoutResult.dispositions[0].disposition)).toBe('pending');
    expect(timeoutCalls).toHaveLength(1);

    const network = [makeSpan()];
    const { post: networkPost, calls: networkCalls } = scriptedPost([{ kind: 'network' }]);
    const networkAdapter = new OtlpHttpRunTelemetryAdapter({ post: networkPost, route: 'collector', resource: RESOURCE });
    const networkResult = await networkAdapter.send(network, null);
    expect(networkResult.errorKind).toBe('network');
    expect(spanDispositionText(networkResult.dispositions[0].disposition)).toBe('pending');
    expect(networkCalls).toHaveLength(1);
  });

  it('reads a throwing or rejecting post as a network failure', async () => {
    const spans = [makeSpan()];

    const { post: throwingPost, calls: throwingCalls } = scriptedPost(['throw']);
    const throwingAdapter = new OtlpHttpRunTelemetryAdapter({ post: throwingPost, route: 'collector', resource: RESOURCE });
    const throwingResult = await throwingAdapter.send(spans, null);
    expect(throwingResult.errorKind).toBe('network');
    expect(spanDispositionText(throwingResult.dispositions[0].disposition)).toBe('pending');
    expect(throwingCalls).toHaveLength(1);

    const rejectingPost: OtlpPost = async () => {
      throw new Error('rejected');
    };
    const rejectingAdapter = new OtlpHttpRunTelemetryAdapter({ post: rejectingPost, route: 'collector', resource: RESOURCE });
    const rejectingResult = await rejectingAdapter.send(spans, null);
    expect(rejectingResult.errorKind).toBe('network');
    expect(spanDispositionText(rejectingResult.dispositions[0].disposition)).toBe('pending');
  });

  it('stops a split resend on a stopping error, leaving every span pending', async () => {
    const spans = [makeSpan(), makeSpan(), makeSpan()];
    const { post, calls } = scriptedPost([
      { kind: 'http', status: 200, retryAfterSeconds: null, rejectedSpans: 2 },
      { kind: 'http', status: 401, retryAfterSeconds: null, rejectedSpans: null },
    ]);
    const adapter = new OtlpHttpRunTelemetryAdapter({ post, route: 'collector', resource: RESOURCE });
    const result = await adapter.send(spans, null);
    expect(calls).toHaveLength(2);
    expect(result.errorKind).toBe('auth');
    expect(result.dispositions.map((d) => spanDispositionText(d.disposition))).toEqual(['pending', 'pending', 'pending']);
  });

  it('serialises concurrent send calls: the second post begins after the first resolves', async () => {
    const events: string[] = [];
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const post: OtlpPost = async (_payload) => {
      events.push('start');
      started();
      await gate;
      events.push('end');
      return OK;
    };
    const adapter = new OtlpHttpRunTelemetryAdapter({ post, route: 'collector', resource: RESOURCE });

    const first = adapter.send([makeSpan()], null);
    await startedPromise;
    const second = adapter.send([makeSpan()], null);
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(events).toEqual(['start', 'end', 'start', 'end']);
    expect(spanDispositionText(firstResult.dispositions[0].disposition)).toBe('exported@collector');
    expect(spanDispositionText(secondResult.dispositions[0].disposition)).toBe('exported@collector');
  });

  it('takeCounters returns and resets the accumulated counters', async () => {
    const span = makeSpan();
    const queueSpans = Array.from({ length: 5 }, () => makeSpan());
    const { post } = scriptedPost([{ kind: 'timeout' }, OK]);
    const adapter = new OtlpHttpRunTelemetryAdapter({ post, route: 'collector', resource: RESOURCE, maxQueueSpans: 3 });

    await adapter.send([span], null);
    await adapter.send(queueSpans, null);

    const counters = adapter.takeCounters();
    expect(counters).toEqual({ queueDrops: 2, errorKinds: { timeout: 1 } });
    expect(adapter.takeCounters()).toEqual({ queueDrops: 0, errorKinds: {} });
  });
});
