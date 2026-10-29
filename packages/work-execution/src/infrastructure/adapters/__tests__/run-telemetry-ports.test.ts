/**
 * Tests for the telemetry mark and send ports and their four adapters
 * (lane OT2a-2, plan §3.3 "Application", §3.5). Fixture ids are hex only;
 * no hosts, ports or accounts.
 */

import { describe, expect, it } from 'vitest';

import { TelemetrySpan } from '../../../domain/run-telemetry.js';
import type { TelemetrySpanInput } from '../../../domain/run-telemetry.js';
import type { RunTelemetryMarkTarget } from '../../../application/ports/out/RunTelemetryMarkPort.out-port.js';
import { InMemoryRunTelemetryMarkAdapter } from '../InMemoryRunTelemetryMarkAdapter.adapter.js';
import { NoopRunTelemetryMarkAdapter } from '../NoopRunTelemetryMarkAdapter.adapter.js';
import { NoopRunTelemetryAdapter } from '../NoopRunTelemetryAdapter.adapter.js';
import { RecordingRunTelemetryAdapter } from '../RecordingRunTelemetryAdapter.adapter.js';

const TRACE = 'a'.repeat(32);

function spanInput(spanId: string): TelemetrySpanInput {
  return {
    traceId: TRACE,
    spanId,
    parentSpanId: null,
    name: 'attempt',
    kind: 'AGENT',
    startIso: '2026-10-27T10:00:00Z',
    endIso: '2026-10-27T10:30:00Z',
    status: { code: 'ok', reasonCode: null },
    attributes: {},
    events: [],
  };
}

function mustBuild(spanId: string): TelemetrySpan {
  const span = TelemetrySpan.build(spanInput(spanId));
  expect(span).not.toBeNull();
  return span as TelemetrySpan;
}

/** A nonzero fixture hex span id. */
function hexSpanId(n: number): string {
  return n.toString(16).padStart(16, '0');
}

function runTarget(id: string): RunTelemetryMarkTarget {
  return { kind: 'run', runId: id };
}

describe.each([
  ['NoopRunTelemetryMarkAdapter', () => new NoopRunTelemetryMarkAdapter()],
  ['InMemoryRunTelemetryMarkAdapter', () => new InMemoryRunTelemetryMarkAdapter()],
])('%s (RunTelemetryMarkPort common cases)', (_label, makeAdapter) => {
  it('mark never throws for a null target', () => {
    const adapter = makeAdapter();
    expect(() => adapter.mark(null as unknown as RunTelemetryMarkTarget)).not.toThrow();
  });

  it('mark never throws for {}', () => {
    const adapter = makeAdapter();
    expect(() => adapter.mark({} as unknown as RunTelemetryMarkTarget)).not.toThrow();
  });

  it('mark never throws for an oversized id', () => {
    const adapter = makeAdapter();
    expect(() => adapter.mark(runTarget('x'.repeat(257)))).not.toThrow();
  });

  it('mark never throws for a valid run and attempt target', () => {
    const adapter = makeAdapter();
    expect(() => adapter.mark(runTarget('example-run'))).not.toThrow();
    expect(() => adapter.mark({ kind: 'attempt', attemptId: 'example-attempt' })).not.toThrow();
  });
});

describe('InMemoryRunTelemetryMarkAdapter', () => {
  it('drain returns the queued ids in mark order and clears them', () => {
    const adapter = new InMemoryRunTelemetryMarkAdapter();
    adapter.mark(runTarget('example-run'));
    adapter.mark({ kind: 'attempt', attemptId: 'example-attempt' });
    expect(adapter.stats()).toEqual({ capacity: 4096, held: 2, droppedMarks: 0 });
    expect(adapter.drain()).toEqual(['example-run', 'example-attempt']);
    expect(adapter.drain()).toEqual([]);
    expect(adapter.stats()).toEqual({ capacity: 4096, held: 0, droppedMarks: 0 });
  });

  it('a duplicate mark is stored once', () => {
    const adapter = new InMemoryRunTelemetryMarkAdapter();
    adapter.mark(runTarget('example-run'));
    adapter.mark(runTarget('example-run'));
    expect(adapter.stats()).toEqual({ capacity: 4096, held: 1, droppedMarks: 0 });
    expect(adapter.drain()).toEqual(['example-run']);
  });

  it('the 4097th distinct mark drops the oldest and counts the drop', () => {
    const adapter = new InMemoryRunTelemetryMarkAdapter();
    for (let n = 1; n <= 4097; n++) {
      adapter.mark(runTarget(`example-run-${n}`));
    }
    expect(adapter.stats()).toEqual({ capacity: 4096, held: 4096, droppedMarks: 1 });
    const drained = adapter.drain();
    expect(drained).toHaveLength(4096);
    expect(drained[0]).toBe('example-run-2');
    expect(drained[drained.length - 1]).toBe('example-run-4097');
  });

  it('a configured capacity outside 1 to 65536 falls back to 4096', () => {
    expect(new InMemoryRunTelemetryMarkAdapter({ capacity: 0 }).stats().capacity).toBe(4096);
    expect(new InMemoryRunTelemetryMarkAdapter({ capacity: 65537 }).stats().capacity).toBe(4096);
    expect(new InMemoryRunTelemetryMarkAdapter({ capacity: 3.5 }).stats().capacity).toBe(4096);
  });

  it('a configured capacity bounds the set and counts every drop', () => {
    const adapter = new InMemoryRunTelemetryMarkAdapter({ capacity: 2 });
    adapter.mark(runTarget('a'));
    adapter.mark(runTarget('b'));
    adapter.mark(runTarget('c'));
    expect(adapter.stats()).toEqual({ capacity: 2, held: 2, droppedMarks: 1 });
    expect(adapter.drain()).toEqual(['b', 'c']);
  });

  it('mark never throws for a throwing onMark and still queues the mark', () => {
    const adapter = new InMemoryRunTelemetryMarkAdapter({
      onMark: () => {
        throw new Error('example wake failure');
      },
    });
    expect(() => adapter.mark(runTarget('example-run'))).not.toThrow();
    expect(adapter.drain()).toEqual(['example-run']);
  });

  it('a bad target is silently ignored and queues nothing', () => {
    const adapter = new InMemoryRunTelemetryMarkAdapter();
    adapter.mark({ kind: 'other', runId: 'example-run' } as unknown as RunTelemetryMarkTarget);
    adapter.mark(runTarget(''));
    expect(adapter.drain()).toEqual([]);
  });
});

describe('NoopRunTelemetryAdapter', () => {
  it('returns all sendable spans pending with a null error kind', async () => {
    const adapter = new NoopRunTelemetryAdapter();
    const first = mustBuild(hexSpanId(1));
    const second = mustBuild(hexSpanId(2));
    const result = await adapter.send([first, second], { atMs: 1000 });
    expect(result.dispositions).toEqual([
      { spanId: first.spanId, disposition: { state: 'pending' } },
      { spanId: second.spanId, disposition: { state: 'pending' } },
    ]);
    expect(result.errorKind).toBeNull();
  });

  it('keeps the input order when a span is invalid among valid ones', async () => {
    const adapter = new NoopRunTelemetryAdapter();
    const first = mustBuild(hexSpanId(1));
    const fake = { spanId: 'c'.repeat(16) } as unknown as TelemetrySpan;
    const third = mustBuild(hexSpanId(3));
    const result = await adapter.send([first, fake, third], null);
    expect(result.dispositions).toEqual([
      { spanId: first.spanId, disposition: { state: 'pending' } },
      { spanId: 'c'.repeat(16), disposition: { state: 'rejected', reason: 'invalid' } },
      { spanId: third.spanId, disposition: { state: 'pending' } },
    ]);
    expect(result.errorKind).toBeNull();
  });
});

describe('RecordingRunTelemetryAdapter', () => {
  it('returns exported@collector by default', async () => {
    const adapter = new RecordingRunTelemetryAdapter();
    const span = mustBuild(hexSpanId(1));
    const result = await adapter.send([span], null);
    expect(result.dispositions).toEqual([{ spanId: span.spanId, disposition: { state: 'exported', route: 'collector' } }]);
    expect(result.errorKind).toBeNull();
  });

  it('follows a script across successive spans and falls back to the default', async () => {
    const adapter = new RecordingRunTelemetryAdapter({
      script: ['error-timeout', { state: 'exported', route: 'phoenix' }, { state: 'rejected', reason: 'http-4xx' }],
    });
    const spans = [mustBuild(hexSpanId(1)), mustBuild(hexSpanId(2)), mustBuild(hexSpanId(3)), mustBuild(hexSpanId(4))];
    const result = await adapter.send(spans, null);
    expect(result.dispositions).toEqual([
      { spanId: spans[0]!.spanId, disposition: { state: 'pending' } },
      { spanId: spans[1]!.spanId, disposition: { state: 'exported', route: 'phoenix' } },
      { spanId: spans[2]!.spanId, disposition: { state: 'rejected', reason: 'http-4xx' } },
      { spanId: spans[3]!.spanId, disposition: { state: 'exported', route: 'collector' } },
    ]);
    expect(result.errorKind).toBe('timeout');
  });

  it('records the calls in order, keeping the span references', async () => {
    const adapter = new RecordingRunTelemetryAdapter();
    const first = [mustBuild(hexSpanId(1)), mustBuild(hexSpanId(2))];
    const second = [mustBuild(hexSpanId(3))];
    await adapter.send(first, { atMs: 1000 });
    await adapter.send(second, null);
    const calls = adapter.calls();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.spans[0]).toBe(first[0]);
    expect(calls[0]!.spans[1]).toBe(first[1]);
    expect(calls[0]!.deadline).toEqual({ atMs: 1000 });
    expect(calls[1]!.spans).toHaveLength(1);
    expect(TelemetrySpan.isTelemetrySpan(calls[1]!.spans[0])).toBe(true);
    expect(calls[1]!.deadline).toBeNull();
  });

  it('does not record a call refused for a malformed deadline', async () => {
    const adapter = new RecordingRunTelemetryAdapter();
    const span = mustBuild(hexSpanId(1));
    const result = await adapter.send([span], { atMs: 'soon' } as unknown as { atMs: number });
    expect(result.dispositions).toEqual([{ spanId: span.spanId, disposition: { state: 'pending' } }]);
    expect(result.errorKind).toBeNull();
    expect(adapter.calls()).toHaveLength(0);
  });
});

describe.each([
  ['NoopRunTelemetryAdapter', () => new NoopRunTelemetryAdapter()],
  ['RecordingRunTelemetryAdapter', () => new RecordingRunTelemetryAdapter()],
])('%s (RunTelemetryPort invalid spans)', (_label, makeAdapter) => {
  it('a plain object cast as a span is rejected:invalid with its own span id', async () => {
    const adapter = makeAdapter();
    const fake = { spanId: 'c'.repeat(16) } as unknown as TelemetrySpan;
    const result = await adapter.send([fake], null);
    expect(result.dispositions).toEqual([
      { spanId: 'c'.repeat(16), disposition: { state: 'rejected', reason: 'invalid' } },
    ]);
    expect(result.errorKind).toBeNull();
  });

  it('an invalid span without a hex span id falls back to the zero span id', async () => {
    const adapter = makeAdapter();
    const fake = { spanId: 'not-hex' } as unknown as TelemetrySpan;
    const result = await adapter.send([fake], null);
    expect(result.dispositions).toEqual([
      { spanId: '0000000000000000', disposition: { state: 'rejected', reason: 'invalid' } },
    ]);
  });

  it('never throws or rejects for null and {} inputs', async () => {
    const adapter = makeAdapter();
    const result = await adapter.send([null, {}] as unknown as readonly TelemetrySpan[], null);
    expect(result.dispositions).toEqual([
      { spanId: '0000000000000000', disposition: { state: 'rejected', reason: 'invalid' } },
      { spanId: '0000000000000000', disposition: { state: 'rejected', reason: 'invalid' } },
    ]);
  });
});
