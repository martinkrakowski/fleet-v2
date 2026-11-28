/**
 * FC13C: pure control-plane span scan. Given a telemetry span (a built
 * `TelemetrySpan` or a plain-object stand-in) and worktree-path markers,
 * either confirms that no attribute key or value carries source text
 * (`ok: true` with the attribute count) or refuses with a typed reason that
 * never echoes the offending key, value, header, block or path. Domain-only:
 * no port, no adapter, no exporter wiring, no clock read, no randomness, no
 * I/O. Untrusted input is read once through the shared descriptor-based
 * snapshot, so no getter and no Proxy `get` trap ever runs.
 */

import { snapshotPlainData, type IsProxy } from '@fleet/shared';

import {
  readBoundedDenseArray,
  readExactPlainRecord,
  snapshotPlainDataRecord,
} from './plain-record-reads.js';
import { TelemetrySpan } from './run-telemetry.js';

/** Longest attribute key or string value character count the scan accepts. */
export const MAX_SPAN_ATTRIBUTE_VALUE_LENGTH = 256;

/** Hard cap on how many worktree path prefixes a marker set may carry. */
export const MAX_WORKTREE_PREFIXES = 64;

/** Why a span was refused from telemetry. */
export type SpanSourceScanRefusalReason =
  | 'invalid-detector'
  | 'invalid-markers'
  | 'invalid-span'
  | 'invalid-attribute'
  | 'value-too-long'
  | 'diff-header'
  | 'fenced-code-block'
  | 'worktree-path';

/** Typed outcome: every attribute passed, or a typed refusal. */
export type SpanSourceScanResult =
  | { readonly ok: true; readonly checkedAttributes: number }
  | { readonly ok: false; readonly reason: SpanSourceScanRefusalReason };

/** The marker set the caller supplies: worktree path prefixes to refuse. */
export interface SpanSourceScanMarkers {
  readonly worktreePrefixes: readonly string[];
}

const MARKER_LIMITS = {
  maxDepth: 3,
  maxKeys: 8,
  maxArrayLength: 64,
  maxNodes: 128,
  maxStringLength: 256,
} as const;

const SPAN_LIMITS = {
  maxDepth: 3,
  maxKeys: 128,
  maxArrayLength: 64,
  maxNodes: 512,
  maxStringLength: 16_384,
} as const;

const ATTRIBUTE_LIMITS = {
  maxDepth: 3,
  maxKeys: 128,
  maxArrayLength: 64,
  maxNodes: 512,
  maxStringLength: 16_384,
} as const;

const POLLUTING_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

const DIFF_HEADER = /^(?:diff --git |--- [ab]\/|\+\+\+ [ab]\/|@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@)/m;
const FENCED_CODE_BLOCK = /```|~~~/;
const WORKTREE_SEGMENT = /\/\.worktrees\/|\/worktrees\/[A-Za-z0-9._-]+/;

/** A typed refusal (the `ok: false` half of the outcome). */
type SpanSourceScanRefusal = { readonly ok: false; readonly reason: SpanSourceScanRefusalReason };

const INVALID_MARKERS: SpanSourceScanRefusal = { ok: false, reason: 'invalid-markers' };

const invalidSpan: SpanSourceScanRefusal = { ok: false, reason: 'invalid-span' };
const invalidAttribute: SpanSourceScanRefusal = { ok: false, reason: 'invalid-attribute' };
const valueTooLong: SpanSourceScanRefusal = { ok: false, reason: 'value-too-long' };

/**
 * A non-empty trimmed string of at most `MAX_SPAN_ATTRIBUTE_VALUE_LENGTH`
 * characters with no NUL byte — the accepted shape of a worktree prefix.
 */
function isValidWorktreePrefix(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SPAN_ATTRIBUTE_VALUE_LENGTH) {
    return false;
  }
  if (value.includes('\u0000') || value.trim() !== value) {
    return false;
  }
  return true;
}

/**
 * `O(K + P)` bounded by `MARKER_LIMITS`: snapshot the untrusted marker set
 * once, then require exactly the `worktreePrefixes` key holding a dense,
 * non-empty array of at most `MAX_WORKTREE_PREFIXES` valid prefixes. Any
 * deviation is `invalid-markers`; nothing is echoed.
 */
type MarkerRead =
  | { readonly ok: true; readonly prefixes: readonly string[] }
  | { readonly ok: false; readonly reason: SpanSourceScanRefusalReason };

type AttributeRead =
  | { readonly ok: true; readonly record: Record<string, unknown> }
  | { readonly ok: false; readonly reason: SpanSourceScanRefusalReason };

function readMarkers(markers: unknown, isProxy: IsProxy): MarkerRead {
  const snap = snapshotPlainData(markers, isProxy, MARKER_LIMITS);
  if (!snap.ok) {
    return INVALID_MARKERS;
  }
  const record = readExactPlainRecord(snap.value, ['worktreePrefixes']);
  if (record === null) {
    return INVALID_MARKERS;
  }
  const bounded = readBoundedDenseArray(record.worktreePrefixes, MAX_WORKTREE_PREFIXES);
  if (bounded === null || bounded.length < 1) {
    return INVALID_MARKERS;
  }
  for (const prefix of bounded.array) {
    if (!isValidWorktreePrefix(prefix)) {
      return INVALID_MARKERS;
    }
  }
  return { ok: true, prefixes: bounded.array as readonly string[] };
}

/**
 * `O(L)` per checked string with `L <= 16_384`: the length gate is `O(1)`
 * first, then the three marker checks. Returns null when the text is clean.
 */
function firstMarkerIn(text: string): SpanSourceScanRefusalReason | null {
  if (text.length > MAX_SPAN_ATTRIBUTE_VALUE_LENGTH) {
    return 'value-too-long';
  }
  if (DIFF_HEADER.test(text)) {
    return 'diff-header';
  }
  if (FENCED_CODE_BLOCK.test(text)) {
    return 'fenced-code-block';
  }
  if (WORKTREE_SEGMENT.test(text)) {
    return 'worktree-path';
  }
  return null;
}

/** Scans one attribute key and one string value against the markers. */
function scanText(text: string, prefixes: readonly string[]): SpanSourceScanResult | null {
  const own = firstMarkerIn(text);
  if (own !== null) {
    return { ok: false, reason: own };
  }
  for (const prefix of prefixes) {
    if (text.includes(prefix)) {
      return { ok: false, reason: 'worktree-path' };
    }
  }
  return null;
}

/**
 * `O(A * L)`: validates every copied attribute key and value and scans every
 * key, string value and string-array element. Values must be finite numbers
 * (never `-0`), strings, or dense string arrays — the snapshot already
 * refused non-finite numbers, `-0`, holes, accessors and foreign shapes, so
 * anything left over is a typed refusal.
 */
function scanAttributes(
  attributes: Record<string, unknown>,
  prefixes: readonly string[],
): SpanSourceScanResult {
  const keys = Object.keys(attributes);
  for (const key of keys) {
    if (POLLUTING_KEYS.includes(key)) {
      return invalidAttribute;
    }
    const keyHit = scanText(key, prefixes);
    if (keyHit !== null) {
      return keyHit;
    }
    const value = attributes[key];
    if (typeof value === 'number') {
      continue;
    }
    if (typeof value === 'string') {
      const hit = scanText(value, prefixes);
      if (hit !== null) {
        return hit;
      }
      continue;
    }
    if (Array.isArray(value)) {
      for (const element of value) {
        if (typeof element !== 'string') {
          return invalidAttribute;
        }
        const hit = scanText(element, prefixes);
        if (hit !== null) {
          return hit;
        }
      }
      continue;
    }
    return invalidAttribute;
  }
  return { ok: true, checkedAttributes: keys.length };
}

/** Copies the snapshot's attribute record, refusing polluting keys. */
function copyAttributeRecord(
  snapshotValue: unknown,
  refusal: SpanSourceScanRefusal,
): AttributeRead {
  if (typeof snapshotValue !== 'object' || snapshotValue === null || Array.isArray(snapshotValue)) {
    return refusal;
  }
  const record = snapshotPlainDataRecord(snapshotValue);
  if (record === null) {
    // The only way the copy fails on a frozen snapshot object is an own
    // `__proto__` key: a prototype-polluting attribute key.
    return invalidAttribute;
  }
  for (const key of Object.keys(record)) {
    if (POLLUTING_KEYS.includes(key)) {
      return invalidAttribute;
    }
  }
  return { ok: true, record };
}

/**
 * `O(1)` Proxy gate plus an `O(K + N)` bounded snapshot: read the untrusted
 * span once — through the built-span brand check when it holds, otherwise as
 * a plain object — and extract its `attributes`. Every snapshot failure is
 * mapped by target and `path` per the refusal table; nothing is echoed.
 */
function readSpanAttributes(
  span: unknown,
  isProxy: IsProxy,
): AttributeRead {
  if (TelemetrySpan.isTelemetrySpan(span)) {
    const snap = snapshotPlainData(span.attributes, isProxy, ATTRIBUTE_LIMITS);
    if (!snap.ok) {
      return snap.reason === 'too-long' ? valueTooLong : invalidAttribute;
    }
    return copyAttributeRecord(snap.value, invalidAttribute);
  }
  const snap = snapshotPlainData(span, isProxy, SPAN_LIMITS);
  if (!snap.ok) {
    if (snap.path !== null && snap.path.startsWith('attributes.')) {
      return snap.reason === 'too-long' ? valueTooLong : invalidAttribute;
    }
    return invalidSpan;
  }
  const record = snapshotPlainDataRecord(snap.value);
  if (record === null) {
    return invalidSpan;
  }
  for (const key of Object.keys(record)) {
    if (POLLUTING_KEYS.includes(key)) {
      return invalidSpan;
    }
  }
  if (!Object.hasOwn(record, 'attributes')) {
    return invalidSpan;
  }
  return copyAttributeRecord(record.attributes, invalidSpan);
}

/**
 * The pure span scan: never throws, never echoes a rejected value, key,
 * marker or path. The outer catch maps any unexpected throw to
 * `invalid-span` (a revoked or lying Proxy that throws anywhere along the
 * read path is the accepted residual).
 */
export function scanSpanForSourceText(
  span: unknown,
  markers: unknown,
  isProxy: IsProxy = () => false,
): SpanSourceScanResult {
  try {
    if (typeof isProxy !== 'function') {
      return { ok: false, reason: 'invalid-detector' };
    }
    const readMarkersResult = readMarkers(markers, isProxy);
    if (!readMarkersResult.ok) {
      return readMarkersResult;
    }
    const attributes = readSpanAttributes(span, isProxy);
    if (!attributes.ok) {
      return attributes;
    }
    return scanAttributes(attributes.record, readMarkersResult.prefixes);
  } catch {
    return invalidSpan;
  }
}
