/**
 * FC13C hostile-input and marker tests for the control-plane span scan: the
 * scanner never throws, every refusal is the typed reason, no offending
 * value, key, or prefix is ever echoed, and a clean span passes.
 */

import { types } from 'node:util';

import { describe, expect, it } from 'vitest';

import { TelemetrySpan } from '../run-telemetry.js';
import {
  MAX_SPAN_ATTRIBUTE_VALUE_LENGTH,
  MAX_WORKTREE_PREFIXES,
  scanSpanForSourceText,
} from '../run-telemetry-source-scan.js';

const MARKERS = { worktreePrefixes: ['/wt/'] };

/** `run-` + 25 chars from [0-9A-HJKMNP-TV-Z] with a [0-7] first character. */
const RUN_ID = 'run-01AAAAAAAAAAAAAAAAAAAAAAA';
const TRACE_ID = 'a'.repeat(32);
const SPAN_ID = 'b'.repeat(16);
const ISO = '2026-11-26T00:00:00.000Z';

/** A clean TelemetrySpan fixture with three checked attributes. */
function cleanSpan(): TelemetrySpan {
  const span = TelemetrySpan.build({
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    parentSpanId: null,
    name: 'lane-run',
    kind: 'AGENT',
    startIso: ISO,
    endIso: ISO,
    status: { code: 'ok', reasonCode: null },
    attributes: { 'fleet.project': 'demo', 'fleet.run.id': RUN_ID },
    events: [],
  });
  expect(span).not.toBeNull();
  return span as TelemetrySpan;
}

function cleanSpanInput(): Record<string, unknown> {
  return {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    parentSpanId: null,
    name: 'lane-run',
    kind: 'AGENT',
    startIso: ISO,
    endIso: ISO,
    status: { code: 'ok', reasonCode: null },
    attributes: { 'fleet.project': 'demo' },
    events: [],
  };
}

/** Refusal JSON must never carry the offending text. */
function expectNoEcho(offending: string, ...results: unknown[]): void {
  for (const result of results) {
    const serialised = JSON.stringify(result) ?? '';
    expect(serialised).not.toContain(offending);
  }
}

describe('scanSpanForSourceText', () => {
  it('accepts a clean TelemetrySpan with its checked attribute count', () => {
    const span = cleanSpan();
    expect(scanSpanForSourceText(span, MARKERS)).toEqual({ ok: true, checkedAttributes: 3 });
  });

  it('accepts a clean plain-object span with its checked attribute count', () => {
    const span = cleanSpanInput();
    span.attributes = { alpha: 'one', beta: ['x', 'y'], gamma: 7 };
    expect(scanSpanForSourceText(span, MARKERS)).toEqual({ ok: true, checkedAttributes: 3 });
  });

  it('accepts 256-character keys and values (exactly at the cap) and numbers', () => {
    const atCap = 'k'.repeat(MAX_SPAN_ATTRIBUTE_VALUE_LENGTH);
    const span = cleanSpanInput();
    span.attributes = { [atCap]: atCap, ['arr']: [atCap], ['n']: 42 };
    expect(scanSpanForSourceText(span, MARKERS)).toEqual({ ok: true, checkedAttributes: 3 });
  });

  it('refuses non-function isProxy detectors with invalid-detector', () => {
    const span = cleanSpanInput();
    // `undefined` takes the `() => false` default and passes; every other
    // non-function value is refused.
    expect(scanSpanForSourceText(span, MARKERS, undefined)).toEqual({ ok: true, checkedAttributes: 1 });
    for (const isProxy of [null, 123, {}, 'fn', true]) {
      expect(scanSpanForSourceText(span, MARKERS, isProxy as never)).toEqual({
        ok: false,
        reason: 'invalid-detector',
      });
    }
  });

  it('refuses malformed and hostile markers without invoking getters or Proxy traps', () => {
    const span = cleanSpanInput();
    const gettersRun: string[] = [];
    const getterMarkers = Object.defineProperty({}, 'worktreePrefixes', {
      get() {
        gettersRun.push('worktreePrefixes');
        return ['/wt/'];
      },
      enumerable: true,
      configurable: true,
    });
    const getterArray = Object.defineProperty([], '0', {
      get() {
        gettersRun.push('0');
        return '/wt/';
      },
      enumerable: true,
      configurable: true,
    });
    const hostile: Array<[unknown, string]> = [
      [null, 'null'],
      [undefined, 'undefined'],
      [7, 'primitive'],
      ['x', 'primitive'],
      [['/wt/'], 'array'],
      [{}, 'empty object'],
      [{ prefixes: ['/wt/'] }, 'missing worktreePrefixes'],
      [{ worktreePrefixes: ['/wt/'], extra: 1 }, 'extra keys'],
      [{ worktreePrefixes: [] }, 'empty prefixes'],
      [{ worktreePrefixes: [7] }, 'non-string prefix'],
      [{ worktreePrefixes: [''] }, 'empty prefix'],
      [{ worktreePrefixes: [' padded '] }, 'untrimmed prefix'],
      [{ worktreePrefixes: ['a\u0000b'] }, 'NUL prefix'],
      [{ worktreePrefixes: ['k'.repeat(257)] }, 'over-long prefix'],
      [{ worktreePrefixes: Array.from({ length: MAX_WORKTREE_PREFIXES + 1 }, () => 'p') }, 'too many prefixes'],
      [{ worktreePrefixes: getterArray }, 'getter in prefixes'],
      [getterMarkers, 'getter on markers'],
      [{ length: 1, 0: '/wt/' }, 'array-like'],
    ];
    for (const [markers, label] of hostile) {
      expect(scanSpanForSourceText(span, markers), label).toEqual({ ok: false, reason: 'invalid-markers' });
    }
    expect(gettersRun).toEqual([]);
    expect(scanSpanForSourceText(span, new Proxy({ worktreePrefixes: ['/wt/'] }, {}), types.isProxy as never))
      .toEqual({ ok: false, reason: 'invalid-markers' });
    const polluted = { worktreePrefixes: ['/wt/'] } as Record<string, unknown>;
    Object.defineProperty(polluted, '__proto__', { value: {}, enumerable: true, configurable: true });
    expect(scanSpanForSourceText(span, polluted)).toEqual({ ok: false, reason: 'invalid-markers' });
    const pollutedConstructor = { worktreePrefixes: ['/wt/'] } as Record<string, unknown>;
    Object.defineProperty(pollutedConstructor, 'constructor', { value: 1, enumerable: true, configurable: true });
    expect(scanSpanForSourceText(span, pollutedConstructor)).toEqual({ ok: false, reason: 'invalid-markers' });
  });

  it('refuses null, undefined, primitives, getters, Proxies, oversized objects, and prototype-polluting keys on span with invalid-span', () => {
    const getterSpan = Object.defineProperty({}, 'attributes', {
      get() {
        throw new Error('the span getter must never run');
      },
      enumerable: true,
      configurable: true,
    });
    const oversized: Record<string, unknown> = {};
    for (let i = 0; i < 129; i += 1) {
      oversized[`key${i}`] = i;
    }
    const polluted = { attributes: {} } as Record<string, unknown>;
    Object.defineProperty(polluted, 'constructor', { value: 1, enumerable: true, configurable: true });
    const { revoke, proxy } = Proxy.revocable({ attributes: {} }, {});
    revoke();
    const bad: Array<[unknown, string]> = [
      [null, 'null'],
      [undefined, 'undefined'],
      [7, 'primitive'],
      ['x', 'primitive'],
      [true, 'primitive'],
      [['attributes'], 'array'],
      [{}, 'missing attributes'],
      [{ attributes: null }, 'null attributes'],
      [{ attributes: 5 }, 'primitive attributes'],
      [{ attributes: ['a'] }, 'array attributes'],
      [getterSpan, 'getter on attributes'],
      [new Proxy({ attributes: {} }, {}), 'Proxy'],
      [proxy, 'revoked Proxy'],
      [oversized, 'too many keys'],
      [polluted, 'prototype-polluting key'],
    ];
    for (const [span, label] of bad) {
      expect(scanSpanForSourceText(span, MARKERS, types.isProxy as never), label).toEqual({
        ok: false,
        reason: 'invalid-span',
      });
    }
  });

  it('refuses unsupported attribute values, array holes, array-likes, getters, and prototype-polluting attribute keys with invalid-attribute', () => {
    for (const bad of [true, false, null, undefined, { nested: 1 }, Number.NaN, Infinity, -0, ['a', 2]]) {
      const span = cleanSpanInput();
      span.attributes = { key: bad };
      expect(scanSpanForSourceText(span, MARKERS), JSON.stringify(bad)).toEqual({
        ok: false,
        reason: 'invalid-attribute',
      });
    }
    const sparse = ['a', 'b'];
    delete sparse[1];
    let value = cleanSpanInput();
    value.attributes = { key: sparse };
    expect(scanSpanForSourceText(value, MARKERS)).toEqual({ ok: false, reason: 'invalid-attribute' });
    value = cleanSpanInput();
    value.attributes = { key: { length: 1, 0: 'a' } };
    expect(scanSpanForSourceText(value, MARKERS)).toEqual({ ok: false, reason: 'invalid-attribute' });
    const getterValue = Object.defineProperty({}, 'key', {
      get() {
        throw new Error('the attribute getter must never run');
      },
      enumerable: true,
      configurable: true,
    });
    const getterSpan = cleanSpanInput();
    getterSpan.attributes = getterValue;
    expect(scanSpanForSourceText(getterSpan, MARKERS)).toEqual({ ok: false, reason: 'invalid-attribute' });
    const getterElement = Object.defineProperty(['a'], '0', {
      get() {
        throw new Error('the element getter must never run');
      },
      enumerable: true,
      configurable: true,
    });
    const getterElementSpan = cleanSpanInput();
    getterElementSpan.attributes = { key: getterElement };
    expect(scanSpanForSourceText(getterElementSpan, MARKERS)).toEqual({ ok: false, reason: 'invalid-attribute' });
    for (const pollutingKey of ['__proto__', 'constructor', 'prototype']) {
      const holder = {} as Record<string, unknown>;
      Object.defineProperty(holder, pollutingKey, { value: 'x', enumerable: true, configurable: true });
      const span = cleanSpanInput();
      span.attributes = holder;
      expect(scanSpanForSourceText(span, MARKERS), pollutingKey).toEqual({
        ok: false,
        reason: 'invalid-attribute',
      });
    }
  });

  it('refuses attribute keys and values exceeding 256 characters with value-too-long and accepts 256 characters', () => {
    const long = 'x'.repeat(MAX_SPAN_ATTRIBUTE_VALUE_LENGTH + 1);
    let span = cleanSpanInput();
    span.attributes = { [long]: 'ok' };
    expect(scanSpanForSourceText(span, MARKERS)).toEqual({ ok: false, reason: 'value-too-long' });
    span = cleanSpanInput();
    span.attributes = { key: long };
    expect(scanSpanForSourceText(span, MARKERS)).toEqual({ ok: false, reason: 'value-too-long' });
    span = cleanSpanInput();
    span.attributes = { key: [long] };
    expect(scanSpanForSourceText(span, MARKERS)).toEqual({ ok: false, reason: 'value-too-long' });
    // Above 16_384 the snapshot itself refuses with too-long, still mapped to value-too-long.
    const enormous = 'y'.repeat(16_385);
    span = cleanSpanInput();
    span.attributes = { key: enormous };
    expect(scanSpanForSourceText(span, MARKERS)).toEqual({ ok: false, reason: 'value-too-long' });
    expectNoEcho(long, scanSpanForSourceText(span, MARKERS));
  });

  it('refuses diff headers in attribute keys, strings, and string-arrays with diff-header without echoing the value', () => {
    const headers = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1,2 +1,2 @@'];
    for (const header of headers) {
      let span = cleanSpanInput();
      span.attributes = { key: header };
      expect(scanSpanForSourceText(span, MARKERS), header).toEqual({ ok: false, reason: 'diff-header' });
      span = cleanSpanInput();
      span.attributes = { [header]: 'ok' };
      expect(scanSpanForSourceText(span, MARKERS), header).toEqual({ ok: false, reason: 'diff-header' });
      span = cleanSpanInput();
      span.attributes = { key: ['clean', header] };
      expect(scanSpanForSourceText(span, MARKERS), header).toEqual({ ok: false, reason: 'diff-header' });
      expectNoEcho(header, scanSpanForSourceText(span, MARKERS));
    }
  });

  it('refuses fenced code blocks in attribute keys and values with fenced-code-block without echoing the value', () => {
    for (const fence of ['```ts', 'text ~~~ text']) {
      let span = cleanSpanInput();
      span.attributes = { key: fence };
      expect(scanSpanForSourceText(span, MARKERS), fence).toEqual({ ok: false, reason: 'fenced-code-block' });
      span = cleanSpanInput();
      span.attributes = { [fence]: 'ok' };
      expect(scanSpanForSourceText(span, MARKERS), fence).toEqual({ ok: false, reason: 'fenced-code-block' });
      span = cleanSpanInput();
      span.attributes = { key: ['a', fence] };
      expect(scanSpanForSourceText(span, MARKERS), fence).toEqual({ ok: false, reason: 'fenced-code-block' });
      expectNoEcho(fence, scanSpanForSourceText(span, MARKERS));
    }
  });

  it('refuses worktree paths matching markers or worktree segments in attribute keys and values with worktree-path without echoing the value', () => {
    const paths = ['/wt/place', 'see /worktrees/abc here', 'nested /.worktrees/xyz path'];
    for (const path of paths) {
      let span = cleanSpanInput();
      span.attributes = { key: path };
      expect(scanSpanForSourceText(span, MARKERS), path).toEqual({ ok: false, reason: 'worktree-path' });
      span = cleanSpanInput();
      span.attributes = { [path]: 'ok' };
      expect(scanSpanForSourceText(span, MARKERS), path).toEqual({ ok: false, reason: 'worktree-path' });
      span = cleanSpanInput();
      span.attributes = { key: ['clean', path] };
      expect(scanSpanForSourceText(span, MARKERS), path).toEqual({ ok: false, reason: 'worktree-path' });
      expectNoEcho(path, scanSpanForSourceText(span, MARKERS));
    }
    // A segment match works even with markers that do not cover it.
    const span = cleanSpanInput();
    span.attributes = { key: 'a/.worktrees/q' };
    expect(scanSpanForSourceText(span, { worktreePrefixes: ['unrelated'] })).toEqual({
      ok: false,
      reason: 'worktree-path',
    });
  });
});
