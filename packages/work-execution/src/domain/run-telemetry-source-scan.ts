/**
 * FC13C: control-plane span scan keeps source text out of telemetry.
 *
 * A pure domain scanner: given an untrusted telemetry span and untrusted
 * markers, it refuses any span whose attribute keys or values exceed 256
 * characters or carry a diff header, a fenced code block, or a path under a
 * worktree. Every untrusted input is read once through the shared
 * `snapshotPlainData` guard, so no getter and no Proxy trap ever runs; every
 * refusal is a typed reason that never echoes the rejected value, key, or
 * marker text. Domain-only: no I/O, no clock, no randomness, no exporter or
 * collector wiring.
 */

import { snapshotPlainData, type IsProxy } from '@fleet/shared';

import { TelemetrySpan } from './run-telemetry.js';

/** Hard cap on any scanned attribute key or string value. */
export const MAX_SPAN_ATTRIBUTE_VALUE_LENGTH = 256;

/** Hard cap on how many worktree prefixes the markers may carry. */
export const MAX_WORKTREE_PREFIXES = 64;

const POLLUTING_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

/** Typed refusal reasons; an unknown input is never an implicit pass. */
export type SpanSourceScanRefusalReason =
  | 'invalid-detector'
  | 'invalid-markers'
  | 'invalid-span'
  | 'invalid-attribute'
  | 'value-too-long'
  | 'diff-header'
  | 'fenced-code-block'
  | 'worktree-path';

/** Typed outcome: a pass with the attribute count, or a typed refusal. */
export type SpanSourceScanResult =
  | { readonly ok: true; readonly checkedAttributes: number }
  | { readonly ok: false; readonly reason: SpanSourceScanRefusalReason };

/** Marker shape: the worktree path prefixes that mark source text. */
export interface SpanSourceScanMarkers {
  readonly worktreePrefixes: readonly string[];
}

/** Bounds for the markers snapshot: 1 node + 1 node + up to 64 prefix strings. */
const MARKER_LIMITS = {
  maxDepth: 3,
  maxKeys: 8,
  maxArrayLength: 64,
  maxNodes: 128,
  maxStringLength: 256,
} as const;

/** Bounds for a whole plain-object span snapshot. */
const SPAN_LIMITS = {
  maxDepth: 3,
  maxKeys: 128,
  maxArrayLength: 64,
  maxNodes: 512,
  maxStringLength: 16_384,
} as const;

/** Bounds for the attributes snapshot of a `TelemetrySpan` instance. */
const ATTRIBUTE_LIMITS = {
  maxDepth: 3,
  maxKeys: 128,
  maxArrayLength: 64,
  maxNodes: 512,
  maxStringLength: 16_384,
} as const;

const DIFF_HEADER_PATTERN =
  /^(?:diff --git |--- [ab]\/|\+\+\+ [ab]\/|@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@)/m;
const FENCED_CODE_PATTERN = /```|~~~/;
const WORKTREE_SEGMENT_PATTERN = /\/\.worktrees\/|\/worktrees\/[A-Za-z0-9._-]+/;

function refusal(reason: SpanSourceScanRefusalReason): SpanSourceScanResult {
  return { ok: false, reason };
}

/** A non-empty trimmed string of at most 256 characters with no NUL byte. */
function isPrefixString(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_SPAN_ATTRIBUTE_VALUE_LENGTH
    && value.trim() === value
    && !value.includes('\u0000')
  );
}

/** Validates the snapshot markers into the accepted marker shape. */
function readMarkers(value: unknown): { ok: true; prefixes: readonly string[] } | { ok: false } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false };
  }
  for (const key of POLLUTING_KEYS) {
    if (Object.hasOwn(value, key)) {
      return { ok: false };
    }
  }
  const ownKeys = Object.keys(value);
  if (ownKeys.length !== 1 || ownKeys[0] !== 'worktreePrefixes') {
    return { ok: false };
  }
  const raw = (value as Record<string, unknown>).worktreePrefixes;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_WORKTREE_PREFIXES) {
    return { ok: false };
  }
  const prefixes: string[] = [];
  for (const entry of raw) {
    if (!isPrefixString(entry)) {
      return { ok: false };
    }
    prefixes.push(entry);
  }
  return { ok: true, prefixes };
}

/**
 * Source-text classification of one scanned string, applied to attribute
 * keys, string values, and string-array elements alike.
 */
function classifyText(text: string, prefixes: readonly string[]): SpanSourceScanRefusalReason | null {
  // O(1) length check first, then O(L) with L <= 256 for the rest.
  if (text.length > MAX_SPAN_ATTRIBUTE_VALUE_LENGTH) {
    return 'value-too-long';
  }
  if (DIFF_HEADER_PATTERN.test(text)) {
    return 'diff-header';
  }
  if (FENCED_CODE_PATTERN.test(text)) {
    return 'fenced-code-block';
  }
  for (const prefix of prefixes) {
    if (text.includes(prefix)) {
      return 'worktree-path';
    }
  }
  if (WORKTREE_SEGMENT_PATTERN.test(text)) {
    return 'worktree-path';
  }
  return null;
}

/** Validates and scans one attribute value; the key is scanned by the caller. */
function readAttributeValue(
  value: unknown,
  prefixes: readonly string[],
): { ok: true } | { ok: false; reason: SpanSourceScanRefusalReason } {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      return { ok: false, reason: 'invalid-attribute' };
    }
    return { ok: true };
  }
  if (typeof value === 'string') {
    const reason = classifyText(value, prefixes);
    return reason === null ? { ok: true } : { ok: false, reason };
  }
  if (Array.isArray(value)) {
    for (const element of value) {
      if (typeof element !== 'string') {
        return { ok: false, reason: 'invalid-attribute' };
      }
      const reason = classifyText(element, prefixes);
      if (reason !== null) {
        return { ok: false, reason };
      }
    }
    return { ok: true };
  }
  return { ok: false, reason: 'invalid-attribute' };
}

/**
 * The scan: refuses any telemetry span whose attribute keys or values exceed
 * 256 characters or contain source-text markers. Never throws, never echoes
 * a rejected value; any unexpected throw maps to `invalid-span`.
 */
export function scanSpanForSourceText(
  span: unknown,
  markers: unknown,
  isProxy: IsProxy = () => false,
): SpanSourceScanResult {
  try {
    // Step 1: O(1) detector gate, before anything else is read.
    if (typeof isProxy !== 'function') {
      return refusal('invalid-detector');
    }

    // Step 2: markers snapshot (O(K + P), bounded by MARKER_LIMITS).
    const markersSnapshot = snapshotPlainData(markers, isProxy, MARKER_LIMITS);
    const markersRead = markersSnapshot.ok
      ? readMarkers(markersSnapshot.value)
      : { ok: false as const };
    if (!markersRead.ok) {
      return refusal('invalid-markers');
    }
    const prefixes = markersRead.prefixes;

    // Step 3: span and attributes snapshot. The O(1) detector gate runs
    // before any other operation on the span.
    if (isProxy(span)) {
      return refusal('invalid-span');
    }

    let attributes: unknown;
    if (TelemetrySpan.isTelemetrySpan(span)) {
      const attributesSnapshot = snapshotPlainData(span.attributes, isProxy, ATTRIBUTE_LIMITS);
      if (!attributesSnapshot.ok) {
        return refusal(attributesSnapshot.reason === 'too-long' ? 'value-too-long' : 'invalid-attribute');
      }
      attributes = attributesSnapshot.value;
    } else {
      const spanSnapshot = snapshotPlainData(span, isProxy, SPAN_LIMITS);
      if (!spanSnapshot.ok) {
        const { reason, path } = spanSnapshot;
        if (path !== null && path.startsWith('attributes.')) {
          return refusal(reason === 'too-long' ? 'value-too-long' : 'invalid-attribute');
        }
        // `null`, `'attributes'`, and every other path is an invalid span.
        return refusal('invalid-span');
      }
      const snappedSpan = spanSnapshot.value as Record<string, unknown>;
      for (const key of POLLUTING_KEYS) {
        if (Object.hasOwn(snappedSpan, key)) {
          return refusal('invalid-span');
        }
      }
      if (!Object.hasOwn(snappedSpan, 'attributes')) {
        return refusal('invalid-span');
      }
      attributes = snappedSpan.attributes;
    }

    // Step 4: attribute key and value validation and scan (O(A * L)).
    if (typeof attributes !== 'object' || attributes === null || Array.isArray(attributes)) {
      return refusal('invalid-span');
    }
    let checkedAttributes = 0;
    for (const key of Object.keys(attributes as Record<string, unknown>)) {
      if (POLLUTING_KEYS.includes(key)) {
        return refusal('invalid-attribute');
      }
      const keyReason = classifyText(key, prefixes);
      if (keyReason !== null) {
        return refusal(keyReason);
      }
      const valueRead = readAttributeValue((attributes as Record<string, unknown>)[key], prefixes);
      if (!valueRead.ok) {
        return refusal(valueRead.reason);
      }
      checkedAttributes += 1;
    }

    // Step 6: every attribute passed.
    return { ok: true, checkedAttributes };
  } catch {
    // A revoked or lying Proxy that throws anywhere along the read path is
    // mapped to the typed refusal; no value is ever echoed.
    return refusal('invalid-span');
  }
}
