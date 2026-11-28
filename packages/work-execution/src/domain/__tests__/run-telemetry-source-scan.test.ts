/**
 * FC13C hostile-input and behaviour tests for the pure span source-text
 * scan: every input is read through the shared snapshot, every refusal is
 * the typed reason, and no refusal ever echoes the offending key, value,
 * header, block or path.
 */

import { types } from 'node:util';

import { describe, expect, it } from 'vitest';

import { TelemetrySpan } from '../run-telemetry.js';
import {
  MAX_SPAN_ATTRIBUTE_VALUE_LENGTH,
  MAX_WORKTREE_PREFIXES,
  scanSpanForSourceText,
} from '../run-telemetry-source-scan.js';

const isProxy = types.isProxy;

const MARKERS = { worktreePrefixes: ['/repo/.worktrees/lane-a'] };

/** A clean built span fixture (valid per TelemetrySpan.build). */
function cleanSpan(): TelemetrySpan {
  const span = TelemetrySpan.build({
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    parentSpanId: null,
    name: 'lane-run',
    kind: 'CHAIN',
    startIso: '2026-11-27T00:00:00.000Z',
    endIso: '2026-11-27T00:00:01.000Z',
    status: { code: 'ok', reasonCode: null },
    attributes: { 'fleet.project': 'fleet' },
    events: [],
  });
  expect(span).not.toBeNull();
  return span as TelemetrySpan;
}

/** A clean plain-object span fixture. */
function cleanPlainSpan(attributes: Record<string, unknown> = { 'fleet.project': 'fleet' }): unknown {
  return { traceId: 'c'.repeat(32), spanId: 'd'.repeat(16), attributes };
}

/** A revoked Proxy throws on every trap, including [[GetPrototypeOf]]. */
function revokedProxy(): unknown {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

/** A getter property that must never run. */
function getterOn(value: unknown, key: string, body: () => unknown = () => 1): object {
  return Object.defineProperty(value as object, key, {
    get: body,
    enumerable: true,
    configurable: true,
  });
}

function expectNoEcho(result: unknown, ...offending: string[]): void {
  const serialized = JSON.stringify(result);
  for (const text of offending) {
    expect(serialized).not.toContain(text);
    expect(String(result)).not.toContain(text);
  }
}

describe('scanSpanForSourceText clean paths', () => {
  it('accepts a clean built TelemetrySpan with the checked attribute count', () => {
    const result = scanSpanForSourceText(cleanSpan(), MARKERS, isProxy);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 'fleet.project' plus the two builder-owned keys.
      expect(result.checkedAttributes).toBe(3);
    }
  });

  it('accepts a clean plain-object span and counts its attributes', () => {
    const attributes = { 'fleet.project': 'fleet', 'fleet.step': 'dispatch', 'fleet.round': 2 };
    const result = scanSpanForSourceText(cleanPlainSpan(attributes), MARKERS, isProxy);
    expect(result).toEqual({ ok: true, checkedAttributes: 3 });
  });

  it('accepts a string-array attribute of clean strings and 256-character text', () => {
    const atLimit = 'x'.repeat(MAX_SPAN_ATTRIBUTE_VALUE_LENGTH);
    const result = scanSpanForSourceText(
      cleanPlainSpan({ 'tag.tags': ['ok', atLimit], key: atLimit }),
      { worktreePrefixes: ['/wt'] },
      isProxy,
    );
    expect(result).toEqual({ ok: true, checkedAttributes: 2 });
  });

  it('refuses a plain span missing attributes with invalid-span', () => {
    // Missing `attributes` is invalid-span even on a plain object.
    expect(scanSpanForSourceText({ traceId: 'e'.repeat(32) }, MARKERS, isProxy)).toEqual({
      ok: false,
      reason: 'invalid-span',
    });
  });
});

describe('scanSpanForSourceText detector gate', () => {
  it('refuses non-function isProxy detector with invalid-detector', () => {
    const span = cleanSpan();
    for (const detector of [null, 123, {}, 'fn', true]) {
      expect(scanSpanForSourceText(span, MARKERS, detector as never)).toEqual({
        ok: false,
        reason: 'invalid-detector',
      });
    }
  });
});

describe('scanSpanForSourceText markers', () => {
  it('refuses malformed and hostile markers without invoking getters or Proxy traps', () => {
    const span = cleanSpan();
    let getterRuns = 0;
    const cases: unknown[] = [
      null,
      undefined,
      7,
      'x',
      [],
      {},
      { prefix: '/wt' },
      { worktreePrefixes: '/wt' },
      { worktreePrefixes: {} },
      { worktreePrefixes: [] },
      { worktreePrefixes: ['/wt'], extra: 1 },
      { worktreePrefixes: ['/wt', 7] },
      { worktreePrefixes: [''] },
      { worktreePrefixes: [' padded'] },
      { worktreePrefixes: ['a\u0000b'] },
      { worktreePrefixes: ['p'.repeat(MAX_SPAN_ATTRIBUTE_VALUE_LENGTH + 1)] },
      { worktreePrefixes: Array.from({ length: MAX_WORKTREE_PREFIXES + 1 }, () => '/wt') },
      { worktreePrefixes: Object.defineProperty(['/wt'], '0', { get() { getterRuns += 1; return '/wt'; }, enumerable: true, configurable: true }) },
      { worktreePrefixes: Object.defineProperty(['/wt'], 'extra', { value: 1, enumerable: true, configurable: true }) },
      { worktreePrefixes: { length: 1, 0: '/wt' } },
      { worktreePrefixes: Object.assign(['/wt', '/wt2'], { 2: undefined, length: 3 }) },
      { worktreePrefixes: revokedProxy() },
      { worktreePrefixes: new Proxy(['/wt'], {}) },
      getterOn({ worktreePrefixes: ['/wt'] }, 'worktreePrefixes', () => { getterRuns += 1; return ['/wt']; }),
      { [Symbol('s')]: 1, worktreePrefixes: ['/wt'] },
      Object.defineProperty({}, '__proto__', { value: null, enumerable: true, configurable: true }),
      { worktreePrefixes: ['/wt'], constructor: {} },
      { worktreePrefixes: ['/wt'], prototype: {} },
      new Proxy({ worktreePrefixes: ['/wt'] }, {}),
    ];
    for (const markers of cases) {
      expect(scanSpanForSourceText(span, markers, isProxy)).toEqual({
        ok: false,
        reason: 'invalid-markers',
      });
    }
    expect(getterRuns).toBe(0);
  });

  it('accepts exactly 64 valid prefixes and refuses 65', () => {
    const span = cleanSpan();
    const prefixes = Array.from({ length: MAX_WORKTREE_PREFIXES }, (_, i) => `/wt-${i}`);
    expect(scanSpanForSourceText(span, { worktreePrefixes: prefixes }, isProxy).ok).toBe(true);
    expect(
      scanSpanForSourceText(span, { worktreePrefixes: [...prefixes, '/wt-x'] }, isProxy),
    ).toEqual({ ok: false, reason: 'invalid-markers' });
  });
});

describe('scanSpanForSourceText span gate', () => {
  it('refuses null, undefined, primitives, getters, Proxies, oversized objects, and prototype-polluting keys on span with invalid-span', () => {
    let getterRuns = 0;
    const cases: unknown[] = [
      null,
      undefined,
      7,
      'span',
      true,
      [1, 2],
      revokedProxy(),
      new Proxy({}, {}),
      getterOn({}, 'attributes', () => { getterRuns += 1; return { a: 'b' }; }),
      getterOn(cleanPlainSpan(), 'attributes', () => { getterRuns += 1; return { a: 'b' }; }),
      Object.defineProperty({ traceId: 'f'.repeat(32), attributes: { a: 'b' } }, '__proto__', { value: {}, enumerable: true, configurable: true }),
      { traceId: 'f'.repeat(32), constructor: {} },
      { traceId: 'f'.repeat(32), attributes: { a: 'b' }, prototype: {} },
      { traceId: 'f'.repeat(32), attributes: null },
      { traceId: 'f'.repeat(32), attributes: 'attrs' },
      { traceId: 'f'.repeat(32), attributes: 7 },
      { traceId: 'f'.repeat(32), attributes: ['a'] },
      { [Symbol('s')]: 1, attributes: { a: 'b' } },
    ];
    for (const span of cases) {
      expect(scanSpanForSourceText(span, MARKERS, isProxy)).toEqual({
        ok: false,
        reason: 'invalid-span',
      });
    }
    const oversized: Record<string, unknown> = { attributes: { a: 'b' } };
    for (let i = 0; i < 129; i += 1) {
      oversized[`k${i}`] = i;
    }
    expect(scanSpanForSourceText(oversized, MARKERS, isProxy)).toEqual({
      ok: false,
      reason: 'invalid-span',
    });
    // The extra-key case above still passes shape-wise; assert it separately.
    expect(
      scanSpanForSourceText({ traceId: 'f'.repeat(32), attributes: { a: 'b' }, extra: 1 }, MARKERS, isProxy).ok,
    ).toBe(true);
    expect(getterRuns).toBe(0);
  });

  it('maps an over-long plain-span attribute value to value-too-long via the snapshot path', () => {
    const long = 'v'.repeat(16_385);
    expect(scanSpanForSourceText({ attributes: { a: long } }, MARKERS, isProxy)).toEqual({
      ok: false,
      reason: 'value-too-long',
    });
  });

  it('maps non-finite and negative-zero plain-span attribute values to invalid-attribute', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -0]) {
      expect(scanSpanForSourceText({ attributes: { a: value } }, MARKERS, isProxy)).toEqual({
        ok: false,
        reason: 'invalid-attribute',
      });
    }
  });
});

describe('scanSpanForSourceText attribute values', () => {
  it('refuses unsupported attribute values, array holes, array-likes, getters, and prototype-polluting attribute keys with invalid-attribute', () => {
    const built = cleanSpan();
    let getterRuns = 0;
    const values: unknown[] = [
      true,
      false,
      null,
      { nested: 'object' },
      [['nested'], 'array'],
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -0,
      new Proxy(['ok'], {}),
      Object.defineProperty(['ok'], '0', {
        get() {
          getterRuns += 1;
          return 'nope';
        },
        enumerable: true,
        configurable: true,
      }),
    ];
    for (const value of values) {
      expect(scanSpanForSourceText({ attributes: { key: value } }, MARKERS, isProxy)).toEqual({
        ok: false,
        reason: 'invalid-attribute',
      });
      expect(
        scanSpanForSourceText({ ...built, attributes: { key: value } } as unknown as TelemetrySpan, MARKERS, isProxy),
      ).toEqual({ ok: false, reason: 'invalid-attribute' });
    }
    // Array holes are refused by the snapshot (sparse) and by array-like shapes.
    const hole: string[] = ['a', 'b'];
    delete hole[1];
    expect(scanSpanForSourceText({ attributes: { key: hole } }, MARKERS, isProxy)).toEqual({
      ok: false,
      reason: 'invalid-attribute',
    });
    expect(scanSpanForSourceText({ attributes: { key: { length: 1, 0: 'a' } } }, MARKERS, isProxy)).toEqual({
      ok: false,
      reason: 'invalid-attribute',
    });
    // Prototype-polluting attribute keys.
    for (const polluting of ['__proto__', 'constructor', 'prototype']) {
      const attributes: Record<string, unknown> = { a: 'b' };
      Object.defineProperty(attributes, polluting, { value: 'x', enumerable: true, configurable: true });
      expect(scanSpanForSourceText({ attributes }, MARKERS, isProxy)).toEqual({
        ok: false,
        reason: 'invalid-attribute',
      });
    }
    expect(getterRuns).toBe(0);
  });

  it('refuses attribute keys and values exceeding 256 characters with value-too-long and accepts 256 characters', () => {
    const atLimit = 'x'.repeat(MAX_SPAN_ATTRIBUTE_VALUE_LENGTH);
    const overLimit = `${atLimit}x`;
    expect(scanSpanForSourceText({ attributes: { [atLimit]: 'ok' } }, MARKERS, isProxy)).toEqual({
      ok: true,
      checkedAttributes: 1,
    });
    expect(scanSpanForSourceText({ attributes: { [overLimit]: 'ok' } }, MARKERS, isProxy)).toEqual({
      ok: false,
      reason: 'value-too-long',
    });
    expect(scanSpanForSourceText({ attributes: { key: overLimit } }, MARKERS, isProxy)).toEqual({
      ok: false,
      reason: 'value-too-long',
    });
    expect(scanSpanForSourceText({ attributes: { key: ['ok', overLimit] } }, MARKERS, isProxy)).toEqual({
      ok: false,
      reason: 'value-too-long',
    });
  });
});

describe('scanSpanForSourceText source-text markers', () => {
  const diffHeaders = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1,2 +1,2 @@'];
  const fenced = ['```ts', '~~~'];

  it('refuses diff headers in attribute keys, strings, and string-arrays with diff-header without echoing the value', () => {
    for (const header of diffHeaders) {
      expect(scanSpanForSourceText({ attributes: { key: `clean\n${header}` } }, MARKERS, isProxy)).toEqual({
        ok: false,
        reason: 'diff-header',
      });
      expect(scanSpanForSourceText({ attributes: { [`pre\n${header}`]: 'ok' } }, MARKERS, isProxy)).toEqual({
        ok: false,
        reason: 'diff-header',
      });
      expect(scanSpanForSourceText({ attributes: { key: ['ok', header] } }, MARKERS, isProxy)).toEqual({
        ok: false,
        reason: 'diff-header',
      });
      expectNoEcho(scanSpanForSourceText({ attributes: { key: header } }, MARKERS, isProxy), header);
    }
  });

  it('refuses fenced code blocks in attribute keys and values with fenced-code-block without echoing the value', () => {
    for (const fence of fenced) {
      expect(scanSpanForSourceText({ attributes: { key: `text\n${fence}\ncode` } }, MARKERS, isProxy)).toEqual({
        ok: false,
        reason: 'fenced-code-block',
      });
      expect(scanSpanForSourceText({ attributes: { [`a${fence}`]: 'ok' } }, MARKERS, isProxy)).toEqual({
        ok: false,
        reason: 'fenced-code-block',
      });
      expect(scanSpanForSourceText({ attributes: { key: [fence] } }, MARKERS, isProxy)).toEqual({
        ok: false,
        reason: 'fenced-code-block',
      });
      expectNoEcho(scanSpanForSourceText({ attributes: { key: fence } }, MARKERS, isProxy), fence);
    }
  });

  it('refuses worktree paths matching markers or worktree segments in attribute keys and values with worktree-path without echoing the value', () => {
    const cases: readonly string[] = [
      '/repo/.worktrees/lane-a/src/x.ts',
      '/repo/worktrees/lane-a/src/x.ts',
      'see /.worktrees/ for details',
    ];
    for (const path of cases) {
      for (const placement of [
        { attributes: { key: path } },
        { attributes: { [`k ${path}`]: 'ok' } },
        { attributes: { key: ['ok', path] } },
      ]) {
        const result = scanSpanForSourceText(placement, MARKERS, isProxy);
        expect(result).toEqual({ ok: false, reason: 'worktree-path' });
        expectNoEcho(result, path);
      }
    }
    // A marker prefix match alone (no generic segment) is refused too.
    expect(scanSpanForSourceText({ attributes: { key: '/repo/.worktrees/lane-a' } }, MARKERS, isProxy)).toEqual({
      ok: false,
      reason: 'worktree-path',
    });
  });
});
