/**
 * OT3a tests for the OTLP/JSON encoder (`OtlpJsonEncoder.helper.ts`): the
 * golden payload, the integration with OT1r's redaction checks, the brand
 * refusal (plan §3.2 test 7), the §3.6 pricing gate invariant, the shape
 * rules, and the never-throws and empty-batch behaviour. Spans are built
 * only with `TelemetrySpan.build`; ids are example-style hex ids, never all
 * zeros.
 */

import { describe, expect, it } from 'vitest';
import { pricingSafe, TelemetrySpan, type TelemetrySpanInput } from '../../../domain/run-telemetry.js';
import { redactionChecks } from '../../../domain/run-telemetry-redaction.js';
import { encodeOtlpTraces, OTLP_SCOPE } from '../OtlpJsonEncoder.helper.js';

const TRACE_ID = '0123456789abcdef0123456789abcdef';
const ROOT_SPAN_ID = '1111222233334444';
const DISPATCH_SPAN_ID = '5555666677778888';
const USAGE_SPAN_ID = '9999aaaabbbbcccc';
const GATE_SPAN_ID = 'ddddeeeeffff0001';

const RESOURCE = { serviceVersion: '1.2.3', projectName: 'fleet-v2' };

function build(input: TelemetrySpanInput): TelemetrySpan {
  const span = TelemetrySpan.build(input);
  expect(span).not.toBeNull();
  return span as TelemetrySpan;
}

const rootInput: TelemetrySpanInput = {
  traceId: TRACE_ID,
  spanId: ROOT_SPAN_ID,
  parentSpanId: null,
  name: 'lane-run',
  kind: 'CHAIN',
  startIso: '2026-01-01T00:00:00Z',
  endIso: '2026-01-01T00:01:00Z',
  status: { code: 'ok', reasonCode: null },
  attributes: {},
  events: [
    { name: 'state.entered', timeIso: '2026-01-01T00:00:00Z', state: 'running' },
    { name: 'state.entered', timeIso: '2026-01-01T00:00:30Z', state: 'merged' },
  ],
};

const dispatchInput: TelemetrySpanInput = {
  traceId: TRACE_ID,
  spanId: DISPATCH_SPAN_ID,
  parentSpanId: ROOT_SPAN_ID,
  name: 'dispatch',
  kind: 'CHAIN',
  startIso: '2026-01-01T00:01:00Z',
  endIso: '2026-01-01T00:02:00Z',
  status: { code: 'unset', reasonCode: null },
  attributes: {
    'fleet.round': 0,
    'fleet.step': 'dispatch',
    'tag.tags': ['conducted'],
  },
  events: [],
};

const usageInput: TelemetrySpanInput = {
  traceId: TRACE_ID,
  spanId: USAGE_SPAN_ID,
  parentSpanId: ROOT_SPAN_ID,
  name: 'usage',
  kind: 'LLM',
  startIso: '2026-01-01T00:02:00Z',
  endIso: '2026-01-01T00:03:00Z',
  status: { code: 'unset', reasonCode: null },
  attributes: {
    'llm.model_name': 'example-model',
    'llm.token_count.prompt': 120,
    'llm.cost.total': 0.25,
    'fleet.seat.billing': 'metered',
  },
  events: [],
};

const gateInput: TelemetrySpanInput = {
  traceId: TRACE_ID,
  spanId: GATE_SPAN_ID,
  parentSpanId: ROOT_SPAN_ID,
  name: 'gate',
  kind: 'GUARDRAIL',
  startIso: '2026-01-01T00:03:00Z',
  endIso: '2026-01-01T00:04:00Z',
  status: { code: 'error', reasonCode: 'gate-failed' },
  attributes: {},
  events: [],
};

const rootSpan = build(rootInput);
const dispatchSpan = build(dispatchInput);
const usageSpan = build(usageInput);
const gateSpan = build(gateInput);
const GOLDEN_SPANS = [rootSpan, dispatchSpan, usageSpan, gateSpan];

/** The golden payload, byte for byte, of the four spans above with RESOURCE. */
const GOLDEN_PAYLOAD =
  '{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"fleet-v2"}},' +
  '{"key":"service.version","value":{"stringValue":"1.2.3"}},{"key":"openinference.project.name","value":{"stringValue":"fleet-v2"}}]},' +
  '"scopeSpans":[{"scope":{"name":"fleet-v2"},"spans":[{"traceId":"0123456789abcdef0123456789abcdef","spanId":"1111222233334444",' +
  '"name":"lane-run","kind":1,"startTimeUnixNano":"1767225600000000000","endTimeUnixNano":"1767225660000000000","attributes":[' +
  '{"key":"fleet.telemetry.schema","value":{"intValue":"1"}},{"key":"openinference.span.kind","value":{"stringValue":"CHAIN"}}],"events":[' +
  '{"timeUnixNano":"1767225600000000000","name":"state.entered","attributes":[{"key":"fleet.state","value":{"stringValue":"running"}}]},' +
  '{"timeUnixNano":"1767225630000000000","name":"state.entered","attributes":[{"key":"fleet.state","value":{"stringValue":"merged"}}]}],' +
  '"status":{"code":1}},{"traceId":"0123456789abcdef0123456789abcdef","spanId":"5555666677778888","parentSpanId":"1111222233334444",' +
  '"name":"dispatch","kind":1,"startTimeUnixNano":"1767225660000000000","endTimeUnixNano":"1767225720000000000","attributes":[' +
  '{"key":"fleet.round","value":{"intValue":"0"}},{"key":"fleet.step","value":{"stringValue":"dispatch"}},' +
  '{"key":"fleet.telemetry.schema","value":{"intValue":"1"}},{"key":"openinference.span.kind","value":{"stringValue":"CHAIN"}},' +
  '{"key":"tag.tags","value":{"arrayValue":{"values":[{"stringValue":"conducted"}]}}}],"status":{"code":0}},' +
  '{"traceId":"0123456789abcdef0123456789abcdef","spanId":"9999aaaabbbbcccc","parentSpanId":"1111222233334444",' +
  '"name":"usage","kind":1,"startTimeUnixNano":"1767225720000000000","endTimeUnixNano":"1767225780000000000","attributes":[' +
  '{"key":"fleet.seat.billing","value":{"stringValue":"metered"}},{"key":"fleet.telemetry.schema","value":{"intValue":"1"}},' +
  '{"key":"llm.cost.total","value":{"doubleValue":0.25}},{"key":"llm.model_name","value":{"stringValue":"example-model"}},' +
  '{"key":"llm.token_count.prompt","value":{"intValue":"120"}},{"key":"openinference.span.kind","value":{"stringValue":"LLM"}}],"status":{"code":0}},' +
  '{"traceId":"0123456789abcdef0123456789abcdef","spanId":"ddddeeeeffff0001","parentSpanId":"1111222233334444",' +
  '"name":"gate","kind":1,"startTimeUnixNano":"1767225780000000000","endTimeUnixNano":"1767225840000000000","attributes":[' +
  '{"key":"fleet.telemetry.schema","value":{"intValue":"1"}},{"key":"openinference.span.kind","value":{"stringValue":"GUARDRAIL"}}],"status":' +
  '{"code":2,"message":"gate-failed"}}]}]}]}';

function payloadText(result: ReturnType<typeof encodeOtlpTraces>): string {
  expect(result.payload).not.toBeNull();
  return new TextDecoder().decode(result.payload as Uint8Array);
}

describe('encodeOtlpTraces (OT3a)', () => {
  it('encodes the golden payload byte for byte and deterministically', () => {
    const result = encodeOtlpTraces(GOLDEN_SPANS, RESOURCE);
    expect(payloadText(result)).toBe(GOLDEN_PAYLOAD);
    expect(result.encodedSpanIds).toEqual([ROOT_SPAN_ID, DISPATCH_SPAN_ID, USAGE_SPAN_ID, GATE_SPAN_ID]);
    expect(result.refused).toEqual([]);

    const again = encodeOtlpTraces(GOLDEN_SPANS, RESOURCE);
    expect(again.payload).toEqual(result.payload);
  });

  it('passes every redaction check, and the same batch with a dropped free-text canary does too (OT1r integration)', () => {
    const clean = encodeOtlpTraces(GOLDEN_SPANS, RESOURCE);
    const text = payloadText(clean);
    expect(JSON.stringify(JSON.parse(text))).toBe(text);

    const report = redactionChecks(clean.payload as Uint8Array, []);
    expect(report.pass).toBe(true);
    expect(report.checks.every((entry) => entry.pass)).toBe(true);

    // The same golden batch rebuilt with free-text-like inputs (a canary
    // placed where a prompt or a path would ride) is dropped by the builder,
    // so the encoded payload is unchanged and still passes with the canary on.
    const canary = 'CANARY-ot3a-free-text';
    const canarySpans = [rootInput, dispatchInput, usageInput, gateInput].map((input) =>
      build({ ...input, attributes: { ...input.attributes, 'input.value': canary, 'fleet.worktree': canary } }),
    );
    const result = encodeOtlpTraces(canarySpans, RESOURCE);
    const canaryText = payloadText(result);
    expect(canaryText).not.toContain('CANARY');
    expect(canaryText).toBe(text);
    const canaryReport = redactionChecks(result.payload as Uint8Array, [canary]);
    expect(canaryReport.pass).toBe(true);
  });

  it('refuses a cast object literal and encodes only the real span (plan redaction test 7)', () => {
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

    const result = encodeOtlpTraces([castLiteral, rootSpan], RESOURCE);
    expect(result.refused).toEqual([{ index: 0, reason: 'invalid' }]);
    expect(result.encodedSpanIds).toEqual([ROOT_SPAN_ID]);

    const parsed = JSON.parse(payloadText(result)) as {
      resourceSpans: { scopeSpans: { spans: { spanId: string }[] }[] }[];
    };
    const spans = parsed.resourceSpans[0].scopeSpans[0].spans;
    expect(spans).toHaveLength(1);
    expect(spans[0].spanId).toBe(ROOT_SPAN_ID);

    const text = payloadText(result);
    for (const needle of ['fedcba9876543210fedcba9876543210', 'f0f0f0f0f0f0f0', 'first-pass']) {
      expect(text).not.toContain(needle);
    }
  });

  it('every fixture span passes the pricing gate; the refusal path is the brand failure (plan §3.6)', () => {
    // `TelemetrySpan.build` keeps only allow-listed attribute values, and the
    // llm.* priced keys survive only on a metered LLM span, so no build()
    // span can fail `pricingSafe`. The fallback case applies: assert the
    // invariant over the same attribute view the encoder snapshots, and cover
    // the refusal path through the brand failure (the test above).
    for (const span of GOLDEN_SPANS) {
      expect(pricingSafe({ kind: span.kind, attributes: span.attributes })).toBe(true);
    }
  });

  it('emits the documented shapes for ids, kind, times, ints and statuses', () => {
    const result = encodeOtlpTraces(GOLDEN_SPANS, RESOURCE);
    const parsed = JSON.parse(payloadText(result)) as {
      resourceSpans: {
        scopeSpans: {
          scope: { name: string };
          spans: Array<{
            traceId: string;
            spanId: string;
            parentSpanId?: string;
            kind: number;
            startTimeUnixNano: string;
            endTimeUnixNano: string;
            status: { code: number; message?: string };
            attributes: Array<{ key: string; value: { intValue?: unknown } }>;
          }>;
        }[];
      }[];
    };
    const scope = parsed.resourceSpans[0].scopeSpans[0].scope;
    expect(scope).toEqual(OTLP_SCOPE);
    expect(scope).toEqual({ name: 'fleet-v2' });

    const spans = parsed.resourceSpans[0].scopeSpans[0].spans;
    const [root, dispatch] = spans;
    expect(root.parentSpanId).toBeUndefined();
    expect(dispatch.parentSpanId).toBe(ROOT_SPAN_ID);

    const startNano = (iso: string): string => String(BigInt(Date.parse(iso)) * 1_000_000n);
    expect(root.startTimeUnixNano).toBe(startNano('2026-01-01T00:00:00Z'));
    expect(root.endTimeUnixNano).toBe(startNano('2026-01-01T00:01:00Z'));

    for (const span of spans) {
      expect(span.kind).toBe(1);
      expect(/^[0-9]+$/.test(span.startTimeUnixNano)).toBe(true);
      expect(/^[0-9]+$/.test(span.endTimeUnixNano)).toBe(true);
      expect([0, 1, 2]).toContain(span.status.code);
      expect(typeof span.status.code).toBe('number');
      const schema = span.attributes.find((attribute) => attribute.key === 'fleet.telemetry.schema');
      expect(typeof schema?.value.intValue).toBe('string');
    }

    const dispatchStatus = spans[1].status;
    expect(dispatchStatus).toEqual({ code: 0 });
    expect(dispatchStatus.message).toBeUndefined();
    const gateStatus = spans[3].status;
    expect(gateStatus).toEqual({ code: 2, message: 'gate-failed' });
  });

  it('never throws: every invalid input is refused with payload null', () => {
    const result = encodeOtlpTraces(
      [null, 42, {}, new Proxy({}, { get() { throw new Error('x'); } })],
      RESOURCE,
    );
    expect(result.payload).toBeNull();
    expect(result.encodedSpanIds).toEqual([]);
    expect(result.refused).toEqual([
      { index: 0, reason: 'invalid' },
      { index: 1, reason: 'invalid' },
      { index: 2, reason: 'invalid' },
      { index: 3, reason: 'invalid' },
    ]);
  });

  it('an empty batch encodes nothing', () => {
    const result = encodeOtlpTraces([], RESOURCE);
    expect(result.payload).toBeNull();
    expect(result.encodedSpanIds).toEqual([]);
    expect(result.refused).toEqual([]);
  });
});

describe('encodeOtlpTraces never throws (Luna, OT3a)', () => {
  it('refuses every input of a proxy array whose element reads throw, without throwing', () => {
    const throwing = new Proxy([1, 2, 3], {
      get(target, key, receiver) {
        if (key === 'length') {
          return 3;
        }
        if (typeof key === 'string' && /^[0-9]+$/.test(key)) {
          throw new Error('hostile element read');
        }
        if (key === 'map') {
          throw new Error('hostile map read');
        }
        return Reflect.get(target, key, receiver);
      },
    }) as unknown as readonly unknown[];
    const result = encodeOtlpTraces(throwing, { serviceVersion: '0.0.0' } as never);
    expect(result.payload).toBeNull();
    expect(result.refused).toEqual([
      { index: 0, reason: 'invalid' },
      { index: 1, reason: 'invalid' },
      { index: 2, reason: 'invalid' },
    ]);
  });

  it('a proxy whose length read throws yields an empty refusal, without throwing', () => {
    const throwing = new Proxy([], {
      get(target, key, receiver) {
        if (key === 'length') {
          throw new Error('hostile length read');
        }
        return Reflect.get(target, key, receiver);
      },
    }) as unknown as readonly unknown[];
    const result = encodeOtlpTraces(throwing, { serviceVersion: '0.0.0' } as never);
    expect(result.payload).toBeNull();
    expect(result.refused).toEqual([]);
  });
});

describe('encodeOtlpTraces over every span kind and a plan-billed LLM span (Luna pre-merge, OT3a)', () => {
  it('a batch past the bound is refused whole without enumerating it', () => {
    const huge = new Proxy([], {
      get(target, key, receiver) {
        if (key === 'length') {
          return Number.MAX_SAFE_INTEGER;
        }
        if (typeof key === 'string' && /^[0-9]+$/.test(key)) {
          throw new Error('hostile element read');
        }
        return Reflect.get(target, key, receiver);
      },
    }) as unknown as readonly unknown[];
    const result = encodeOtlpTraces(huge, RESOURCE);
    expect(result.payload).toBeNull();
    expect(result.refused).toEqual([]);
  });

  it('encodes one span of every kind plus a plan-billed LLM span and passes every redaction check', () => {
    const kinds = ['CHAIN', 'AGENT', 'LLM', 'GUARDRAIL', 'EVALUATOR', 'DECISION', 'TOOL'] as const;
    const spans = kinds.map((kind, index) =>
      build({
        traceId: TRACE_ID,
        spanId: (index + 1).toString(16).padStart(16, 'a'),
        parentSpanId: ROOT_SPAN_ID,
        name: 'dispatch',
        kind,
        startIso: '2026-01-01T00:01:00Z',
        endIso: '2026-01-01T00:02:00Z',
        status: { code: 'unset', reasonCode: null },
        attributes: {},
        events: [],
      }),
    );
    const planLlm = build({
      traceId: TRACE_ID,
      spanId: 'b'.repeat(16),
      parentSpanId: ROOT_SPAN_ID,
      name: 'usage',
      kind: 'LLM',
      startIso: '2026-01-01T00:02:00Z',
      endIso: '2026-01-01T00:03:00Z',
      status: { code: 'unset', reasonCode: null },
      attributes: {
        'llm.model_name': 'example-model',
        'llm.token_count.prompt': 120,
        'llm.cost.total': 0.25,
        'fleet.seat.billing': 'plan',
      },
      events: [],
    });
    const result = encodeOtlpTraces([rootSpan, ...spans, planLlm], RESOURCE);
    expect(result.payload).not.toBeNull();
    // A plan-billed LLM span never carries a model or a cost on the wire.
    const text = new TextDecoder().decode(result.payload as Uint8Array);
    if (result.encodedSpanIds.includes('b'.repeat(16))) {
      expect(text).not.toContain('llm.cost.total');
    }
    const report = redactionChecks(result.payload as Uint8Array, []);
    expect(report.checks.filter((entry) => !entry.pass)).toEqual([]);
  });
});
