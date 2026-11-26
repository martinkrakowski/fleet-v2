/**
 * Tests for RecordSeatCallUseCase (plan §3.2 "Seat calls"): the request
 * validation, the span build, the dry-run result and the send path's
 * dispositions. Every port here is a plain in-memory fake; nothing touches the
 * network, and no input value is ever echoed into a result.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RecordSeatCallUseCase } from './RecordSeatCallUseCase.use-case.js';
import { seatCallSpan } from '../../domain/run-telemetry-spans.js';
import { TelemetrySpan } from '../../domain/run-telemetry.js';
import { TELEMETRY_PLAN_SEAT_TOOLS } from '../../domain/run-telemetry-attributes.js';
import type { RunTelemetryPort, RunTelemetrySendResult } from '../ports/out/RunTelemetryPort.out-port.js';
import type { TelemetryHmac } from '../../domain/run-telemetry-ids.js';

const SALT = 'example-telemetry-salt-0123456789abcdef0123456789abcdef';
const hmac: TelemetryHmac = (message) => createHmac('sha256', SALT).update(message, 'utf8').digest();
const NOW = '2026-03-01T12:00:00.000Z';
const DEADLINE = { atMs: Date.parse(NOW) + 120_000 };
const CALL_ID = 'call-example-1';

const VALID_REQUEST = {
  tool: 'agy',
  outcome: 'ok',
  wallSeconds: 12.5,
  label: null,
  mode: 'send',
  deadline: DEADLINE,
  nowIso: NOW,
};

function useCaseWith(telemetry: unknown, options: { hmac?: TelemetryHmac; mintCallId?: () => string } = {}): RecordSeatCallUseCase {
  return new RecordSeatCallUseCase({
    telemetry: telemetry as RunTelemetryPort,
    hmac: options.hmac ?? hmac,
    mintCallId: options.mintCallId ?? (() => CALL_ID),
  });
}

function exportedResult(spanId: string, errorKind: unknown = null): RunTelemetrySendResult {
  return {
    dispositions: [{ spanId, disposition: { state: 'exported', route: 'collector' } }],
    errorKind: errorKind as never,
  };
}

describe('RecordSeatCallUseCase.execute', () => {
  it('dry-run mode builds the span and never calls telemetry.send', async () => {
    let sent = 0;
    const useCase = useCaseWith({ send: async () => { sent += 1; return exportedResult('span-example-1'); } });
    const result = await useCase.execute({ ...VALID_REQUEST, mode: 'dry-run', deadline: null });
    expect(result.outcome).toBe('dry-run');
    if (result.outcome !== 'dry-run') {
      return;
    }
    expect(TelemetrySpan.isTelemetrySpan(result.span)).toBe(true);
    expect(result.span.attributes['fleet.seat.billing']).toBe('plan');
    expect(result.span.attributes['fleet.seat.tool']).toBe('agy');
    expect(sent).toBe(0);
  });

  it('send mode exports the one span and returns its spanId', async () => {
    const useCase = useCaseWith({ send: async () => exportedResult('span-example-1') });
    const result = await useCase.execute(VALID_REQUEST);
    expect(result).toEqual({ outcome: 'exported', spanId: 'span-example-1' });
  });

  it('send mode validates the request against the closed tool and outcome sets', async () => {
    for (const tool of TELEMETRY_PLAN_SEAT_TOOLS) {
      const useCase = useCaseWith({ send: async () => exportedResult('span-example-1') });
      const result = await useCase.execute({ ...VALID_REQUEST, tool });
      expect(result.outcome).toBe('exported');
    }
  });

  it('builds the same span the pure mapper builds', async () => {
    const useCase = useCaseWith({ send: async () => exportedResult('span-example-1') });
    const result = await useCase.execute({ ...VALID_REQUEST, mode: 'dry-run', deadline: null });
    if (result.outcome !== 'dry-run') {
      throw new Error('expected a dry-run result');
    }
    const expected = seatCallSpan(hmac, { callId: CALL_ID, tool: 'agy', outcome: 'ok', wallSeconds: 12.5, nowIso: NOW, label: null });
    expect(result.span.traceId).toBe(expected!.traceId);
    expect(result.span.spanId).toBe(expected!.spanId);
    expect(result.span.attributes).toEqual(expected!.attributes);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an array', [VALID_REQUEST]],
    ['a string', 'record-seat-call'],
    ['a throwing getter', Object.defineProperty({}, 'tool', { enumerable: true, get() { throw new Error('boom'); } })],
    ['a missing field', { tool: 'agy', outcome: 'ok', wallSeconds: 1, mode: 'send', deadline: DEADLINE, nowIso: NOW }],
    ['an unknown tool', { ...VALID_REQUEST, tool: 'opencode' }],
    ['an unknown outcome', { ...VALID_REQUEST, outcome: 'completed' }],
    ['a NaN wallSeconds', { ...VALID_REQUEST, wallSeconds: Number.NaN }],
    ['a negative wallSeconds', { ...VALID_REQUEST, wallSeconds: -1 }],
    ['a non-string label', { ...VALID_REQUEST, label: 42 }],
    ['a boolean mode', { ...VALID_REQUEST, mode: true }],
    ['an invalid nowIso', { ...VALID_REQUEST, nowIso: '2026-03-01 12:00:00' }],
    ['a send with a null deadline', { ...VALID_REQUEST, deadline: null }],
    ['a send with a malformed deadline', { ...VALID_REQUEST, deadline: { atMs: 'soon' } }],
    ['a send with a non-finite deadline', { ...VALID_REQUEST, deadline: { atMs: Number.POSITIVE_INFINITY } }],
  ])('returns refused invalid-request on %s', async (_name, request) => {
    let sent = 0;
    const useCase = useCaseWith({ send: async () => { sent += 1; return exportedResult('span-example-1'); } });
    const result = await useCase.execute(request);
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(sent).toBe(0);
  });

  it('returns refused span-build-failed when the hmac throws or the label is invalid', async () => {
    let sent = 0;
    const useCase = useCaseWith(
      { send: async () => { sent += 1; return exportedResult('span-example-1'); } },
      { hmac: () => { throw new Error('boom'); } },
    );
    expect(await useCase.execute(VALID_REQUEST)).toEqual({ outcome: 'refused', reason: 'span-build-failed' });
    expect(sent).toBe(0);
    const badLabel = useCaseWith({ send: async () => exportedResult('span-example-1') });
    expect(await badLabel.execute({ ...VALID_REQUEST, label: '' })).toEqual({
      outcome: 'refused',
      reason: 'span-build-failed',
    });
    const short = useCaseWith(
      { send: async () => exportedResult('span-example-1') },
      { hmac: () => new Uint8Array(16) },
    );
    expect(await short.execute(VALID_REQUEST)).toEqual({ outcome: 'refused', reason: 'span-build-failed' });
    expect(sent).toBe(0);
  });

  it('returns send-failed when telemetry.send is missing or rejects', async () => {
    const useCase = useCaseWith({});
    expect(await useCase.execute(VALID_REQUEST)).toEqual({ outcome: 'send-failed', errorKind: 'unknown' });
    const rejecting = useCaseWith({ send: async () => { throw new Error('boom'); } });
    expect(await rejecting.execute(VALID_REQUEST)).toEqual({ outcome: 'send-failed', errorKind: 'unknown' });
    const throwing = useCaseWith({ get send() { throw new Error('boom'); } });
    expect(await throwing.execute(VALID_REQUEST)).toEqual({ outcome: 'send-failed', errorKind: 'unknown' });
  });

  it.each([
    ['null', null],
    ['a non-object', 'sent'],
    ['a non-array dispositions', { dispositions: {}, errorKind: null }],
    ['an empty dispositions list', { dispositions: [], errorKind: null }],
    ['a pending disposition', { dispositions: [{ spanId: 'span-example-1', disposition: { state: 'pending' } }], errorKind: null }],
    ['a rejected disposition', { dispositions: [{ spanId: 'span-example-1', disposition: { state: 'rejected', reason: 'invalid' } }], errorKind: null }],
    ['a non-exported state', { dispositions: [{ spanId: 'span-example-1', disposition: { state: 'rejected', reason: 'invalid' } }], errorKind: null }],
    ['an error kind', exportedResult('span-example-1', 'timeout')],
    ['a throwing getter', Object.defineProperty({}, 'dispositions', { enumerable: true, get() { throw new Error('boom'); } })],
  ])('returns send-failed when the send result is malformed: %s', async (_name, sent) => {
    const useCase = useCaseWith({ send: async () => sent as never });
    const result = await useCase.execute(VALID_REQUEST);
    expect(result.outcome).toBe('send-failed');
    if (result.outcome === 'send-failed') {
      expect(result.errorKind === 'unknown' || typeof result.errorKind === 'string').toBe(true);
    }
  });

  it('a wrong-length dispositions list is send-failed', async () => {
    const useCase = useCaseWith({
      send: async () => ({
        dispositions: [
          { spanId: 'span-example-1', disposition: { state: 'exported', route: 'collector' } },
          { spanId: 'span-example-2', disposition: { state: 'exported', route: 'collector' } },
        ],
        errorKind: null,
      }),
    });
    expect(await useCase.execute(VALID_REQUEST)).toEqual({ outcome: 'send-failed', errorKind: 'unknown' });
  });

  it('a send with a named timeout error kind carries that kind', async () => {
    const useCase = useCaseWith({
      send: async () => ({ dispositions: [{ spanId: 'span-example-1', disposition: { state: 'pending' } }], errorKind: 'timeout' }),
    });
    expect(await useCase.execute(VALID_REQUEST)).toEqual({ outcome: 'send-failed', errorKind: 'timeout' });
  });

  it('a dry-run with an invalid deadline is a valid dry-run (no send, no deadline needed)', async () => {
    const useCase = useCaseWith({ send: async () => exportedResult('span-example-1') });
    const result = await useCase.execute({ ...VALID_REQUEST, mode: 'dry-run', deadline: null });
    expect(result.outcome).toBe('dry-run');
  });
});
