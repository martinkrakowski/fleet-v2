/**
 * Tests for the `seat-call` span mapper (`seatCallSpan`): one plan-billed seat
 * call becomes one metadata-only AGENT span. Names are `example` names only;
 * the salt is a fixture, never a real secret. Every hostile-input test builds
 * the hostile value for real and asserts null, so a constant or identity
 * implementation fails the happy-path tests and a pass-through fails these.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TelemetrySpan } from './run-telemetry.js';
import type { TelemetryHmac } from './run-telemetry-ids.js';
import { seatCallSpan } from './run-telemetry-spans.js';

const SALT = 'example-telemetry-salt-0123456789abcdef0123456789abcdef';
const hmac: TelemetryHmac = (message) => createHmac('sha256', SALT).update(message, 'utf8').digest();
function expectedHex(message: string, bytes: number): string {
  return createHmac('sha256', SALT).update(message, 'utf8').digest('hex').slice(0, bytes * 2);
}

const CALL_ID = 'call-0001';
const NOW_ISO = '2026-01-02T03:04:05.000Z';

function facts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    callId: CALL_ID,
    tool: 'agy',
    outcome: 'ok',
    wallSeconds: 12.5,
    label: null,
    nowIso: NOW_ISO,
    ...overrides,
  };
}

function built(overrides: Record<string, unknown> = {}): TelemetrySpan {
  const span = seatCallSpan(hmac, facts(overrides));
  expect(span).not.toBeNull();
  return span as TelemetrySpan;
}

describe('seatCallSpan happy paths', () => {
  it.each(['agy', 'grok', 'claude'])('maps a %s call to exactly the plan-billed attribute set', (tool) => {
    const span = built({ tool });
    expect(TelemetrySpan.isTelemetrySpan(span)).toBe(true);
    expect(span.name).toBe('seat-call');
    expect(span.kind).toBe('AGENT');
    expect(span.parentSpanId).toBeNull();
    expect(span.events).toEqual([]);
    expect({ ...span.attributes }).toEqual({
      'openinference.span.kind': 'AGENT',
      'fleet.telemetry.schema': 1,
      'fleet.seat.billing': 'plan',
      'fleet.seat.tool': tool,
      'fleet.outcome': 'ok',
      'fleet.usage.wall_seconds': 12.5,
    });
  });

  it('derives the trace and span ids from the seat-call root and identity', () => {
    const span = built();
    expect(span.traceId).toBe(expectedHex('fleet-telemetry/v1/trace/seat-call/call-0001', 16));
    expect(span.spanId).toBe(expectedHex('fleet-telemetry/v1/span/seat-call/call-0001/seat-call', 8));
    expect(built({ callId: 'call-0002' }).traceId).not.toBe(span.traceId);
  });

  it('ends at nowIso and starts wallSeconds earlier', () => {
    const span = built({ wallSeconds: 12.5 });
    expect(span.endIso).toBe('2026-01-02T03:04:05.000Z');
    expect(span.startIso).toBe('2026-01-02T03:03:52.500Z');
    const instant = built({ wallSeconds: 0 });
    expect(instant.startIso).toBe(instant.endIso);
  });

  it('clamps the start to the epoch when wallSeconds reaches back past it', () => {
    expect(built({ wallSeconds: 1e12 }).startIso).toBe('1970-01-01T00:00:00.000Z');
  });

  it.each([
    ['ok', 'ok'],
    ['empty', 'ok'],
    ['error', 'error'],
    ['timeout', 'error'],
  ])('maps outcome %s to status %s with no reason code', (outcome, code) => {
    const span = built({ outcome });
    expect(span.status).toEqual({ code, reasonCode: null });
    expect(span.attributes['fleet.outcome']).toBe(outcome);
  });

  it('hashes the label with the seat-label kind and never carries it raw', () => {
    const label = 'example-seat-label-7';
    const span = built({ label });
    expect(span.attributes['fleet.seat.label_digest']).toBe(expectedHex('seat-label:' + label, 8));
    expect(JSON.stringify(span)).not.toContain(label);
    expect(Object.values(span.attributes)).not.toContain(label);
    expect('fleet.seat.label_digest' in built({ label: null }).attributes).toBe(false);
  });

  it('accepts a label of exactly 1024 code units', () => {
    expect(seatCallSpan(hmac, facts({ label: 'x'.repeat(1024) }))).not.toBeNull();
  });

  it('never carries tokens, cost, model, provider, session or any llm attribute', () => {
    const span = built({ label: 'example-seat-label-7' });
    const keys = Object.keys(span.attributes);
    for (const forbidden of [
      'session.id',
      'fleet.seat.model',
      'fleet.seat.provider',
      'fleet.cost.estimate_usd',
      'fleet.cost.basis',
      'fleet.usage.source',
      'fleet.run.id',
      'fleet.project',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
    expect(keys.filter((key) => key.startsWith('llm.'))).toEqual([]);
    expect(span.attributes['fleet.seat.billing']).toBe('plan');
  });
});

describe('seatCallSpan hostile input', () => {
  it('returns null when facts is null or undefined', () => {
    expect(seatCallSpan(hmac, null)).toBeNull();
    expect(seatCallSpan(hmac, undefined)).toBeNull();
  });

  it('returns null when facts is a primitive or non-plain object', () => {
    class Facts {
      callId = CALL_ID;
      tool = 'agy';
      outcome = 'ok';
      wallSeconds = 1;
      label = null;
      nowIso = NOW_ISO;
    }
    for (const value of ['agy', 42, true, 10n, Symbol('x'), () => facts(), new Facts(), new Map(), new Date()]) {
      expect(seatCallSpan(hmac, value)).toBeNull();
    }
  });

  it('returns null when facts is an array or array-like object', () => {
    expect(seatCallSpan(hmac, [])).toBeNull();
    expect(seatCallSpan(hmac, Object.values(facts()))).toBeNull();
    expect(seatCallSpan(hmac, { 0: 'agy', length: 1 })).toBeNull();
  });

  it('returns null when facts is a revoked Proxy', () => {
    const { proxy, revoke } = Proxy.revocable(facts(), {});
    revoke();
    expect(seatCallSpan(hmac, proxy)).toBeNull();
    const throwingTrap = new Proxy(facts(), {
      ownKeys() {
        throw new Error('trap');
      },
    });
    expect(seatCallSpan(hmac, throwingTrap)).toBeNull();
  });

  it('returns null when facts has an own getter', () => {
    let reads = 0;
    const hostile = Object.defineProperty(facts(), 'tool', {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return 'agy';
      },
    });
    expect(seatCallSpan(hmac, hostile)).toBeNull();
    expect(reads).toBe(0);
    const nonEnumerable = Object.defineProperty(facts(), 'tool', { value: 'agy', enumerable: false });
    expect(seatCallSpan(hmac, nonEnumerable)).toBeNull();
  });

  it('returns null when facts has a Symbol.iterator or symbol key', () => {
    expect(seatCallSpan(hmac, { ...facts(), [Symbol.iterator]: function* () { yield 1; } })).toBeNull();
    expect(seatCallSpan(hmac, { ...facts(), [Symbol('extra')]: 1 })).toBeNull();
  });

  it('returns null when facts has own __proto__, constructor, or prototype key', () => {
    const withProto = Object.defineProperty(facts(), '__proto__', {
      value: { tool: 'agy' },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(seatCallSpan(hmac, withProto)).toBeNull();
    expect(seatCallSpan(hmac, { ...facts(), constructor: 'x' })).toBeNull();
    expect(seatCallSpan(hmac, { ...facts(), prototype: 'x' })).toBeNull();
  });

  it('returns null when facts has missing or extra keys', () => {
    for (const key of Object.keys(facts())) {
      const missing = Object.fromEntries(Object.entries(facts()).filter(([name]) => name !== key));
      expect(seatCallSpan(hmac, missing), `missing ${key}`).toBeNull();
    }
    expect(seatCallSpan(hmac, { ...facts(), extra: 1 })).toBeNull();
    expect(seatCallSpan(hmac, {})).toBeNull();
  });

  it('returns null when tool, outcome, wallSeconds, nowIso, callId, or label is invalid', () => {
    const invalid: Record<string, unknown[]> = {
      tool: ['opencode', 'review-cli', 'openrouter', 'AGY', '', null, 7],
      outcome: ['accepted', 'rejected', 'OK', '', null, 7],
      wallSeconds: [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '1', null, 1n],
      nowIso: ['garbage', '2026-01-02', '2026-01-02T03:04:05', '2026-13-01T00:00:00Z', '2026-01-02T25:00:00Z', '', null, 0],
      callId: ['', 7, null, 'a'.repeat(1025), '\ud800'],
      label: ['', 7, 'x'.repeat(1025), '\ud800', {}, ['a']],
    };
    for (const [key, values] of Object.entries(invalid)) {
      for (const value of values) {
        expect(seatCallSpan(hmac, facts({ [key]: value })), `${key}=${String(value)}`).toBeNull();
      }
    }
  });

  it('returns null when hmac throws or returns fewer than 32 bytes', () => {
    const throwing: TelemetryHmac = () => {
      throw new Error('hmac');
    };
    const short: TelemetryHmac = () => new Uint8Array(16);
    const notBytes = (() => 'abc') as unknown as TelemetryHmac;
    for (const broken of [throwing, short, notBytes]) {
      expect(seatCallSpan(broken, facts())).toBeNull();
      expect(seatCallSpan(broken, facts({ label: 'example-seat-label-7' }))).toBeNull();
    }
    expect(seatCallSpan(hmac, facts())).not.toBeNull();
  });

  it('returns null when hmac fails only for the label digest', () => {
    const failsOnLabel: TelemetryHmac = (message) => {
      if (message.startsWith('seat-label:')) {
        throw new Error('label');
      }
      return hmac(message);
    };
    expect(seatCallSpan(failsOnLabel, facts({ label: 'example-seat-label-7' }))).toBeNull();
    expect(seatCallSpan(failsOnLabel, facts({ label: null }))).not.toBeNull();
  });
});
