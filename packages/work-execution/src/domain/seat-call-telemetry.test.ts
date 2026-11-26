/**
 * Tests for the seat-call telemetry span (plan §3.2 "Seat calls"): the
 * metadata-only root AGENT span of one plan-billed seat call. Names are
 * `example` names only; the salt is a fixture, never a credential.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { seatCallSpan } from './run-telemetry-spans.js';
import { TelemetrySpan } from './run-telemetry.js';
import { TELEMETRY_DIGEST_PATTERN, telemetryDigest, telemetryHashInput } from './run-telemetry-ids.js';
import { TELEMETRY_PLAN_SEAT_TOOLS, TELEMETRY_SEAT_CALL_OUTCOMES, TELEMETRY_SEAT_TOOLS } from './run-telemetry-attributes.js';
import type { TelemetryHmac } from './run-telemetry-ids.js';

const SALT = 'example-telemetry-salt-0123456789abcdef0123456789abcdef';
const hmac: TelemetryHmac = (message) => createHmac('sha256', SALT).update(message, 'utf8').digest();
const NOW = '2026-03-01T12:00:00.000Z';

function facts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    callId: 'call-example-1',
    tool: 'agy',
    outcome: 'ok',
    wallSeconds: 12.5,
    nowIso: NOW,
    label: null,
    ...overrides,
  };
}

describe('TELEMETRY_PLAN_SEAT_TOOLS', () => {
  it('is exactly the closed plan-seat set', () => {
    expect([...TELEMETRY_PLAN_SEAT_TOOLS]).toEqual(['agy', 'grok', 'claude']);
  });

  it('every plan seat tool is a known seat tool', () => {
    for (const tool of TELEMETRY_PLAN_SEAT_TOOLS) {
      expect((TELEMETRY_SEAT_TOOLS as readonly string[]).includes(tool)).toBe(true);
    }
  });
});

describe('TELEMETRY_SEAT_CALL_OUTCOMES', () => {
  it('is exactly the four seat-call outcomes', () => {
    expect([...TELEMETRY_SEAT_CALL_OUTCOMES]).toEqual(['ok', 'empty', 'error', 'timeout']);
  });
});

describe('seatCallSpan', () => {
  it('builds a root AGENT seat-call span with the plan billing class and no forbidden attribute', () => {
    const span = seatCallSpan(hmac, facts());
    expect(span).not.toBeNull();
    expect(span!.name).toBe('seat-call');
    expect(span!.kind).toBe('AGENT');
    expect(span!.parentSpanId).toBeNull();
    expect(span!.events).toEqual([]);
    expect(span!.status.code).toBe('ok');
    expect(span!.status.reasonCode).toBeNull();
    expect(span!.attributes['fleet.seat.billing']).toBe('plan');
    expect(span!.attributes['fleet.seat.tool']).toBe('agy');
    expect(span!.attributes['fleet.outcome']).toBe('ok');
    expect(span!.attributes['fleet.usage.wall_seconds']).toBe(12.5);
    // Never a forbidden attribute.
    expect('fleet.seat.label_digest' in span!.attributes).toBe(false);
    expect('llm.model_name' in span!.attributes).toBe(false);
    expect('llm.provider' in span!.attributes).toBe(false);
    expect('session.id' in span!.attributes).toBe(false);
    // The span passes the pricing gate by construction.
    expect(TelemetrySpan.isTelemetrySpan(span)).toBe(true);
  });

  it('start and end derive from nowIso and wallSeconds', () => {
    const span = seatCallSpan(hmac, facts());
    expect(span!.endIso).toBe(new Date(NOW).toISOString());
    expect(span!.startIso).toBe(new Date(Date.parse(NOW) - Math.round(12.5 * 1000)).toISOString());
  });

  it('each tool and outcome builds a span, and error/timeout carry an error status', () => {
    for (const tool of TELEMETRY_PLAN_SEAT_TOOLS) {
      for (const outcome of TELEMETRY_SEAT_CALL_OUTCOMES) {
        const span = seatCallSpan(hmac, facts({ tool, outcome }));
        expect(span).not.toBeNull();
        expect(span!.attributes['fleet.seat.tool']).toBe(tool);
        expect(span!.attributes['fleet.outcome']).toBe(outcome);
        expect(span!.status.code).toBe(outcome === 'error' || outcome === 'timeout' ? 'error' : 'ok');
      }
    }
  });

  it('a wallSeconds of 0 gives a zero-length span, and a negative clamp keeps a valid start', () => {
    const span = seatCallSpan(hmac, facts({ wallSeconds: 0 }));
    expect(span!.startIso).toBe(span!.endIso);
    const huge = seatCallSpan(hmac, facts({ wallSeconds: Number.MAX_SAFE_INTEGER / 1000 }));
    expect(huge).not.toBeNull();
    expect(Date.parse(huge!.startIso)).toBe(0);
  });

  it('an optional label is hashed with the seat-label digest kind and never sent raw', () => {
    const label = 'lane-example-seat-a';
    const span = seatCallSpan(hmac, facts({ label }));
    expect(span).not.toBeNull();
    const digest = span!.attributes['fleet.seat.label_digest'];
    expect(typeof digest).toBe('string');
    expect(TELEMETRY_DIGEST_PATTERN.test(digest as string)).toBe(true);
    expect(digest).toBe(
      telemetryDigest(hmac, 'seat-label', telemetryHashInput(label)!),
    );
    expect(JSON.stringify(span!.attributes)).not.toContain(label);
  });

  it('a null label omits the digest attribute', () => {
    const span = seatCallSpan(hmac, facts({ label: null }));
    expect('fleet.seat.label_digest' in span!.attributes).toBe(false);
  });

  it('the same facts always build the same span', () => {
    const first = seatCallSpan(hmac, facts());
    const second = seatCallSpan(hmac, facts());
    expect(first!.traceId).toBe(second!.traceId);
    expect(first!.spanId).toBe(second!.spanId);
    expect(first!.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(first!.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an array', [facts()]],
    ['a class instance', new (class { constructor() { Object.assign(this, facts()); } })()],
    ['a throwing getter', Object.defineProperty({}, 'tool', { enumerable: true, get() { throw new Error('boom'); } })],
    ['a missing field', { callId: 'call-example-1', tool: 'agy', outcome: 'ok', wallSeconds: 1, nowIso: NOW }],
    ['an unknown tool', facts({ tool: 'opencode' })],
    ['a metered-route tool', facts({ tool: 'opencode' })],
    ['an unknown outcome', facts({ outcome: 'completed' })],
    ['a NaN wallSeconds', facts({ wallSeconds: Number.NaN })],
    ['an Infinity wallSeconds', facts({ wallSeconds: Number.POSITIVE_INFINITY })],
    ['a negative wallSeconds', facts({ wallSeconds: -1 })],
    ['a non-number wallSeconds', facts({ wallSeconds: '12' })],
    ['a non-ISO nowIso', facts({ nowIso: '2026-03-01 12:00:00' })],
    ['a naive nowIso', facts({ nowIso: '2026-03-01T12:00:00' })],
    ['an impossible nowIso', facts({ nowIso: '2026-02-31T12:00:00.000Z' })],
    ['an empty callId', facts({ callId: '' })],
    ['a non-string callId', facts({ callId: 42 })],
  ])('refuses %s without throwing', (_name, value) => {
    expect(seatCallSpan(hmac, value)).toBeNull();
  });

  it('refuses an invalid label without throwing', () => {
    expect(seatCallSpan(hmac, facts({ label: '' }))).toBeNull();
    expect(seatCallSpan(hmac, facts({ label: 'x'.repeat(1025) }))).toBeNull();
    expect(seatCallSpan(hmac, facts({ label: 42 }))).toBeNull();
    expect(seatCallSpan(hmac, facts({ label: 'lane-\uD800' }))).toBeNull();
  });

  it('refuses a throwing or short hmac without throwing', () => {
    const throwing: TelemetryHmac = () => {
      throw new Error('boom');
    };
    expect(seatCallSpan(throwing, facts({ label: 'lane-example' }))).toBeNull();
    const short: TelemetryHmac = () => new Uint8Array(16);
    expect(seatCallSpan(short, facts())).toBeNull();
  });
});
