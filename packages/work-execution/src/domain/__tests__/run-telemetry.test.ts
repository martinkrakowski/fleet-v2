/**
 * Tests for the nominal `TelemetrySpan` and `pricingSafe` (OT1a-3).
 * Names are `example` names only; no hosts, ports or accounts.
 */

import { describe, expect, it } from 'vitest';
import { TelemetrySpan, pricingSafe } from '../run-telemetry.js';
import type { TelemetrySpanInput } from '../run-telemetry.js';

const T = 'a'.repeat(32);
const S = 'b'.repeat(16);
const P = 'c'.repeat(16);

const base: TelemetrySpanInput = {
  traceId: T,
  spanId: S,
  parentSpanId: P,
  name: 'attempt',
  kind: 'AGENT',
  startIso: '2026-10-27T10:00:00Z',
  endIso: '2026-10-27T12:30:00+02:00',
  status: { code: 'ok', reasonCode: null },
  attributes: { 'fleet.seat.role': 'first-pass', 'agent.name': 'first-pass' },
  events: [],
};

function mustBuild(input: unknown): TelemetrySpan {
  const span = TelemetrySpan.build(input);
  expect(span).not.toBeNull();
  return span as TelemetrySpan;
}

describe('TelemetrySpan.build', () => {
  it('builds a frozen span with normalised times and the builder-owned keys', () => {
    const span = mustBuild(base);
    expect(Object.isFrozen(span)).toBe(true);
    expect(span.startIso).toBe('2026-10-27T10:00:00.000Z');
    expect(span.endIso).toBe('2026-10-27T10:30:00.000Z');
    expect(span.attributes['openinference.span.kind']).toBe('AGENT');
    expect(span.attributes['fleet.telemetry.schema']).toBe(1);
    expect(span.attributes['fleet.seat.role']).toBe('first-pass');
    expect(span.attributes['agent.name']).toBe('first-pass');
    expect(Object.isFrozen(span.status)).toBe(true);
    expect(Object.isFrozen(span.attributes)).toBe(true);
  });

  it('ignores input values for the builder-owned keys', () => {
    const span = mustBuild({
      ...base,
      attributes: { ...base.attributes, 'openinference.span.kind': 'LLM', 'fleet.telemetry.schema': 99 },
    });
    expect(span.attributes['openinference.span.kind']).toBe('AGENT');
    expect(span.attributes['fleet.telemetry.schema']).toBe(1);
  });

  it.each([
    ['a 31-char trace id', { ...base, traceId: 'a'.repeat(31) }],
    ['an uppercase trace id', { ...base, traceId: T.toUpperCase() }],
    ['an all-zero trace id', { ...base, traceId: '0'.repeat(32) }],
    ['an all-zero span id', { ...base, spanId: '0'.repeat(16) }],
    ['a parent span id equal to the span id', { ...base, parentSpanId: S }],
    ['an unknown span name', { ...base, name: 'brief' }],
    ['a lowercase kind', { ...base, kind: 'llm' }],
    ['a start time without a zone', { ...base, startIso: '2026-10-27T10:00:00' }],
    ['an impossible calendar date', { ...base, startIso: '2026-02-31T10:00:00Z' }],
    ['an end before the start', { ...base, endIso: '2026-10-27T08:00:00Z' }],
    ['an unknown status code', { ...base, status: { code: 'warn', reasonCode: null } }],
    ['a free-text reason code', { ...base, status: { code: 'ok', reasonCode: 'Free text' } }],
    ['an event with an unknown name', { ...base, events: [{ name: 'log', timeIso: '2026-10-27T10:00:00Z', state: 'running' }] }],
    ['an event with a bad state', { ...base, events: [{ name: 'state.entered', timeIso: '2026-10-27T10:00:00Z', state: 'not-a-state' }] }],
    ['65 events', { ...base, events: Array.from({ length: 65 }, () => ({ name: 'state.entered', timeIso: '2026-10-27T10:00:00Z', state: 'running' })) }],
    ['an extra input key', { ...base, extra: 1 }],
    [
      'a missing input key',
      (() => {
        const missing = { ...base } as Record<string, unknown>;
        delete missing.spanId;
        return missing;
      })(),
    ],
    ['null', null],
    ['an array', []],
  ])('refuses %s with null', (_label, input) => {
    expect(TelemetrySpan.build(input)).toBeNull();
  });

  it('refuses an input with a throwing getter without throwing', () => {
    const input = { ...base } as Record<string, unknown>;
    Object.defineProperty(input, 'traceId', {
      enumerable: true,
      get: () => {
        throw new Error('getter');
      },
    });
    expect(TelemetrySpan.build(input)).toBeNull();
  });

  it('refuses a proxy whose ownKeys throws without throwing', () => {
    const proxy = new Proxy({}, {
      ownKeys: () => {
        throw new Error('ownKeys');
      },
    });
    expect(TelemetrySpan.build(proxy)).toBeNull();
  });

  it('filters never-sent attributes and keeps the span', () => {
    const span = mustBuild({
      ...base,
      attributes: {
        'input.value': 'CANARY-prompt',
        'fleet.worktree': 'CANARY-path',
        'fleet.seat.role': 'first-pass',
      },
    });
    expect(span.attributes['fleet.seat.role']).toBe('first-pass');
    expect(JSON.stringify(span.attributes)).not.toContain('CANARY');
  });

  it('normalises event times and freezes the events', () => {
    const span = mustBuild({
      ...base,
      events: [{ name: 'state.entered', timeIso: '2026-10-27T12:30:00+02:00', state: 'running' }],
    });
    expect(span.events[0]?.timeIso).toBe('2026-10-27T10:30:00.000Z');
    expect(Object.isFrozen(span.events)).toBe(true);
    expect(Object.isFrozen(span.events[0])).toBe(true);
  });

  it('stores the first-read status snapshot and never re-reads the status', () => {
    const reads: Record<string, number> = { code: 0, reasonCode: 0 };
    const target = { code: 'ok', reasonCode: null };
    const status = new Proxy(target, {
      getOwnPropertyDescriptor(t, key) {
        const name = String(key);
        reads[name] = (reads[name] ?? 0) + 1;
        // 'code' is valid on the first read and invalid on any later one.
        const value = name === 'code' && reads.code > 1 ? 'warn' : Reflect.get(t, key);
        return { configurable: true, enumerable: true, writable: true, value };
      },
    });
    const span = mustBuild({ ...base, status });
    expect(span.status.code).toBe('ok');
    expect(span.status.reasonCode).toBeNull();
    expect(reads.code).toBe(1);
    expect(reads.reasonCode).toBe(1);
  });

  it('refuses an events array whose iterator yields a valid event while the index holds an invalid one', () => {
    const events = [
      { name: 'log', timeIso: '2026-10-27T10:00:00Z', state: 'running' },
    ] as unknown as TelemetrySpanInput['events'];
    Object.defineProperty(events, Symbol.iterator, {
      value: function* () {
        yield { name: 'state.entered', timeIso: '2026-10-27T10:00:00Z', state: 'running' };
      },
    });
    expect(TelemetrySpan.build({ ...base, events })).toBeNull();
  });

  it('refuses an events array with an accessor at an index', () => {
    const events: unknown[] = [];
    Object.defineProperty(events, 0, {
      enumerable: true,
      get: () => ({ name: 'state.entered', timeIso: '2026-10-27T10:00:00Z', state: 'running' }),
    });
    expect(TelemetrySpan.build({ ...base, events })).toBeNull();
  });

  it('reads the events length once, so a proxy cannot pass the bound and then grow the loop', () => {
    const event = { name: 'state.entered', timeIso: '2026-10-27T10:00:00Z', state: 'running' };
    const target = Array.from({ length: 65 }, () => ({ ...event }));
    let lengthReads = 0;
    const events = new Proxy(target, {
      get(t, key, receiver) {
        if (key === 'length') {
          lengthReads += 1;
          // In bounds on the first read, past the limit on any later one.
          return lengthReads === 1 ? 1 : 65;
        }
        return Reflect.get(t, key, receiver);
      },
    }) as unknown as TelemetrySpanInput['events'];
    const span = mustBuild({ ...base, events });
    expect(span.events).toHaveLength(1);
    expect(lengthReads).toBe(1);
  });
});

describe('TelemetrySpan.isTelemetrySpan', () => {
  it('is true only for an instance built here', () => {
    const span = mustBuild(base);
    expect(TelemetrySpan.isTelemetrySpan(span)).toBe(true);
    const literal = {
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      kind: span.kind,
      startIso: span.startIso,
      endIso: span.endIso,
      status: span.status,
      attributes: span.attributes,
      events: span.events,
    } as unknown as TelemetrySpan;
    expect(TelemetrySpan.isTelemetrySpan(literal)).toBe(false);
    expect(TelemetrySpan.isTelemetrySpan({ ...span })).toBe(false);
    expect(TelemetrySpan.isTelemetrySpan(Object.create(TelemetrySpan.prototype))).toBe(false);
    expect(TelemetrySpan.isTelemetrySpan(null)).toBe(false);
    expect(TelemetrySpan.isTelemetrySpan({})).toBe(false);
  });
});

describe('pricingSafe', () => {
  it('is true for a metered LLM span carrying model and cost keys', () => {
    const span = mustBuild({
      ...base,
      name: 'usage',
      kind: 'LLM',
      attributes: {
        'fleet.seat.billing': 'metered',
        'llm.model_name': 'openrouter/z-ai/glm-5.3-flash',
        'llm.cost.total': 0.12,
        'fleet.seat.role': 'first-pass',
      },
    });
    expect(pricingSafe(span)).toBe(true);
  });

  it('is true for an AGENT span without priced keys', () => {
    expect(pricingSafe(mustBuild(base))).toBe(true);
  });

  it.each([
    ['an AGENT span carrying a model name', { kind: 'AGENT', attributes: { 'llm.model_name': 'x' } }],
    ['a plan-billed LLM span with a cost', { kind: 'LLM', attributes: { 'fleet.seat.billing': 'plan', 'llm.cost.total': 1 } }],
    ['an LLM span with a prompt cost and no billing', { kind: 'LLM', attributes: { 'llm.cost.prompt': 1 } }],
    ['null attributes', { kind: 'LLM', attributes: null }],
    ['an AGENT span carrying a provider', { kind: 'AGENT', attributes: { 'llm.provider': 'x' } }],
    ['an AGENT span with a non-enumerable cost', { kind: 'AGENT', attributes: Object.defineProperty({}, 'llm.cost.total', { value: 1, enumerable: false }) }],
  ])('is false for %s', (_label, span) => {
    expect(pricingSafe(span)).toBe(false);
  });

  it('is false when an attribute getter throws', () => {
    const attributes: Record<string, unknown> = {};
    Object.defineProperty(attributes, 'fleet.seat.billing', {
      enumerable: true,
      get: () => {
        throw new Error('getter');
      },
    });
    expect(pricingSafe({ kind: 'LLM', attributes })).toBe(false);
  });
});
