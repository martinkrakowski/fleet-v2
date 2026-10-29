/**
 * The pure domain of the telemetry disposition store (plan §3.3 "Application",
 * §3.2 "One salt per installation", §3.5 "Dispositions from a result"): the
 * versioned record of the per-span dispositions, the salt fingerprint and the
 * export counters, plus the one merge rule every write goes through. The
 * reader never throws and never echoes an unvalidated value; the merge is a
 * pure function so the file mode and the memory mode of the store share it.
 * Time never comes from a clock: every timestamp is `request.nowIso`.
 */

import {
  TELEMETRY_ERROR_KINDS,
  TELEMETRY_FINGERPRINT_PATTERN,
  TELEMETRY_REJECT_REASONS,
  TELEMETRY_ROUTES,
  TELEMETRY_SPAN_ID_PATTERN,
  TELEMETRY_TRACE_ID_PATTERN,
  isFinalSpanDisposition,
  parseSpanDispositionText,
  spanDispositionText,
  type SpanDisposition,
  type TelemetryErrorKind,
} from './run-telemetry-ids.js';
import { readExactPlainRecord } from './plain-record-reads.js';
import { isZonedIsoDateTime } from './conductor-halt.js';

/** The record schema version; a change that must replace the file bumps it. */
export const TELEMETRY_DISPOSITION_RECORD_VERSION = 1 as const;

/** Every counter the store keeps: the export error kinds plus the queue drops (plan §3.8). */
export const TELEMETRY_COUNTER_KEYS = [...TELEMETRY_ERROR_KINDS, 'queue-drops'] as const;
export type TelemetryCounterKey = (typeof TELEMETRY_COUNTER_KEYS)[number] | TelemetryErrorKind;

/** The versioned record of `<stateDir>/telemetry-dispositions.json`; the current state is the last element of the list. */
export interface TelemetryDispositionRecord {
  readonly version: typeof TELEMETRY_DISPOSITION_RECORD_VERSION;
  /** TELEMETRY_FINGERPRINT_PATTERN, set by the first write; null until then. */
  readonly saltFingerprint: string | null;
  /** traceId → spanId → spanDispositionText(...); both keys pattern-checked. */
  readonly spans: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Every key of TELEMETRY_COUNTER_KEYS present, integers ≥ 0. */
  readonly counters: Readonly<Record<TelemetryCounterKey, number>>;
  /** Set from `request.nowIso` when a write carries `exportedAt: true`. */
  readonly lastExportAtIso: string | null;
}

/** One per-span disposition update inside a write request. */
export interface TelemetryDispositionUpdate {
  readonly traceId: string;
  readonly spanId: string;
  readonly disposition: SpanDisposition;
}

/** A write request; validated in full before anything is applied. */
export interface TelemetryDispositionWriteRequest {
  readonly saltFingerprint: string;
  readonly updates: readonly TelemetryDispositionUpdate[];
  /** Return final spans to pending (plan §3.5: `--retry-rejected` and the misconfiguration breaker). */
  readonly reopen?: boolean;
  readonly counters?: Readonly<Partial<Record<TelemetryCounterKey, number>>>;
  /** Record `nowIso` as `lastExportAtIso`. */
  readonly exportedAt?: boolean;
  readonly nowIso: string;
}

/** The most updates one write request may carry. */
const MAX_UPDATES = 4096;

const RECORD_KEYS: readonly string[] = [
  'version',
  'saltFingerprint',
  'spans',
  'counters',
  'lastExportAtIso',
];

/**
 * A plain object (prototype Object.prototype or null) whose values are read
 * through their own property descriptors, so no getter ever runs and a
 * `__proto__` or `constructor` key cannot reach the prototype chain.
 */
function plainObjectEntries(value: unknown): Array<[string, unknown]> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return null;
  }
  const entries: Array<[string, unknown]> = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable) {
      return null;
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** A new null-prototype map of the inner span entries, frozen. */
function freezeSpanEntry(entries: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const map = Object.create(null) as Record<string, string>;
  for (const key of Object.keys(entries)) {
    map[key] = entries[key]!;
  }
  return Object.freeze(map);
}

/** The empty state: no fingerprint, no spans, every counter at zero, no export time. */
export function emptyTelemetryDispositionRecord(): TelemetryDispositionRecord {
  const counters = Object.create(null) as Record<TelemetryCounterKey, number>;
  for (const key of TELEMETRY_COUNTER_KEYS) {
    counters[key] = 0;
  }
  return Object.freeze({
    version: TELEMETRY_DISPOSITION_RECORD_VERSION,
    saltFingerprint: null,
    spans: Object.freeze(Object.create(null) as Record<string, Readonly<Record<string, string>>>),
    counters: Object.freeze(counters),
    lastExportAtIso: null,
  });
}

export type TelemetryDispositionRead =
  | { readonly ok: true; readonly record: TelemetryDispositionRecord }
  | { readonly ok: false };

/**
 * The never-throwing reader of one stored record: exactly the five keys,
 * version 1, the fingerprint null or pattern-checked, spans a two-level map
 * whose keys pass the trace and span patterns and whose values pass
 * `parseSpanDispositionText`, counters exactly the TELEMETRY_COUNTER_KEYS with
 * safe integers ≥ 0, and `lastExportAtIso` null or a zoned ISO time. It
 * returns a fresh frozen copy built on `Object.create(null)` maps.
 */
export function readTelemetryDispositionRecord(input: unknown):
  | { ok: true; record: TelemetryDispositionRecord }
  | { ok: false } {
  try {
    const snapshot = readExactPlainRecord(input, RECORD_KEYS);
    if (snapshot === null) {
      return { ok: false };
    }
    if (snapshot.version !== TELEMETRY_DISPOSITION_RECORD_VERSION) {
      return { ok: false };
    }
    const fingerprint = snapshot.saltFingerprint;
    if (fingerprint !== null && !(typeof fingerprint === 'string' && TELEMETRY_FINGERPRINT_PATTERN.test(fingerprint))) {
      return { ok: false };
    }
    const spanEntries = plainObjectEntries(snapshot.spans);
    if (spanEntries === null) {
      return { ok: false };
    }
    const spans: Record<string, Readonly<Record<string, string>>> = Object.create(null);
    for (const [traceId, entryValue] of spanEntries) {
      if (!TELEMETRY_TRACE_ID_PATTERN.test(traceId)) {
        return { ok: false };
      }
      const spanTexts = plainObjectEntries(entryValue);
      if (spanTexts === null) {
        return { ok: false };
      }
      const entry: Record<string, string> = Object.create(null);
      for (const [spanId, text] of spanTexts) {
        if (!TELEMETRY_SPAN_ID_PATTERN.test(spanId) || parseSpanDispositionText(text) === null) {
          return { ok: false };
        }
        entry[spanId] = text as string;
      }
      spans[traceId] = Object.freeze(entry);
    }
    const counterEntries = plainObjectEntries(snapshot.counters);
    if (counterEntries === null) {
      return { ok: false };
    }
    const counters: Record<TelemetryCounterKey, number> = Object.create(null);
    const presentKeys = new Set<string>();
    for (const [key, value] of counterEntries) {
      if (!(TELEMETRY_COUNTER_KEYS as readonly string[]).includes(key) || !isSafeNonNegativeInteger(value)) {
        return { ok: false };
      }
      presentKeys.add(key);
      counters[key as TelemetryCounterKey] = value;
    }
    if (presentKeys.size !== TELEMETRY_COUNTER_KEYS.length) {
      return { ok: false };
    }
    for (const key of TELEMETRY_COUNTER_KEYS) {
      counters[key] ??= 0;
    }
    const lastExportAtIso = snapshot.lastExportAtIso;
    if (lastExportAtIso !== null && !isZonedIsoDateTime(lastExportAtIso)) {
      return { ok: false };
    }
    return {
      ok: true,
      record: Object.freeze({
        version: TELEMETRY_DISPOSITION_RECORD_VERSION,
        saltFingerprint: fingerprint,
        spans: Object.freeze(spans),
        counters: Object.freeze(counters),
        lastExportAtIso,
      }),
    };
  } catch {
    return { ok: false };
  }
}

export type TelemetryDispositionWriteOutcome =
  | { readonly outcome: 'written'; readonly record: TelemetryDispositionRecord; readonly applied: number; readonly kept: number }
  | { readonly outcome: 'refused'; readonly reason: 'invalid-request' | 'salt-mismatch' };

/** A valid write request, decoded: nothing else is applied. */
interface DecodedWriteRequest {
  readonly saltFingerprint: string;
  readonly updates: readonly TelemetryDispositionUpdate[];
  readonly reopen: boolean;
  readonly counters: Readonly<Partial<Record<TelemetryCounterKey, number>>>;
  readonly exportedAt: boolean;
  readonly nowIso: string;
}

const WRITE_REQUIRED_KEYS: readonly string[] = ['saltFingerprint', 'updates', 'nowIso'];
const WRITE_OPTIONAL_KEYS: readonly string[] = ['reopen', 'counters', 'exportedAt'];

/**
 * Validates the whole request before anything is applied; one invalid element
 * refuses the entire request. Never echoes an unvalidated value.
 */
function decodeWriteRequest(request: unknown): DecodedWriteRequest | null {
  const entries = plainObjectEntries(request);
  if (entries === null) {
    return null;
  }
  const fields = new Map<string, unknown>();
  for (const [key, value] of entries) {
    if (!WRITE_REQUIRED_KEYS.includes(key) && !WRITE_OPTIONAL_KEYS.includes(key)) {
      return null;
    }
    fields.set(key, value);
  }
  for (const key of WRITE_REQUIRED_KEYS) {
    if (!fields.has(key)) {
      return null;
    }
  }
  const saltFingerprint = fields.get('saltFingerprint');
  const updates = fields.get('updates');
  const reopen = fields.get('reopen');
  const counters = fields.get('counters');
  const exportedAt = fields.get('exportedAt');
  const nowIso = fields.get('nowIso');
  if (typeof saltFingerprint !== 'string' || !TELEMETRY_FINGERPRINT_PATTERN.test(saltFingerprint)) {
    return null;
  }
  if (!Array.isArray(updates) || updates.length > MAX_UPDATES) {
    return null;
  }
  const decodedUpdates: TelemetryDispositionUpdate[] = [];
  for (const raw of updates) {
    const update = readExactPlainRecord(raw, ['traceId', 'spanId', 'disposition']);
    if (
      update === null ||
      typeof update.traceId !== 'string' ||
      !TELEMETRY_TRACE_ID_PATTERN.test(update.traceId) ||
      typeof update.spanId !== 'string' ||
      !TELEMETRY_SPAN_ID_PATTERN.test(update.spanId) ||
      typeof update.disposition !== 'object' ||
      update.disposition === null ||
      spanDispositionText(update.disposition) === null
    ) {
      return null;
    }
    decodedUpdates.push({
      traceId: update.traceId,
      spanId: update.spanId,
      disposition: update.disposition as SpanDisposition,
    });
  }
  if (reopen !== undefined && reopen !== null && typeof reopen !== 'boolean') {
    return null;
  }
  if (exportedAt !== undefined && exportedAt !== null && typeof exportedAt !== 'boolean') {
    return null;
  }
  const decodedCounters: Record<TelemetryCounterKey, number> = Object.create(null);
  if (counters !== undefined && counters !== null) {
    const entries = plainObjectEntries(counters);
    if (entries === null) {
      return null;
    }
    for (const [key, value] of entries) {
      if (!(TELEMETRY_COUNTER_KEYS as readonly string[]).includes(key) || !isSafeNonNegativeInteger(value)) {
        return null;
      }
      decodedCounters[key as TelemetryCounterKey] = value;
    }
  }
  if (!isZonedIsoDateTime(nowIso)) {
    return null;
  }
  return {
    saltFingerprint,
    updates: decodedUpdates,
    reopen: reopen === true,
    counters: decodedCounters,
    exportedAt: exportedAt === true,
    nowIso,
  };
}

/**
 * The single-writer merge (plan §3.3), pure and shared by both store modes.
 * The request is validated in full first (`invalid-request`); a fingerprint
 * that differs from the recorded one is refused (`salt-mismatch`) and writes
 * nothing; the first write records the request's fingerprint. Each update
 * applies to its one `(traceId, spanId)` entry only: a `pending` update keeps
 * a stored final entry unless `reopen` is true, and a final update always
 * replaces whatever is there. Counters are increments; `exportedAt` sets
 * `lastExportAtIso` from `nowIso`. The result is a new frozen record;
 * `current` is never mutated.
 */
export function applyDispositionWrite(
  current: TelemetryDispositionRecord,
  request: unknown,
): TelemetryDispositionWriteOutcome {
  try {
    const decoded = decodeWriteRequest(request);
    if (decoded === null) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
    if (current.saltFingerprint !== null && current.saltFingerprint !== decoded.saltFingerprint) {
      return { outcome: 'refused', reason: 'salt-mismatch' };
    }
    let applied = 0;
    let kept = 0;
    const spans: Record<string, Record<string, string>> = {};
    for (const [traceId, entry] of Object.entries(current.spans)) {
      spans[traceId] = { ...entry };
    }
    for (const update of decoded.updates) {
      const stored = spans[update.traceId]?.[update.spanId];
      const text = spanDispositionText(update.disposition);
      if (text === null) {
        return { outcome: 'refused', reason: 'invalid-request' };
      }
      const storedDisposition = stored === undefined ? null : parseSpanDispositionText(stored);
      const storedIsFinal = storedDisposition !== null && isFinalSpanDisposition(storedDisposition);
      if (storedIsFinal && text === 'pending' && !decoded.reopen) {
        kept += 1;
        continue;
      }
      if (spans[update.traceId] === undefined) {
        spans[update.traceId] = Object.create(null) as Record<string, string>;
      }
      spans[update.traceId]![update.spanId] = text;
      applied += 1;
    }
    const counters: Record<TelemetryCounterKey, number> = Object.create(null);
    for (const key of TELEMETRY_COUNTER_KEYS) {
      counters[key] = current.counters[key];
    }
    for (const key of Object.keys(decoded.counters) as TelemetryCounterKey[]) {
      const increment = decoded.counters[key];
      if (increment !== undefined) {
        counters[key] = counters[key] + increment;
      }
    }
    const record: TelemetryDispositionRecord = Object.freeze({
      version: TELEMETRY_DISPOSITION_RECORD_VERSION,
      saltFingerprint: decoded.saltFingerprint,
      spans: Object.freeze(
        Object.fromEntries(
          Object.entries(spans).map(([traceId, entry]) => [traceId, freezeSpanEntry(entry)]),
        ),
      ) as Readonly<Record<string, Readonly<Record<string, string>>>>,
      counters: Object.freeze(counters),
      lastExportAtIso: decoded.exportedAt ? decoded.nowIso : current.lastExportAtIso,
    });
    return { outcome: 'written', record, applied, kept };
  } catch {
    return { outcome: 'refused', reason: 'invalid-request' };
  }
}

/**
 * The dispositions of one trace: spanId → the parsed disposition. An unknown
 * or invalid trace id is an empty map. Invalid stored texts are skipped.
 */
export function dispositionsOfTrace(
  record: TelemetryDispositionRecord,
  traceId: string,
): ReadonlyMap<string, SpanDisposition> {
  const out = new Map<string, SpanDisposition>();
  try {
    if (!TELEMETRY_TRACE_ID_PATTERN.test(traceId)) {
      return out;
    }
    const entry = record.spans[traceId];
    if (entry === undefined) {
      return out;
    }
    for (const spanId of Object.keys(entry)) {
      if (!TELEMETRY_SPAN_ID_PATTERN.test(spanId)) {
        continue;
      }
      const disposition = parseSpanDispositionText(entry[spanId]);
      if (disposition !== null) {
        out.set(spanId, disposition);
      }
    }
    return out;
  } catch {
    return out;
  }
}

/**
 * The disposition counts across all spans, for `telemetry status`: every
 * `pending`, `exported@<route>` and `rejected:<reason>` text with the number
 * of spans carrying it. Keys the store can hold are all enumerated, so the
 * result is deterministic.
 */
export function dispositionCounts(record: TelemetryDispositionRecord): Readonly<Record<string, number>> {
  const counts: Record<string, number> = Object.create(null);
  const possibleTexts: string[] = ['pending'];
  for (const route of TELEMETRY_ROUTES) {
    possibleTexts.push(`exported@${route}`);
  }
  for (const reason of TELEMETRY_REJECT_REASONS) {
    possibleTexts.push(`rejected:${reason}`);
  }
  for (const text of possibleTexts) {
    counts[text] = 0;
  }
  try {
    for (const entry of Object.values(record.spans)) {
      for (const text of Object.values(entry)) {
        if (typeof text === 'string' && text in counts) {
          counts[text] = counts[text]! + 1;
        }
      }
    }
  } catch {
    return counts;
  }
  return Object.freeze(counts);
}
