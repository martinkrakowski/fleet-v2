/**
 * The redaction checks of run telemetry (plan §3.2 "Redaction tests", enforced
 * over an encoded OTLP/JSON payload; plan §3.8 backfill `--dry-run --canary`).
 * One pure function, `redactionChecks(payloadBytes, canaryValues)`, the CLI
 * runs on real records: it prints only pass or fail per check and a count of
 * offending spans — never a key, value, canary or matched text. The report is
 * frozen and the function never throws: any internal error fails every check.
 * Pure: no `node:*`, no clock, no I/O, and nothing secret is read
 * (`TextDecoder` is a global).
 *
 * Strict OTLP/JSON decoding (OT1r-2): every object the decoder walks accepts
 * only the fields the plan's payload subset names, so a payload that smuggles
 * text in a field the checks ignore fails `payload-parses`. Only canonical JSON
 * is accepted: the encoder (OT3a) emits `JSON.stringify` output, so the parsed
 * payload must re-serialise to exactly the input text (duplicate JSON keys
 * collapse in `JSON.parse` and fail here). Every attribute carrier — resource,
 * scope, span and span event — is checked; scope and event attributes must be
 * empty, a span event is named `state.entered`, a span name is one of the
 * fixed §3.1 names, and `status.message` is absent or empty. Duplicate
 * attribute keys fail the entry. Decoded numbers are pushed as strings so a
 * numeric canary is seen.
 */

import { containsSecretShape, LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';
import {
  isNeverSentTelemetryKey,
  isTelemetryProjectAlias,
  isTelemetryServiceVersion,
  RUN_TELEMETRY_ATTRIBUTES,
  RUN_TELEMETRY_RESOURCE_KEYS,
  TELEMETRY_SERVICE_NAME,
  TELEMETRY_SPAN_KINDS,
  type TelemetryAttributeType,
  type TelemetrySpanKind,
} from './run-telemetry-attributes.js';

export const TELEMETRY_REDACTION_CHECKS = ['payload-parses', 'canaries', 'key-allow-list', 'values', 'secret-shapes'] as const;
export type TelemetryRedactionCheck = (typeof TELEMETRY_REDACTION_CHECKS)[number];

export interface TelemetryRedactionCheckResult {
  readonly check: TelemetryRedactionCheck;
  readonly pass: boolean;
  readonly offendingSpans: number;
}

export interface TelemetryRedactionReport {
  readonly pass: boolean;
  readonly checks: readonly TelemetryRedactionCheckResult[];
  readonly skippedCanaries: number;
}

/** A decoded OTLP attribute value: the shapes the payload format allows. */
type DecodedAttributeValue = string | number | readonly string[];

/**
 * One walked attribute carrier of the payload: a resource, a scope, a span or a
 * span event. key-allow-list and values run over every carrier.
 */
interface DecodedEntry {
  readonly kind: 'resource' | 'scope' | 'span' | 'event';
  /** The carrier's decoded name; resources carry no name, so ''. */
  readonly name: string;
  readonly attributes: ReadonlyMap<string, DecodedAttributeValue>;
  /** False when any attribute value of the entry could not be decoded. */
  readonly decoded: boolean;
  /** False only for a span whose `status.message` is present and non-empty. */
  readonly statusMessageEmpty: boolean;
}

interface DecodedPayload {
  readonly text: string;
  readonly entries: readonly DecodedEntry[];
  /**
   * Every decoded string the parsed payload carries, object keys and decoded
   * numbers included, from every field (scope names, event names and fields
   * the walk above ignores), so a JSON escape or a numeric literal cannot hide
   * a canary or a secret from the checks (OT1r, Luna).
   */
  readonly strings: readonly string[];
}

/** Upper bound on decoded strings walked; a larger payload fails the checks. */
const MAX_DECODED_STRINGS = 200_000;

/** Every string value, object key and decoded number in a JSON.parse result, or null past the bound. */
function allDecodedStrings(parsed: unknown): string[] | null {
  const out: string[] = [];
  const stack: unknown[] = [parsed];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === 'string') {
      out.push(value);
    } else if (typeof value === 'number') {
      out.push(String(value));
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        stack.push(value[i]);
      }
    } else if (typeof value === 'object' && value !== null) {
      for (const key of Object.keys(value)) {
        out.push(key);
        stack.push((value as Record<string, unknown>)[key]);
      }
    }
    if (out.length > MAX_DECODED_STRINGS) {
      return null;
    }
  }
  return out;
}

/** The own data-property value at `prop`, or null: no getter ever runs. */
function ownData(container: unknown, prop: string): unknown {
  if (typeof container !== 'object' || container === null) {
    return null;
  }
  const descriptor = Object.getOwnPropertyDescriptor(container, prop);
  return descriptor !== undefined && Object.hasOwn(descriptor, 'value') ? descriptor.value : null;
}

/** True when `container` has an own data property at `prop`. */
function hasOwnData(container: unknown, prop: string): boolean {
  if (typeof container !== 'object' || container === null) {
    return false;
  }
  const descriptor = Object.getOwnPropertyDescriptor(container, prop);
  return descriptor !== undefined && Object.hasOwn(descriptor, 'value');
}

/** A plain JSON object (prototype `Object.prototype` or null). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** True when `value` is a plain object whose own keys are all in `fields`. */
function hasOnlyKnownFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    return false;
  }
  return Object.keys(value).every((key) => (fields as readonly string[]).includes(key));
}

/** The known OTLP/JSON fields of the plan's payload subset, per object kind. */
const PAYLOAD_ROOT_FIELDS = ['resourceSpans'] as const;
const RESOURCE_SPANS_ITEM_FIELDS = ['resource', 'scopeSpans'] as const;
const RESOURCE_FIELDS = ['attributes'] as const;
const SCOPE_SPANS_ITEM_FIELDS = ['scope', 'spans'] as const;
const SCOPE_FIELDS = ['name', 'version', 'attributes'] as const;
const SPAN_FIELDS = [
  'traceId', 'spanId', 'parentSpanId', 'name', 'kind', 'startTimeUnixNano', 'endTimeUnixNano',
  'attributes', 'events', 'status',
] as const;
const EVENT_FIELDS = ['timeUnixNano', 'name', 'attributes'] as const;
const STATUS_FIELDS = ['code', 'message'] as const;
const ATTRIBUTE_ENTRY_FIELDS = ['key', 'value'] as const;
const VALUE_OBJECT_FIELDS = ['stringValue', 'intValue', 'doubleValue', 'arrayValue'] as const;
const ARRAY_VALUE_FIELDS = ['values'] as const;
const ARRAY_VALUE_ELEMENT_FIELDS = ['stringValue'] as const;

/**
 * The fixed span names of plan §3.1 (the trace hierarchy node labels).
 * `run-telemetry.ts` (the mapper) is a later lane and does not exist yet, so
 * the list is defined here from §3.1 rather than imported. A span name
 * outside this list fails `values`.
 */
export const TELEMETRY_PLAN_SPAN_NAMES = [
  'lane-run', 'round', 'prepare', 'dispatch', 'attempt', 'usage', 'collect',
  'reconcile', 'stop', 'gate', 'brief-check', 'code-review', 'pre-merge',
  'accept', 'open-pr', 'push', 'merge', 'ci-wait', 'park', 'stop-request',
] as const;

/** The one span event name the plan sends (§3.1): `state.entered`, state name only. */
const TELEMETRY_STATE_ENTERED_EVENT_NAME = 'state.entered';

const INT_TEXT_PATTERN = /^-?[0-9]+$/;

/** A decimal string or number that is a safe integer, or null. */
function decodeIntValue(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) ? raw : null;
  }
  if (typeof raw === 'string' && INT_TEXT_PATTERN.test(raw)) {
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/** A finite number, or null. */
function decodeDoubleValue(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/** `arrayValue`'s `values` as a string array, or null (plan: `{ stringValue }` elements). */
function decodeStringArray(value: unknown): readonly string[] | null {
  if (!hasOnlyKnownFields(value, ARRAY_VALUE_FIELDS) || !hasOwnData(value, 'values')) {
    return null;
  }
  const values = ownData(value, 'values');
  if (!Array.isArray(values)) {
    return null;
  }
  const decoded: string[] = [];
  for (const element of values) {
    if (!hasOnlyKnownFields(element, ARRAY_VALUE_ELEMENT_FIELDS) || !hasOwnData(element, 'stringValue')) {
      return null;
    }
    const text = ownData(element, 'stringValue');
    if (typeof text !== 'string') {
      return null;
    }
    decoded.push(text);
  }
  return decoded;
}

/** One OTLP attribute value: exactly one of the four supported fields, or null. */
function decodeAttributeValue(value: unknown): DecodedAttributeValue | null {
  if (!hasOnlyKnownFields(value, VALUE_OBJECT_FIELDS)) {
    return null;
  }
  if (Object.keys(value).length !== 1) {
    return null;
  }
  if (hasOwnData(value, 'stringValue')) {
    const text = ownData(value, 'stringValue');
    return typeof text === 'string' ? text : null;
  }
  if (hasOwnData(value, 'intValue')) {
    return decodeIntValue(ownData(value, 'intValue'));
  }
  if (hasOwnData(value, 'doubleValue')) {
    return decodeDoubleValue(ownData(value, 'doubleValue'));
  }
  return decodeStringArray(ownData(value, 'arrayValue'));
}

/** One attribute of the payload: a string key and one decodable value, or null. */
function readAttribute(entry: unknown): { readonly key: string; readonly value: DecodedAttributeValue } | null {
  if (!hasOnlyKnownFields(entry, ATTRIBUTE_ENTRY_FIELDS) || !hasOwnData(entry, 'key') || !hasOwnData(entry, 'value')) {
    return null;
  }
  const key = ownData(entry, 'key');
  if (typeof key !== 'string') {
    return null;
  }
  const value = decodeAttributeValue(ownData(entry, 'value'));
  if (value === null) {
    return null;
  }
  return { key, value };
}

/**
 * An `attributes[]` list into a map; `decoded` is false when any value is
 * unsupported or any key repeats (the first value wins, but a duplicate key
 * fails the entry, so free text after or before a valid value cannot pass).
 */
function readAttributes(list: unknown): { readonly attributes: ReadonlyMap<string, DecodedAttributeValue>; readonly decoded: boolean } {
  const attributes = new Map<string, DecodedAttributeValue>();
  if (!Array.isArray(list)) {
    return { attributes, decoded: false };
  }
  let decoded = true;
  for (const element of list) {
    const attribute = readAttribute(element);
    if (attribute === null) {
      decoded = false;
      continue;
    }
    if (attributes.has(attribute.key)) {
      decoded = false;
      continue;
    }
    attributes.set(attribute.key, attribute.value);
  }
  return { attributes, decoded };
}

/** One span event of the payload, appended as an `event` entry; false on a shape failure. */
function readEvent(event: unknown, entries: DecodedEntry[]): boolean {
  if (!hasOnlyKnownFields(event, EVENT_FIELDS)) {
    return false;
  }
  const name = ownData(event, 'name');
  let attributes: ReadonlyMap<string, DecodedAttributeValue> = new Map();
  let decoded = true;
  if (hasOwnData(event, 'attributes')) {
    const read = readAttributes(ownData(event, 'attributes'));
    attributes = read.attributes;
    decoded = read.decoded;
  }
  entries.push({ kind: 'event', name: typeof name === 'string' ? name : '', attributes, decoded, statusMessageEmpty: true });
  return true;
}

/** One span of the payload, appended as a `span` entry with its events; false on a shape failure. */
function readSpan(span: unknown, entries: DecodedEntry[]): boolean {
  if (!hasOnlyKnownFields(span, SPAN_FIELDS) || !hasOwnData(span, 'attributes')) {
    return false;
  }
  const read = readAttributes(ownData(span, 'attributes'));
  const name = ownData(span, 'name');
  let statusMessageEmpty = true;
  if (hasOwnData(span, 'status')) {
    const status = ownData(span, 'status');
    if (!hasOnlyKnownFields(status, STATUS_FIELDS)) {
      return false;
    }
    const message = ownData(status, 'message');
    if (typeof message !== 'string') {
      return false;
    }
    statusMessageEmpty = message.length === 0;
  }
  entries.push({
    kind: 'span',
    name: typeof name === 'string' ? name : '',
    attributes: read.attributes,
    decoded: read.decoded,
    statusMessageEmpty,
  });
  if (hasOwnData(span, 'events')) {
    const events = ownData(span, 'events');
    if (!Array.isArray(events)) {
      return false;
    }
    for (const event of events) {
      if (!readEvent(event, entries)) {
        return false;
      }
    }
  }
  return true;
}

/** One `scope` object of a `scopeSpans` element, appended as a `scope` entry; false on a shape failure. */
function readScope(scope: unknown, entries: DecodedEntry[]): boolean {
  if (!hasOnlyKnownFields(scope, SCOPE_FIELDS)) {
    return false;
  }
  const name = ownData(scope, 'name');
  let attributes: ReadonlyMap<string, DecodedAttributeValue> = new Map();
  let decoded = true;
  if (hasOwnData(scope, 'attributes')) {
    const read = readAttributes(ownData(scope, 'attributes'));
    attributes = read.attributes;
    decoded = read.decoded;
  }
  entries.push({ kind: 'scope', name: typeof name === 'string' ? name : '', attributes, decoded, statusMessageEmpty: true });
  return true;
}

/** Appends the scope and every span of one `scopeSpans` element; false on a shape failure. */
function readScopeSpans(scopeSpans: unknown, entries: DecodedEntry[]): boolean {
  if (!Array.isArray(scopeSpans)) {
    return false;
  }
  for (const scopeSpan of scopeSpans) {
    if (!hasOnlyKnownFields(scopeSpan, SCOPE_SPANS_ITEM_FIELDS) || !hasOwnData(scopeSpan, 'spans')) {
      return false;
    }
    if (hasOwnData(scopeSpan, 'scope')) {
      if (!readScope(ownData(scopeSpan, 'scope'), entries)) {
        return false;
      }
    }
    const spans = ownData(scopeSpan, 'spans');
    if (!Array.isArray(spans)) {
      return false;
    }
    for (const span of spans) {
      if (!readSpan(span, entries)) {
        return false;
      }
    }
  }
  return true;
}

/** One `resourceSpans[]` element's resource entry; false on a shape failure. */
function readResource(resource: unknown, entries: DecodedEntry[]): boolean {
  if (!hasOnlyKnownFields(resource, RESOURCE_FIELDS) || !hasOwnData(resource, 'attributes')) {
    return false;
  }
  const read = readAttributes(ownData(resource, 'attributes'));
  entries.push({ kind: 'resource', name: '', attributes: read.attributes, decoded: read.decoded, statusMessageEmpty: true });
  return true;
}

/** Walks `resourceSpans[]` into entries, or null on any shape failure. */
function readResourceSpans(resourceSpans: unknown): DecodedEntry[] | null {
  if (!Array.isArray(resourceSpans)) {
    return null;
  }
  const entries: DecodedEntry[] = [];
  for (const element of resourceSpans) {
    if (!hasOnlyKnownFields(element, RESOURCE_SPANS_ITEM_FIELDS) || !hasOwnData(element, 'resource') || !hasOwnData(element, 'scopeSpans')) {
      return null;
    }
    if (!readResource(ownData(element, 'resource'), entries)) {
      return null;
    }
    if (!readScopeSpans(ownData(element, 'scopeSpans'), entries)) {
      return null;
    }
  }
  return entries;
}

/**
 * Decodes the UTF-8 OTLP/JSON payload, or null when it does not parse.
 * Only canonical JSON is accepted: the encoder (OT3a) emits `JSON.stringify`
 * output, so the parsed payload must re-serialise to exactly the input text —
 * a duplicate JSON object key (which `JSON.parse` collapses) or any other
 * non-canonical text fails here.
 */
function decodePayload(payloadBytes: Uint8Array): DecodedPayload | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes);
    const parsed: unknown = JSON.parse(text);
    if (JSON.stringify(parsed) !== text) {
      return null;
    }
    if (!hasOnlyKnownFields(parsed, PAYLOAD_ROOT_FIELDS) || !hasOwnData(parsed, 'resourceSpans')) {
      return null;
    }
    const entries = readResourceSpans(ownData(parsed, 'resourceSpans'));
    const strings = allDecodedStrings(parsed);
    if (entries === null || strings === null) {
      return null;
    }
    return { text, entries, strings };
  } catch {
    return null;
  }
}

/** True when any attribute value of the entry contains the canary as a substring. */
function attributeValuesContain(entry: DecodedEntry, canary: string): boolean {
  for (const value of entry.attributes.values()) {
    if (Array.isArray(value)) {
      if (value.some((item) => item.includes(canary))) {
        return true;
      }
      continue;
    }
    if (typeof value === 'string' && value.includes(canary)) {
      return true;
    }
  }
  return false;
}

/** True when any decoded string the entry carries contains the canary (values, keys, name). */
function entryContainsCanary(entry: DecodedEntry, canary: string): boolean {
  if (entry.name.includes(canary)) {
    return true;
  }
  for (const key of entry.attributes.keys()) {
    if (key.includes(canary)) {
      return true;
    }
  }
  return attributeValuesContain(entry, canary);
}

/** The `canaries` check (plan §3.2 test 1): no canary in the raw text or any decoded string. */
function checkCanaries(
  payload: DecodedPayload | null,
  canaryValues: readonly string[],
): { readonly pass: boolean; readonly offendingSpans: number; readonly skippedCanaries: number } {
  if (payload === null) {
    return { pass: false, offendingSpans: 0, skippedCanaries: 0 };
  }
  const active: string[] = [];
  let skippedCanaries = 0;
  for (const canary of canaryValues) {
    const trimmed = typeof canary === 'string' ? canary.trim() : '';
    // Blank or very short values match by accident, so they are skipped (§3.8).
    if (trimmed.length === 0 || trimmed.length < 4) {
      skippedCanaries += 1;
      continue;
    }
    active.push(trimmed);
  }
  let pass = true;
  if (active.some((canary) => payload.text.includes(canary))) {
    pass = false;
  }
  // Every decoded string in the payload, not only the walked entries' fields.
  if (payload.strings.some((text) => active.some((canary) => text.includes(canary)))) {
    pass = false;
  }
  // Each offending span counts once, however many canaries it carries.
  let offendingSpans = 0;
  for (const entry of payload.entries) {
    if (active.some((canary) => entryContainsCanary(entry, canary))) {
      pass = false;
      offendingSpans += 1;
    }
  }
  return { pass, offendingSpans, skippedCanaries };
}

/** The `key-allow-list` check (plan §3.2 test 3): every key is allow-listed. */
function checkKeyAllowList(payload: DecodedPayload | null): { readonly pass: boolean; readonly offendingSpans: number } {
  if (payload === null) {
    return { pass: false, offendingSpans: 0 };
  }
  let pass = true;
  let offendingSpans = 0;
  for (const entry of payload.entries) {
    let entryPass = true;
    if (entry.kind === 'scope' || entry.kind === 'event') {
      // Scope and event attributes must be empty; any key fails.
      entryPass = entry.attributes.size === 0;
    } else if (entry.kind === 'resource') {
      for (const key of entry.attributes.keys()) {
        if (!(RUN_TELEMETRY_RESOURCE_KEYS as readonly string[]).includes(key)) {
          entryPass = false;
        }
      }
    } else {
      for (const key of entry.attributes.keys()) {
        if (isNeverSentTelemetryKey(key) || !Object.hasOwn(RUN_TELEMETRY_ATTRIBUTES, key)) {
          entryPass = false;
        }
      }
    }
    if (!entryPass) {
      pass = false;
      offendingSpans += 1;
    }
  }
  return { pass, offendingSpans };
}

/** True when the decoded value has the rule's type. */
function decodedValueMatchesType(value: DecodedAttributeValue, type: TelemetryAttributeType): boolean {
  if (type === 'string') {
    return typeof value === 'string';
  }
  if (type === 'string-array') {
    return Array.isArray(value);
  }
  return typeof value === 'number';
}

/** The span's own `openinference.span.kind`, or null when missing or invalid. */
function spanKindOf(entry: DecodedEntry): TelemetrySpanKind | null {
  const kind = entry.attributes.get('openinference.span.kind');
  if (typeof kind !== 'string' || !(TELEMETRY_SPAN_KINDS as readonly string[]).includes(kind)) {
    return null;
  }
  return kind as TelemetrySpanKind;
}

/** The span's decoded attribute map as the context object sibling rules read. */
function attributesRecordOf(entry: DecodedEntry): Readonly<Record<string, unknown>> {
  const record: Record<string, unknown> = {};
  for (const [key, value] of entry.attributes) {
    record[key] = value;
  }
  return record;
}

/**
 * Every span attribute value passes its rule, the span name is one of the
 * fixed §3.1 names, and `status.message` is absent or empty (plan §3.2 test 4;
 * the plan sends codes only).
 */
function checkSpanValues(entry: DecodedEntry): boolean {
  if (!entry.decoded || !entry.statusMessageEmpty) {
    return false;
  }
  if (!(TELEMETRY_PLAN_SPAN_NAMES as readonly string[]).includes(entry.name)) {
    return false;
  }
  const spanKind = spanKindOf(entry);
  if (spanKind === null) {
    return false;
  }
  const context = { spanKind, attributes: attributesRecordOf(entry) };
  for (const [key, value] of entry.attributes) {
    if (!Object.hasOwn(RUN_TELEMETRY_ATTRIBUTES, key)) {
      return false;
    }
    const rule = RUN_TELEMETRY_ATTRIBUTES[key];
    if (!decodedValueMatchesType(value, rule.type)) {
      return false;
    }
    try {
      if (!rule.check(value, context)) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

/** Scope attributes must be empty (the plan sends none). */
function checkScopeValues(entry: DecodedEntry): boolean {
  return entry.decoded && entry.attributes.size === 0;
}

/** Event attributes must be empty and the event name must be `state.entered` (§3.1). */
function checkEventValues(entry: DecodedEntry): boolean {
  return entry.decoded && entry.attributes.size === 0 && entry.name === TELEMETRY_STATE_ENTERED_EVENT_NAME;
}

/** The resource value rules (plan §3.2 "Resource attributes"). */
function checkResourceValues(entry: DecodedEntry): boolean {
  if (!entry.decoded) {
    return false;
  }
  let sawServiceName = false;
  for (const [key, value] of entry.attributes) {
    if (key === 'service.name') {
      if (value !== TELEMETRY_SERVICE_NAME) {
        return false;
      }
      sawServiceName = true;
      continue;
    }
    if (key === 'service.version') {
      if (!isTelemetryServiceVersion(value)) {
        return false;
      }
      continue;
    }
    if (key === 'openinference.project.name') {
      if (!isTelemetryProjectAlias(value)) {
        return false;
      }
      continue;
    }
    return false;
  }
  return sawServiceName;
}

/** The `values` check over every walked entry. */
function checkValues(payload: DecodedPayload | null): { readonly pass: boolean; readonly offendingSpans: number } {
  if (payload === null) {
    return { pass: false, offendingSpans: 0 };
  }
  let pass = true;
  let offendingSpans = 0;
  for (const entry of payload.entries) {
    let entryPass = false;
    if (entry.kind === 'resource') {
      entryPass = checkResourceValues(entry);
    } else if (entry.kind === 'scope') {
      entryPass = checkScopeValues(entry);
    } else if (entry.kind === 'event') {
      entryPass = checkEventValues(entry);
    } else {
      entryPass = checkSpanValues(entry);
    }
    if (!entryPass) {
      pass = false;
      offendingSpans += 1;
    }
  }
  return { pass, offendingSpans };
}

/** True when a secret shape matches anywhere in `text`; fail closed on any throw. */
function textHasSecretShape(text: string): boolean {
  try {
    if (containsSecretShape(text)) {
      return true;
    }
    for (const named of LANE_DIFF_SECRET_PATTERNS) {
      if (named.regex.test(text)) {
        return true;
      }
    }
  } catch {
    return true;
  }
  return false;
}

/** True when the entry's name or any attribute key or value is secret-shaped. */
function entryHasSecretShape(entry: DecodedEntry): boolean {
  if (textHasSecretShape(entry.name)) {
    return true;
  }
  for (const key of entry.attributes.keys()) {
    if (textHasSecretShape(key)) {
      return true;
    }
  }
  for (const value of entry.attributes.values()) {
    if (Array.isArray(value) && value.some((text) => textHasSecretShape(text))) {
      return true;
    }
    if (typeof value === 'string' && textHasSecretShape(value)) {
      return true;
    }
  }
  return false;
}

/** The `secret-shapes` check (plan §3.2 test 5). */
function checkSecretShapes(payload: DecodedPayload | null): { readonly pass: boolean; readonly offendingSpans: number } {
  if (payload === null) {
    return { pass: false, offendingSpans: 0 };
  }
  let offendingSpans = 0;
  for (const entry of payload.entries) {
    if (entryHasSecretShape(entry)) {
      offendingSpans += 1;
    }
  }
  // The payload text as a whole and every decoded value are checked: a shape anywhere fails.
  const pass =
    !textHasSecretShape(payload.text) &&
    offendingSpans === 0 &&
    !payload.strings.some((text) => textHasSecretShape(text));
  return { pass, offendingSpans };
}

function checkResult(check: TelemetryRedactionCheck, pass: boolean, offendingSpans: number): TelemetryRedactionCheckResult {
  return Object.freeze({ check, pass, offendingSpans });
}

/** The failed report: every check fails, with no counts (the function never throws). */
function failedReport(): TelemetryRedactionReport {
  const checks = TELEMETRY_REDACTION_CHECKS.map((check) => checkResult(check, false, 0));
  return Object.freeze({ pass: false, checks: Object.freeze(checks), skippedCanaries: 0 });
}

/**
 * Run the redaction checks over an encoded OTLP/JSON payload (plan §3.2,
 * §3.8): the payload must parse strictly and canonically; no canary may
 * appear; every key must be allow-listed; every value must pass its rule and
 * the carrier shape rules (scope and event attributes empty, span names fixed,
 * `status.message` empty); nothing may be secret-shaped. The report carries
 * only check names, booleans and counts, and is frozen.
 */
export function redactionChecks(payloadBytes: Uint8Array, canaryValues: readonly string[]): TelemetryRedactionReport {
  try {
    const payload = decodePayload(payloadBytes);
    const parses = payload !== null;
    const canaries = checkCanaries(payload, canaryValues);
    const keys = checkKeyAllowList(payload);
    const values = checkValues(payload);
    const secrets = checkSecretShapes(payload);
    const checks = Object.freeze([
      checkResult('payload-parses', parses, 0),
      checkResult('canaries', parses && canaries.pass, canaries.offendingSpans),
      checkResult('key-allow-list', parses && keys.pass, keys.offendingSpans),
      checkResult('values', parses && values.pass, values.offendingSpans),
      checkResult('secret-shapes', parses && secrets.pass, secrets.offendingSpans),
    ]);
    const pass = checks.every((check) => check.pass);
    return Object.freeze({ pass, checks, skippedCanaries: canaries.skippedCanaries });
  } catch {
    return failedReport();
  }
}
