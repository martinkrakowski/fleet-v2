/**
 * Tests for RecordSeatCallUseCase: one plan-billed seat call becomes one
 * `seat-call` span sent through the run telemetry port. Each Refusals row has
 * one test whose body builds the hostile input for real and asserts the typed
 * result plus, for invalid requests, that neither `mintCallId` nor
 * `telemetry.send` ran. Names are `example` names only; the salt is a fixture.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RecordSeatCallResult } from '../ports/in/RecordSeatCallPort.in-port.js';
import type { RunTelemetryPort } from '../ports/out/RunTelemetryPort.out-port.js';
import type { TelemetrySpan } from '../../domain/run-telemetry.js';
import type { TelemetryHmac } from '../../domain/run-telemetry-ids.js';
import { RecordSeatCallUseCase, type RecordSeatCallDependencies } from './RecordSeatCallUseCase.use-case.js';

const SALT = 'example-telemetry-salt-0123456789abcdef0123456789abcdef';
const hmac: TelemetryHmac = (message) => createHmac('sha256', SALT).update(message, 'utf8').digest();
const NOW_ISO = '2026-01-02T03:04:05.000Z';

const REFUSED_INVALID: RecordSeatCallResult = { outcome: 'refused', reason: 'invalid-request' };
const REFUSED_NOT_CONFIGURED: RecordSeatCallResult = { outcome: 'refused', reason: 'not-configured' };
const REFUSED_SPAN: RecordSeatCallResult = { outcome: 'refused', reason: 'span-build-failed' };
const SEND_FAILED_UNKNOWN: RecordSeatCallResult = { outcome: 'send-failed', errorKind: 'unknown' };

function validRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { tool: 'agy', outcome: 'ok', wallSeconds: 3, label: null, mode: 'send', deadline: null, nowIso: NOW_ISO, ...overrides };
}

function exportedDisposition(): Record<string, unknown> {
  return { state: 'exported', route: 'collector' };
}

function entryFor(spanId: string, disposition: unknown = exportedDisposition()): Record<string, unknown> {
  return { spanId, disposition };
}

function sentFor(spanId: string): Record<string, unknown> {
  return { dispositions: [entryFor(spanId)], errorKind: null };
}

interface Harness {
  readonly useCase: RecordSeatCallUseCase;
  readonly sends: { spans: readonly TelemetrySpan[]; deadline: unknown }[];
  readonly mints: { count: number };
}

/** A use case over a recording telemetry stub whose answer is `respond(spans)`. */
function harness(respond: (spans: readonly TelemetrySpan[]) => unknown = (spans) => sentFor(spans[0].spanId)): Harness {
  const sends: { spans: readonly TelemetrySpan[]; deadline: unknown }[] = [];
  const mints = { count: 0 };
  const telemetry = {
    send(spans: readonly TelemetrySpan[], deadline: unknown): Promise<unknown> {
      sends.push({ spans, deadline });
      return Promise.resolve(respond(spans));
    },
  };
  const deps: RecordSeatCallDependencies = {
    telemetry: telemetry as unknown as RunTelemetryPort,
    hmac,
    mintCallId: () => {
      mints.count += 1;
      return 'call-' + String(mints.count).padStart(4, '0');
    },
  };
  return { useCase: new RecordSeatCallUseCase(deps), sends, mints };
}

/** Run one send-mode call whose telemetry answers `sent(spanId)`. */
async function runSent(sent: (spanId: string) => unknown): Promise<{ result: RecordSeatCallResult; sends: number }> {
  const h = harness((spans) => sent(spans[0].spanId));
  const result = await h.useCase.execute(validRequest());
  return { result, sends: h.sends.length };
}

/** Every request in `requests` is refused as invalid with nothing minted and nothing sent. */
async function expectAllInvalid(requests: readonly unknown[]): Promise<void> {
  for (const request of requests) {
    const h = harness();
    expect(await h.useCase.execute(request)).toEqual(REFUSED_INVALID);
    expect(h.mints.count).toBe(0);
    expect(h.sends).toHaveLength(0);
  }
}

function revokedProxy(target: object): object {
  const { proxy, revoke } = Proxy.revocable(target, {});
  revoke();
  return proxy;
}

function throwingGetter(target: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.defineProperty(target, key, {
    enumerable: true,
    configurable: true,
    get() {
      throw new Error('getter must never run');
    },
  });
}

function deps(overrides: Record<string, unknown> = {}): RecordSeatCallDependencies {
  const base: Record<string, unknown> = {
    telemetry: { send: () => Promise.resolve(null) },
    hmac,
    mintCallId: () => 'call-0001',
    ...overrides,
  };
  return base as unknown as RecordSeatCallDependencies;
}

describe('RecordSeatCallUseCase happy paths', () => {
  it('dry-run returns the built span, mints once and sends nothing', async () => {
    const h = harness();
    const result = await h.useCase.execute(validRequest({ mode: 'dry-run', tool: 'grok', outcome: 'timeout', wallSeconds: 2.5 }));
    expect(result.outcome).toBe('dry-run');
    const span = (result as Extract<RecordSeatCallResult, { outcome: 'dry-run' }>).span;
    expect(span.name).toBe('seat-call');
    expect(span.attributes['fleet.seat.tool']).toBe('grok');
    expect(span.attributes['fleet.seat.billing']).toBe('plan');
    expect(span.attributes['fleet.outcome']).toBe('timeout');
    expect(span.status.code).toBe('error');
    expect(h.mints.count).toBe(1);
    expect(h.sends).toHaveLength(0);
  });

  it('send exports exactly one span and returns its span id with the deadline passed through', async () => {
    const h = harness();
    const result = await h.useCase.execute(validRequest({ tool: 'claude', deadline: { atMs: 1234 } }));
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0].spans).toHaveLength(1);
    expect(h.sends[0].deadline).toEqual({ atMs: 1234 });
    expect(result).toEqual({ outcome: 'exported', spanId: h.sends[0].spans[0].spanId });
    expect(h.sends[0].spans[0].attributes['fleet.seat.tool']).toBe('claude');
  });

  it('hashes the label and never sends it raw', async () => {
    const label = 'example-seat-label-7';
    const h = harness();
    await h.useCase.execute(validRequest({ label }));
    const span = h.sends[0].spans[0];
    expect(span.attributes['fleet.seat.label_digest']).toBe(
      createHmac('sha256', SALT).update('seat-label:' + label, 'utf8').digest('hex').slice(0, 16),
    );
    expect(JSON.stringify(h.sends[0].spans)).not.toContain(label);
  });

  it('carries the send error kind when the send reports one', async () => {
    expect(await runSent(() => ({ dispositions: [], errorKind: 'network' }))).toEqual({
      result: { outcome: 'send-failed', errorKind: 'network' },
      sends: 1,
    });
    const exportedWithError = await runSent((spanId) => ({ dispositions: [entryFor(spanId)], errorKind: 'partial' }));
    expect(exportedWithError.result).toEqual({ outcome: 'send-failed', errorKind: 'partial' });
  });
});

describe('RecordSeatCallUseCase refusals', () => {
  it('returns refused not-configured when constructed without dependencies', async () => {
    expect(await new RecordSeatCallUseCase().execute(validRequest())).toEqual(REFUSED_NOT_CONFIGURED);
    expect(await new RecordSeatCallUseCase().execute(null)).toEqual(REFUSED_NOT_CONFIGURED);
    expect(await new RecordSeatCallUseCase(undefined).execute(undefined)).toEqual(REFUSED_NOT_CONFIGURED);
    expect(await new RecordSeatCallUseCase(null as unknown as RecordSeatCallDependencies).execute(validRequest())).toEqual(
      REFUSED_NOT_CONFIGURED,
    );
  });

  it('returns refused not-configured when hmac is missing or a getter', async () => {
    const missing = Object.fromEntries(Object.entries(deps()).filter(([key]) => key !== 'hmac'));
    expect(await new RecordSeatCallUseCase(missing as unknown as RecordSeatCallDependencies).execute(validRequest())).toEqual(
      REFUSED_NOT_CONFIGURED,
    );
    const getter = throwingGetter({ telemetry: { send: () => Promise.resolve(null) }, mintCallId: () => 'call-0001' }, 'hmac');
    expect(await new RecordSeatCallUseCase(getter as unknown as RecordSeatCallDependencies).execute(validRequest())).toEqual(
      REFUSED_NOT_CONFIGURED,
    );
    expect(await new RecordSeatCallUseCase(deps({ hmac: 'not a function' })).execute(validRequest())).toEqual(REFUSED_NOT_CONFIGURED);
  });

  it('returns refused not-configured when mintCallId is missing or a getter', async () => {
    const missing = Object.fromEntries(Object.entries(deps()).filter(([key]) => key !== 'mintCallId'));
    expect(await new RecordSeatCallUseCase(missing as unknown as RecordSeatCallDependencies).execute(validRequest())).toEqual(
      REFUSED_NOT_CONFIGURED,
    );
    const getter = throwingGetter({ telemetry: { send: () => Promise.resolve(null) }, hmac }, 'mintCallId');
    expect(await new RecordSeatCallUseCase(getter as unknown as RecordSeatCallDependencies).execute(validRequest())).toEqual(
      REFUSED_NOT_CONFIGURED,
    );
    expect(await new RecordSeatCallUseCase(deps({ mintCallId: 42 })).execute(validRequest())).toEqual(REFUSED_NOT_CONFIGURED);
  });

  it('returns refused invalid-request when request is null', async () => {
    await expectAllInvalid([null]);
  });

  it('returns refused invalid-request when request is undefined', async () => {
    await expectAllInvalid([undefined]);
  });

  it('returns refused invalid-request when request is a primitive', async () => {
    await expectAllInvalid(['agy', 42, true, 10n, Symbol('request')]);
  });

  it('returns refused invalid-request when request is an array', async () => {
    await expectAllInvalid([[], Object.values(validRequest())]);
  });

  it('returns refused invalid-request when request is an array-like object', async () => {
    await expectAllInvalid([{ 0: 'agy', length: 1 }]);
  });

  it('returns refused invalid-request when request is a non-plain class instance', async () => {
    class RequestLike {
      tool = 'agy';
      outcome = 'ok';
      wallSeconds = 3;
      label = null;
      mode = 'send';
      deadline = null;
      nowIso = NOW_ISO;
    }
    await expectAllInvalid([new RequestLike(), new Map(), new Date()]);
  });

  it('returns refused invalid-request when request is a revoked Proxy', async () => {
    await expectAllInvalid([revokedProxy(validRequest())]);
  });

  it('returns refused invalid-request when request has a throwing own getter', async () => {
    await expectAllInvalid([throwingGetter(validRequest(), 'tool'), throwingGetter(validRequest(), 'deadline')]);
  });

  it('returns refused invalid-request when request has a non-enumerable own property', async () => {
    await expectAllInvalid([Object.defineProperty(validRequest(), 'tool', { value: 'agy', enumerable: false })]);
  });

  it('returns refused invalid-request when request has an own Symbol.iterator key', async () => {
    await expectAllInvalid([{ ...validRequest(), [Symbol.iterator]: () => [][Symbol.iterator]() }, { ...validRequest(), [Symbol('extra')]: 1 }]);
  });

  it('returns refused invalid-request when request has an own __proto__ property', async () => {
    await expectAllInvalid([
      Object.defineProperty(validRequest(), '__proto__', { value: { tool: 'agy' }, enumerable: true, configurable: true, writable: true }),
    ]);
  });

  it('returns refused invalid-request when request has an own constructor or prototype property', async () => {
    await expectAllInvalid([{ ...validRequest(), constructor: 'x' }, { ...validRequest(), prototype: 'x' }]);
  });

  it('returns refused invalid-request when request has missing or extra keys', async () => {
    const missing = Object.keys(validRequest()).map((key) =>
      Object.fromEntries(Object.entries(validRequest()).filter(([name]) => name !== key)),
    );
    await expectAllInvalid([...missing, { ...validRequest(), extra: 1 }, {}]);
  });

  it('returns refused invalid-request when tool is unknown or metered', async () => {
    await expectAllInvalid(
      ['opencode', 'review-cli', 'openrouter', 'AGY', '', null, 7].map((tool) => validRequest({ tool })),
    );
  });

  it('returns refused invalid-request when outcome is invalid', async () => {
    await expectAllInvalid(['accepted', 'rejected', 'OK', '', null, 7].map((outcome) => validRequest({ outcome })));
  });

  it('returns refused invalid-request when wallSeconds is negative, NaN, or Infinity', async () => {
    await expectAllInvalid(
      [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '3', null, 3n].map((wallSeconds) => validRequest({ wallSeconds })),
    );
  });

  it('returns refused invalid-request when label is empty, non-string, or oversized', async () => {
    await expectAllInvalid(
      ['', 7, 'x'.repeat(1025), '\ud800', undefined, {}, ['a']].map((label) => validRequest({ label })),
    );
  });

  it('returns refused invalid-request when mode is invalid', async () => {
    await expectAllInvalid(['SEND', 'live', '', null, 1, undefined].map((mode) => validRequest({ mode })));
  });

  it('returns refused invalid-request when nowIso is not a valid zoned ISO instant', async () => {
    await expectAllInvalid(
      ['garbage', '2026-01-02', '2026-01-02T03:04:05', '2026-13-01T00:00:00Z', '2026-01-02T25:00:00Z', '', null, 0].map((nowIso) =>
        validRequest({ nowIso }),
      ),
    );
  });

  it('returns refused invalid-request when deadline is malformed, proxied, or has extra keys', async () => {
    class Deadline {
      atMs = 1;
    }
    await expectAllInvalid(
      [
        undefined,
        'soon',
        1,
        [],
        {},
        { atMs: Number.NaN },
        { atMs: Number.POSITIVE_INFINITY },
        { atMs: '1' },
        { atMs: 1, extra: 1 },
        revokedProxy({ atMs: 1 }),
        throwingGetter({}, 'atMs'),
        new Deadline(),
      ].map((deadline) => validRequest({ deadline })),
    );
  });

  it('returns refused span-build-failed when mintCallId throws', async () => {
    const throwing = new RecordSeatCallUseCase(
      deps({
        mintCallId: () => {
          throw new Error('mint');
        },
      }),
    );
    expect(await throwing.execute(validRequest())).toEqual(REFUSED_SPAN);
  });

  it('returns refused span-build-failed when mintCallId returns an empty or non-string value', async () => {
    for (const value of ['', 7, null, undefined, {}, 'x'.repeat(1025), '\ud800']) {
      const sends: unknown[] = [];
      const useCase = new RecordSeatCallUseCase(
        deps({
          mintCallId: () => value,
          telemetry: {
            send: (spans: unknown) => {
              sends.push(spans);
              return Promise.resolve(null);
            },
          },
        }),
      );
      expect(await useCase.execute(validRequest())).toEqual(REFUSED_SPAN);
      expect(sends).toHaveLength(0);
    }
  });

  it('returns refused span-build-failed when hmac throws or returns fewer than 32 bytes', async () => {
    const broken: unknown[] = [
      () => {
        throw new Error('hmac');
      },
      () => new Uint8Array(16),
      () => 'not bytes',
    ];
    for (const brokenHmac of broken) {
      const sends: unknown[] = [];
      const useCase = new RecordSeatCallUseCase(
        deps({
          hmac: brokenHmac,
          telemetry: {
            send: (spans: unknown) => {
              sends.push(spans);
              return Promise.resolve(null);
            },
          },
        }),
      );
      expect(await useCase.execute(validRequest())).toEqual(REFUSED_SPAN);
      expect(await useCase.execute(validRequest({ mode: 'dry-run' }))).toEqual(REFUSED_SPAN);
      expect(sends).toHaveLength(0);
    }
  });

  it('returns send-failed unknown when telemetry is omitted or send is missing or a getter', async () => {
    const withoutTelemetry = Object.fromEntries(Object.entries(deps()).filter(([key]) => key !== 'telemetry'));
    const cases: RecordSeatCallDependencies[] = [
      withoutTelemetry as unknown as RecordSeatCallDependencies,
      deps({ telemetry: undefined }),
      deps({ telemetry: {} }),
      deps({ telemetry: { send: 'not a function' } }),
      deps({ telemetry: throwingGetter({}, 'send') }),
      deps({ telemetry: revokedProxy({ send: () => Promise.resolve(null) }) }),
      deps({ telemetry: null }),
    ];
    for (const caseDeps of cases) {
      expect(await new RecordSeatCallUseCase(caseDeps).execute(validRequest())).toEqual(SEND_FAILED_UNKNOWN);
    }
    const telemetryGetter = throwingGetter({ hmac, mintCallId: () => 'call-0001' }, 'telemetry');
    expect(await new RecordSeatCallUseCase(telemetryGetter as unknown as RecordSeatCallDependencies).execute(validRequest())).toEqual(
      SEND_FAILED_UNKNOWN,
    );
  });

  it('returns send-failed unknown when telemetry.send throws or rejects', async () => {
    const throwing = deps({
      telemetry: {
        send: () => {
          throw new Error('send');
        },
      },
    });
    const rejecting = deps({ telemetry: { send: () => Promise.reject(new Error('send')) } });
    expect(await new RecordSeatCallUseCase(throwing).execute(validRequest())).toEqual(SEND_FAILED_UNKNOWN);
    expect(await new RecordSeatCallUseCase(rejecting).execute(validRequest())).toEqual(SEND_FAILED_UNKNOWN);
  });

  it('returns send-failed when sent result is null, a revoked Proxy, or has a getter', async () => {
    for (const sent of [
      () => null,
      () => undefined,
      () => 'exported',
      (spanId: string) => revokedProxy(sentFor(spanId)),
      (spanId: string) => throwingGetter({ errorKind: null, dispositions: [entryFor(spanId)] }, 'dispositions'),
      (spanId: string) => throwingGetter({ dispositions: [entryFor(spanId)] }, 'errorKind'),
    ]) {
      const { result, sends } = await runSent(sent);
      expect(result).toEqual(SEND_FAILED_UNKNOWN);
      expect(sends).toBe(1);
    }
  });

  it('returns send-failed when sent result has extra keys or invalid errorKind', async () => {
    for (const sent of [
      (spanId: string) => ({ ...sentFor(spanId), extra: 1 }),
      (spanId: string) => ({ dispositions: [entryFor(spanId)] }),
      (spanId: string) => ({ errorKind: null, extra: spanId }),
      (spanId: string) => ({ dispositions: [entryFor(spanId)], errorKind: 'bogus' }),
      (spanId: string) => ({ dispositions: [entryFor(spanId)], errorKind: 7 }),
      (spanId: string) => ({ dispositions: [entryFor(spanId)], errorKind: undefined }),
    ]) {
      expect((await runSent(sent)).result).toEqual(SEND_FAILED_UNKNOWN);
    }
  });

  it('returns send-failed when dispositions is non-array, empty, or wrong length', async () => {
    for (const dispositions of [
      () => ({}),
      () => 'x',
      () => null,
      () => [],
      (spanId: string) => [entryFor(spanId), entryFor(spanId)],
      (spanId: string) => ({ 0: entryFor(spanId), length: 1 }),
    ]) {
      const { result } = await runSent((spanId) => ({ dispositions: dispositions(spanId), errorKind: null }));
      expect(result).toEqual(SEND_FAILED_UNKNOWN);
    }
    const withKind = await runSent(() => ({ dispositions: [], errorKind: 'timeout' }));
    expect(withKind.result).toEqual({ outcome: 'send-failed', errorKind: 'timeout' });
  });

  it('returns send-failed when dispositions contains an array hole or getter', async () => {
    let reads = 0;
    const { result: hole } = await runSent(() => ({ dispositions: new Array<unknown>(1), errorKind: null }));
    expect(hole).toEqual(SEND_FAILED_UNKNOWN);
    const { result: getter } = await runSent((spanId) => {
      const dispositions: unknown[] = [];
      Object.defineProperty(dispositions, '0', {
        enumerable: true,
        configurable: true,
        get() {
          reads += 1;
          return entryFor(spanId);
        },
      });
      return { dispositions, errorKind: null };
    });
    expect(getter).toEqual(SEND_FAILED_UNKNOWN);
    expect(reads).toBe(0);
  });

  it('returns send-failed when dispositions is a revoked Proxy or has extra own keys', async () => {
    const { result: proxied } = await runSent((spanId) => ({ dispositions: revokedProxy([entryFor(spanId)]), errorKind: null }));
    expect(proxied).toEqual(SEND_FAILED_UNKNOWN);
    const { result: extra } = await runSent((spanId) => {
      const dispositions = [entryFor(spanId)] as unknown[] & { extra?: number };
      dispositions.extra = 1;
      return { dispositions, errorKind: null };
    });
    expect(extra).toEqual(SEND_FAILED_UNKNOWN);
    const { result: symbolKey } = await runSent((spanId) => {
      const dispositions = [entryFor(spanId)] as unknown[] & Record<symbol, unknown>;
      dispositions[Symbol('extra')] = 1;
      return { dispositions, errorKind: null };
    });
    expect(symbolKey).toEqual(SEND_FAILED_UNKNOWN);
    const { result: classArray } = await runSent((spanId) => {
      class Dispositions extends Array<unknown> {}
      const dispositions = new Dispositions();
      dispositions.push(entryFor(spanId));
      return { dispositions, errorKind: null };
    });
    expect(classArray).toEqual(SEND_FAILED_UNKNOWN);
  });

  it('returns send-failed when disposition entry has mismatched spanId, extra keys, or non-exported state', async () => {
    for (const entry of [
      () => entryFor('ffffffffffffffff'),
      () => entryFor(''),
      (spanId: string) => ({ ...entryFor(spanId), extra: 1 }),
      (spanId: string) => ({ spanId }),
      (spanId: string) => entryFor(spanId, { state: 'pending' }),
      (spanId: string) => entryFor(spanId, { state: 'rejected', reason: 'invalid' }),
      (spanId: string) => ({ spanId: 7, disposition: exportedDisposition() }) as unknown as Record<string, unknown> & { spanId: string },
      (spanId: string) => entryFor(spanId, 'exported@collector'),
    ]) {
      const { result } = await runSent((spanId) => ({ dispositions: [entry(spanId)], errorKind: null }));
      expect(result).toEqual(SEND_FAILED_UNKNOWN);
    }
    const { result } = await runSent((spanId) => ({ dispositions: [entryFor(spanId, { state: 'pending' })], errorKind: 'http-5xx' }));
    expect(result).toEqual({ outcome: 'send-failed', errorKind: 'http-5xx' });
  });

  it('returns send-failed when exported disposition has extra own keys', async () => {
    const { result } = await runSent((spanId) => ({
      dispositions: [entryFor(spanId, { state: 'exported', route: 'collector', extra: 1 })],
      errorKind: null,
    }));
    expect(result).toEqual(SEND_FAILED_UNKNOWN);
  });

  it('returns send-failed when exported disposition has symbol keys, getters, revoked Proxy, or __proto__', async () => {
    const hostile: (() => unknown)[] = [
      () => ({ ...exportedDisposition(), [Symbol('extra')]: 1 }),
      () => throwingGetter({ route: 'collector' }, 'state'),
      () => throwingGetter({ state: 'exported' }, 'route'),
      () => revokedProxy(exportedDisposition()),
      () =>
        Object.defineProperty(exportedDisposition(), '__proto__', {
          value: { state: 'exported' },
          enumerable: true,
          configurable: true,
          writable: true,
        }),
      () => Object.create({ state: 'exported', route: 'collector' }) as unknown,
    ];
    for (const disposition of hostile) {
      const { result } = await runSent((spanId) => ({ dispositions: [entryFor(spanId, disposition())], errorKind: null }));
      expect(result, 'disposition must not read as exported').toEqual(SEND_FAILED_UNKNOWN);
    }
  });

  it('returns send-failed when exported disposition has an invalid route', async () => {
    for (const route of ['canary', 'COLLECTOR', '', null, 7, undefined]) {
      const { result } = await runSent((spanId) => ({
        dispositions: [entryFor(spanId, { state: 'exported', route })],
        errorKind: null,
      }));
      expect(result).toEqual(SEND_FAILED_UNKNOWN);
    }
    const valid = await runSent((spanId) => ({ dispositions: [entryFor(spanId, { state: 'exported', route: 'phoenix' })], errorKind: null }));
    expect(valid.result.outcome).toBe('exported');
  });
});
