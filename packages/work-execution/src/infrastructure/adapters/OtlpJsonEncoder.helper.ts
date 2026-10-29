// Lane OT3a: the OTLP/JSON encoder for telemetry spans (encoder only, no
// network). Plan §3.2 "Never sent" and "How it is enforced", §3.5 "Wire
// format" and §3.6 "Pricing gate (OT3a, hard)". Pure and deterministic: no
// network, no clock, no environment reads, no logging, and it never throws —
// on any internal error every input is refused as `invalid` with `payload:
// null`. Refusal is per span: a span refused by the encoder (a failed brand
// check or a failed `pricingSafe` gate) is rejected with reason class
// `invalid` without being sent, so a batch containing such a span still
// encodes the rest. This is exactly the payload OT3b's transport will POST.
/**
 * The OTLP/HTTP JSON trace payload builder: `encodeOtlpTraces` turns a batch
 * of branded `TelemetrySpan`s plus the resource input into the exact bytes
 * OT3b will POST — one resource, one scope (`fleet-v2`, no version, no
 * attributes), spans with string, int, double and string-array attributes,
 * `state.entered` events and status codes. Only canonical `JSON.stringify`
 * bytes are emitted (compact, no replacer, keys in the documented order), so
 * the payload passes `redactionChecks` unchanged. Times are unix-nano
 * decimal strings; ints are decimal strings; `kind` is always the OTLP
 * integer 1 (`SPAN_KIND_INTERNAL`), the OpenInference kind travelling in the
 * `openinference.span.kind` attribute the builder sets.
 */

import {
  pricingSafe,
  TelemetrySpan,
  type TelemetrySpanEvent,
  type TelemetrySpanStatus,
} from '../../domain/run-telemetry.js';
import {
  RUN_TELEMETRY_ATTRIBUTES,
  RUN_TELEMETRY_RESOURCE_KEYS,
  telemetryResourceAttributes,
  type TelemetryAttributeValue,
  type TelemetryAttributeType,
  type TelemetryResourceInput,
} from '../../domain/run-telemetry-attributes.js';

/** The encoder's result: the payload bytes (null when no span was encoded) and per-span outcomes. */
export type OtlpEncodeResult = {
  readonly payload: Uint8Array | null;
  readonly encodedSpanIds: readonly string[];
  readonly refused: readonly { readonly index: number; readonly reason: 'invalid' }[];
};

/** The single instrumentation scope (plan §3.5): name only, no version, no attributes. */
export const OTLP_SCOPE = Object.freeze({ name: 'fleet-v2' });

/** The largest batch the encoder enumerates; the exporter batches at most 512 spans (plan §3.5). */
export const OTLP_MAX_BATCH_SPANS = 10_000;

/** Marks a value the encoder cannot serialise; the span is refused. */
const REFUSED = Symbol('otlp-refused');

/** A unix-nano decimal string for an ISO instant (decision 7). */
function unixNano(iso: string): string {
  return (BigInt(Date.parse(iso)) * 1_000_000n).toString();
}

/**
 * A null-prototype snapshot of a span's attributes, read through own data
 * descriptors exactly as `pricingSafe` does: the attribute view the encoder
 * judges is the view it writes. A getter or accessor throws, refusing the span.
 */
function attributeSnapshot(attributes: Readonly<Record<string, TelemetryAttributeValue>>): Record<string, TelemetryAttributeValue> {
  const snapshot: Record<string, TelemetryAttributeValue> = Object.create(null) as Record<string, TelemetryAttributeValue>;
  for (const key of Object.getOwnPropertyNames(attributes)) {
    const descriptor = Object.getOwnPropertyDescriptor(attributes, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
      throw new Error('attribute is not an own data property');
    }
    snapshot[key] = descriptor.value as TelemetryAttributeValue;
  }
  return snapshot;
}

/** One OTLP/JSON value object for a snapshot attribute; `REFUSED` when the span must be refused. */
function encodeValue(type: TelemetryAttributeType | undefined, value: TelemetryAttributeValue): unknown {
  if (type === 'string') {
    return typeof value === 'string' ? { stringValue: value } : REFUSED;
  }
  if (type === 'int') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      return REFUSED;
    }
    return { intValue: String(value) };
  }
  if (type === 'double') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return REFUSED;
    }
    return { doubleValue: value };
  }
  if (type === 'string-array') {
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
      return REFUSED;
    }
    return { arrayValue: { values: value.map((item) => ({ stringValue: item })) } };
  }
  // No rule (decision 8): a safe integer goes as a decimal-string intValue, a string as a stringValue.
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return { intValue: String(value) };
  }
  if (typeof value === 'string') {
    return { stringValue: value };
  }
  return REFUSED;
}

/** Code-unit order for attribute keys: the same bytes on every host and locale. */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/** The `attributes[]` list of a span, keys sorted for stable bytes; null refuses the span. */
function encodeAttributes(snapshot: Record<string, TelemetryAttributeValue>): unknown[] | null {
  // Code-unit order (not locale order) so the bytes are the same on every host.
  const keys = Object.keys(snapshot).sort(compareCodeUnits);
  const entries: unknown[] = [];
  for (const key of keys) {
    const encoded = encodeValue(RUN_TELEMETRY_ATTRIBUTES[key]?.type, snapshot[key]);
    if (encoded === REFUSED) {
      return null;
    }
    entries.push({ key, value: encoded });
  }
  return entries;
}

/** The `events[]` list: `state.entered` carries the state name only (decision 9). */
function encodeEvents(events: readonly TelemetrySpanEvent[]): unknown[] {
  return events.map((event) => ({
    timeUnixNano: unixNano(event.timeIso),
    name: 'state.entered',
    attributes: [{ key: 'fleet.state', value: { stringValue: event.state } }],
  }));
}

/** OTLP status codes: unset 0, ok 1, error 2. */
const OTLP_STATUS_CODES: Readonly<Record<TelemetrySpanStatus['code'], number>> = Object.freeze({ unset: 0, ok: 1, error: 2 });

/** The status object: an integer code, plus `message` only for a reason code (decision 10). */
function encodeStatus(status: TelemetrySpanStatus): Record<string, unknown> {
  const code = OTLP_STATUS_CODES[status.code];
  if (status.reasonCode !== null) {
    return { code, message: status.reasonCode };
  }
  return { code };
}

/** One span object (decision 6); null when any attribute refuses the span. */
function encodeSpan(span: TelemetrySpan, snapshot: Record<string, TelemetryAttributeValue>): Record<string, unknown> | null {
  const attributes = encodeAttributes(snapshot);
  if (attributes === null) {
    return null;
  }
  const encoded: Record<string, unknown> = {
    traceId: span.traceId,
    spanId: span.spanId,
  };
  if (span.parentSpanId !== null) {
    encoded.parentSpanId = span.parentSpanId;
  }
  encoded.name = span.name;
  encoded.kind = 1;
  encoded.startTimeUnixNano = unixNano(span.startIso);
  encoded.endTimeUnixNano = unixNano(span.endIso);
  encoded.attributes = attributes;
  if (span.events.length > 0) {
    encoded.events = encodeEvents(span.events);
  }
  encoded.status = encodeStatus(span.status);
  return encoded;
}

/** One input encoded, or null when it is refused (not branded, unreadable, not pricing-safe or not encodable). */
function encodeOneSpan(input: unknown): { readonly span: unknown; readonly spanId: string } | null {
  if (!TelemetrySpan.isTelemetrySpan(input)) {
    return null;
  }
  let snapshot: Record<string, TelemetryAttributeValue>;
  try {
    snapshot = attributeSnapshot(input.attributes);
  } catch {
    return null;
  }
  if (!pricingSafe({ kind: input.kind, attributes: snapshot })) {
    return null;
  }
  const span = encodeSpan(input, snapshot);
  return span === null ? null : { span, spanId: input.spanId };
}

/**
 * Encode a batch of spans plus the resource into one OTLP/JSON trace payload.
 * Every input that is not a branded `TelemetrySpan`, or whose attribute
 * snapshot fails the §3.6 `pricingSafe` gate, is refused with reason class
 * `invalid` and never reaches the payload; `encodedSpanIds` and the spans in
 * the payload follow input order. Never throws: any internal error returns
 * every input refused and `payload: null`.
 */
export function encodeOtlpTraces(spans: readonly unknown[], resource: TelemetryResourceInput): OtlpEncodeResult {
  // The input is never read again after a failure: the fallback refuses by the
  // count read once here, so a throwing proxy cannot make the fallback throw.
  let count = 0;
  try {
    const length: unknown = spans.length;
    count = typeof length === 'number' && Number.isSafeInteger(length) && length > 0 ? length : 0;
    // A batch past the bound is refused whole without enumerating it, so the
    // fallback never allocates a hostile length (Luna pre-merge, OT3a).
    if (count > OTLP_MAX_BATCH_SPANS) {
      return { payload: null, encodedSpanIds: Object.freeze([]), refused: Object.freeze([]) };
    }
    const resourceAttributes = telemetryResourceAttributes(resource);
    const resourceEntries: unknown[] = [];
    for (const key of RUN_TELEMETRY_RESOURCE_KEYS) {
      const value = resourceAttributes[key];
      if (value !== undefined) {
        resourceEntries.push({ key, value: { stringValue: value } });
      }
    }

    const encodedSpans: unknown[] = [];
    const encodedSpanIds: string[] = [];
    const refused: { index: number; reason: 'invalid' }[] = [];

    for (let index = 0; index < count; index += 1) {
      const encoded = encodeOneSpan(spans[index]);
      if (encoded === null) {
        refused.push({ index, reason: 'invalid' });
        continue;
      }
      encodedSpans.push(encoded.span);
      encodedSpanIds.push(encoded.spanId);
    }

    const payload =
      encodedSpans.length > 0
        ? new TextEncoder().encode(
            JSON.stringify({
              resourceSpans: [
                {
                  resource: { attributes: resourceEntries },
                  scopeSpans: [{ scope: OTLP_SCOPE, spans: encodedSpans }],
                },
              ],
            }),
          )
        : null;

    return { payload, encodedSpanIds: Object.freeze(encodedSpanIds), refused: Object.freeze(refused) };
  } catch {
    const refused = Array.from({ length: count }, (_unused, index) => ({ index, reason: 'invalid' as const }));
    return { payload: null, encodedSpanIds: Object.freeze([]), refused: Object.freeze(refused) };
  }
}
