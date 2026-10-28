/**
 * The nominal `TelemetrySpan` and the pricing gate (plan §3.2 "How it is
 * enforced", §3.1, §3.6): the one object the encoder accepts, built only by
 * `TelemetrySpan.build`. Ids, name, kind, times, status and events are
 * validated, attributes pass through OT1a-2's allow-list and carry the two
 * builder-owned keys. Pure: no `node:*`, no clock, no salt.
 */

import { readExactPlainRecord, isCalendarDateTime } from './plain-record-reads.js';
import { LANE_RUN_JOURNAL_REASON_CODE_PATTERN } from './lane-run-journal.js';
import { LANE_RUN_STATES } from './value-objects/LaneRunState.vo.js';
import type { LaneRunStateValue } from './value-objects/LaneRunState.vo.js';
import {
  TELEMETRY_SCHEMA_VERSION,
  TELEMETRY_SPAN_ID_PATTERN,
  TELEMETRY_TRACE_ID_PATTERN,
} from './run-telemetry-ids.js';
import {
  filterTelemetryAttributes,
  TELEMETRY_SPAN_KINDS,
} from './run-telemetry-attributes.js';
import type { TelemetryAttributeValue, TelemetrySpanKind } from './run-telemetry-attributes.js';

/** Fixed span names (plan §3.1); `review` names a hand-run review receipt until receipts carry a kind. */
export const TELEMETRY_SPAN_NAMES = [
  'lane-run', 'round', 'prepare', 'dispatch', 'attempt', 'usage', 'collect', 'reconcile', 'stop', 'gate',
  'brief-check', 'code-review', 'pre-merge', 'review', 'accept', 'open-pr', 'push', 'merge', 'ci-wait',
  'park', 'stop-request',
] as const;
export type TelemetrySpanName = (typeof TELEMETRY_SPAN_NAMES)[number];

export const TELEMETRY_STATUS_CODES = ['unset', 'ok', 'error'] as const;
export type TelemetryStatusCode = (typeof TELEMETRY_STATUS_CODES)[number];
/** A status message is a reason code or nothing (plan §3.2). */
export interface TelemetrySpanStatus {
  readonly code: TelemetryStatusCode;
  readonly reasonCode: string | null;
}

/** The root's conduct entries as events (plan §3.1): the state name only. */
export interface TelemetrySpanEvent {
  readonly name: 'state.entered';
  readonly timeIso: string;
  readonly state: LaneRunStateValue;
}
export const TELEMETRY_MAX_EVENTS = 64;

export interface TelemetrySpanInput {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly name: TelemetrySpanName;
  readonly kind: TelemetrySpanKind;
  readonly startIso: string;
  readonly endIso: string;
  readonly status: TelemetrySpanStatus;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly events: readonly TelemetrySpanEvent[];
}

const INPUT_KEYS: readonly string[] = [
  'traceId', 'spanId', 'parentSpanId', 'name', 'kind', 'startIso', 'endIso', 'status', 'attributes', 'events',
];
const STATUS_KEYS: readonly string[] = ['code', 'reasonCode'];
const EVENT_KEYS: readonly string[] = ['name', 'timeIso', 'state'];

const ZONED_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const ALL_ZEROS_PATTERN = /^0+$/;
const SPAN_BRAND = 'fleet-telemetry-span/v1';

/** A hex id that is not all zeros (an all-zero id is invalid in OTLP, plan §3.4). */
function isNonZeroHex(value: unknown, pattern: RegExp): boolean {
  return typeof value === 'string' && pattern.test(value) && !ALL_ZEROS_PATTERN.test(value);
}

function isTraceId(value: unknown): boolean {
  return isNonZeroHex(value, TELEMETRY_TRACE_ID_PATTERN);
}

function isSpanId(value: unknown): boolean {
  return isNonZeroHex(value, TELEMETRY_SPAN_ID_PATTERN);
}

/** A zoned ISO-8601 string naming a real calendar instant. */
function isZonedTime(value: unknown): boolean {
  if (typeof value !== 'string' || !ZONED_ISO_PATTERN.test(value)) {
    return false;
  }
  return isCalendarDateTime(value) && Number.isFinite(Date.parse(value));
}

/** A status record with a known code and a reason code or nothing. */
function isStatus(value: unknown): boolean {
  const record = readExactPlainRecord(value, STATUS_KEYS);
  if (record === null) {
    return false;
  }
  if (typeof record.code !== 'string' || !(TELEMETRY_STATUS_CODES as readonly string[]).includes(record.code)) {
    return false;
  }
  if (record.reasonCode === null) {
    return true;
  }
  return typeof record.reasonCode === 'string' && LANE_RUN_JOURNAL_REASON_CODE_PATTERN.test(record.reasonCode);
}

/** Frozen normalised copies of at most 64 state-entry events, or null. */
function readEvents(value: unknown): readonly TelemetrySpanEvent[] | null {
  if (!Array.isArray(value) || value.length > TELEMETRY_MAX_EVENTS) {
    return null;
  }
  const events: TelemetrySpanEvent[] = [];
  for (const entry of value) {
    const record = readExactPlainRecord(entry, EVENT_KEYS);
    if (record === null || record.name !== 'state.entered') {
      return null;
    }
    if (!isZonedTime(record.timeIso)) {
      return null;
    }
    if (typeof record.state !== 'string' || !(LANE_RUN_STATES as readonly string[]).includes(record.state)) {
      return null;
    }
    events.push(
      Object.freeze({
        name: 'state.entered' as const,
        timeIso: new Date(record.timeIso as string).toISOString(),
        state: record.state as LaneRunStateValue,
      }),
    );
  }
  return Object.freeze(events);
}

export class TelemetrySpan {
  readonly #brand: typeof SPAN_BRAND = SPAN_BRAND;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly name: TelemetrySpanName;
  readonly kind: TelemetrySpanKind;
  /** Normalised with toISOString(). */
  readonly startIso: string;
  readonly endIso: string;
  readonly status: TelemetrySpanStatus;
  /** Allow-listed and validated (OT1a-2), plus `fleet.telemetry.schema` and `openinference.span.kind`. */
  readonly attributes: Readonly<Record<string, TelemetryAttributeValue>>;
  readonly events: readonly TelemetrySpanEvent[];

  private constructor(fields: TelemetrySpanInput /* already validated and normalised */) {
    this.traceId = fields.traceId;
    this.spanId = fields.spanId;
    this.parentSpanId = fields.parentSpanId;
    this.name = fields.name;
    this.kind = fields.kind;
    this.startIso = fields.startIso;
    this.endIso = fields.endIso;
    this.status = fields.status;
    this.attributes = fields.attributes as Readonly<Record<string, TelemetryAttributeValue>>;
    this.events = fields.events;
    Object.freeze(this);
  }

  /** The only way to make a span (plan §3.2). Null on any invalid field; never throws. */
  static build(input: unknown): TelemetrySpan | null {
    try {
      const record = readExactPlainRecord(input, INPUT_KEYS);
      if (record === null) {
        return null;
      }
      if (!isTraceId(record.traceId) || !isSpanId(record.spanId)) {
        return null;
      }
      const parentSpanId = record.parentSpanId as string | null;
      if (parentSpanId !== null && (!isSpanId(parentSpanId) || parentSpanId === record.spanId)) {
        return null;
      }
      const name = record.name;
      if (typeof name !== 'string' || !(TELEMETRY_SPAN_NAMES as readonly string[]).includes(name)) {
        return null;
      }
      const kind = record.kind;
      if (typeof kind !== 'string' || !(TELEMETRY_SPAN_KINDS as readonly string[]).includes(kind)) {
        return null;
      }
      if (!isZonedTime(record.startIso) || !isZonedTime(record.endIso)) {
        return null;
      }
      if (Date.parse(record.endIso as string) < Date.parse(record.startIso as string)) {
        return null;
      }
      if (!isStatus(record.status)) {
        return null;
      }
      const events = readEvents(record.events);
      if (events === null) {
        return null;
      }
      const statusSnapshot = readExactPlainRecord(record.status, STATUS_KEYS) as Record<string, unknown>;
      return new TelemetrySpan({
        traceId: record.traceId as string,
        spanId: record.spanId as string,
        parentSpanId,
        name: name as TelemetrySpanName,
        kind: kind as TelemetrySpanKind,
        startIso: new Date(record.startIso as string).toISOString(),
        endIso: new Date(record.endIso as string).toISOString(),
        status: Object.freeze({
          code: statusSnapshot.code as TelemetryStatusCode,
          reasonCode: statusSnapshot.reasonCode as string | null,
        }),
        attributes: Object.freeze({
          ...filterTelemetryAttributes(record.attributes, kind as TelemetrySpanKind),
          'openinference.span.kind': kind as TelemetrySpanKind,
          'fleet.telemetry.schema': TELEMETRY_SCHEMA_VERSION,
        }),
        events,
      });
    } catch {
      return null;
    }
  }

  /** True only for an instance built here: `#brand in value` and `value.#brand === SPAN_BRAND`. */
  static isTelemetrySpan(value: unknown): value is TelemetrySpan {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const candidate = value as TelemetrySpan;
    return (#brand in candidate) && candidate.#brand === SPAN_BRAND;
  }
}

/**
 * Plan §3.6 pricing gate: no `llm.model_name`, `llm.provider` or `llm.cost.*` key unless the span is an
 * LLM span whose `fleet.seat.billing` is `metered`. Structural input so the encoder can check anything it
 * is handed; never throws (a throw reads as unsafe).
 */
export function pricingSafe(span: { readonly kind: unknown; readonly attributes: unknown }): boolean {
  try {
    const attributes = span.attributes;
    if (typeof attributes !== 'object' || attributes === null || Array.isArray(attributes)) {
      return false;
    }
    // Every own key, enumerable or not (symbols are never attribute names), is
    // read once through its descriptor into a null-prototype snapshot; an
    // accessor reads as unsafe, so no getter can hide or change a priced key.
    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.getOwnPropertyNames(attributes)) {
      const descriptor = Object.getOwnPropertyDescriptor(attributes, key);
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        return false;
      }
      snapshot[key] = descriptor.value;
    }
    const keys = Object.keys(snapshot);
    const hasPricedKey = keys.some(
      (key) => key === 'llm.model_name' || key === 'llm.provider' || key.startsWith('llm.cost.'),
    );
    if (!hasPricedKey) {
      return true;
    }
    if (span.kind !== 'LLM') {
      return false;
    }
    return snapshot['fleet.seat.billing'] === 'metered';
  } catch {
    return false;
  }
}
