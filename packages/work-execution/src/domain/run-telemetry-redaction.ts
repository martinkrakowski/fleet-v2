/**
 * The redaction checks of run telemetry (plan §3.2 "Redaction tests", enforced
 * over an encoded OTLP/JSON payload; plan §3.8 backfill `--dry-run --canary`).
 * One pure function, `redactionChecks(payloadBytes, canaryValues)`, the CLI
 * runs on real records: it prints only pass or fail per check and a count of
 * offending spans — never a key, value, canary or matched text. The report is
 * frozen and the function never throws: any internal error fails every check.
 * Pure: no `node:*`, no clock, no I/O, and nothing secret is read
 * (`TextDecoder` is a global).
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

/** One walked resource or span: its decoded attribute map. */
interface DecodedEntry {
  readonly kind: 'resource' | 'span';
  readonly attributes: ReadonlyMap<string, DecodedAttributeValue>;
  /** False when any attribute value of the entry could not be decoded. */
  readonly decoded: boolean;
}

interface DecodedPayload {
  readonly text: string;
  readonly entries: readonly DecodedEntry[];
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
  if (!isPlainObject(value)) {
    return null;
  }
  if (Object.keys(value).length !== 1 || !hasOwnData(value, 'values')) {
    return null;
  }
  const values = ownData(value, 'values');
  if (!Array.isArray(values)) {
    return null;
  }
  const decoded: string[] = [];
  for (const element of values) {
    if (!isPlainObject(element)) {
      return null;
    }
    if (Object.keys(element).length !== 1 || !hasOwnData(element, 'stringValue')) {
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
  if (!isPlainObject(value)) {
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
  if (!isPlainObject(entry)) {
    return null;
  }
  if (Object.keys(entry).length !== 2 || !hasOwnData(entry, 'key') || !hasOwnData(entry, 'value')) {
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

/** An `attributes[]` list into a map; `decoded` is false when any value is unsupported. */
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
    attributes.set(attribute.key, attribute.value);
  }
  return { attributes, decoded };
}

/** One span of the payload, or null when the shape is wrong. */
function readSpan(span: unknown): DecodedEntry | null {
  if (!isPlainObject(span) || !hasOwnData(span, 'attributes')) {
    return null;
  }
  const read = readAttributes(ownData(span, 'attributes'));
  return { kind: 'span', attributes: read.attributes, decoded: read.decoded };
}

/** Appends every span of one `scopeSpans` element; false on a shape failure. */
function readScopeSpans(scopeSpans: unknown, entries: DecodedEntry[]): boolean {
  if (!Array.isArray(scopeSpans)) {
    return false;
  }
  for (const scopeSpan of scopeSpans) {
    if (!isPlainObject(scopeSpan) || !hasOwnData(scopeSpan, 'spans')) {
      return false;
    }
    const spans = ownData(scopeSpan, 'spans');
    if (!Array.isArray(spans)) {
      return false;
    }
    for (const span of spans) {
      const entry = readSpan(span);
      if (entry === null) {
        return false;
      }
      entries.push(entry);
    }
  }
  return true;
}

/** One `resourceSpans[]` element's resource entry; false on a shape failure. */
function readResource(resource: unknown, entries: DecodedEntry[]): boolean {
  if (!isPlainObject(resource) || !hasOwnData(resource, 'attributes')) {
    return false;
  }
  const read = readAttributes(ownData(resource, 'attributes'));
  entries.push({ kind: 'resource', attributes: read.attributes, decoded: read.decoded });
  return true;
}

/** Walks `resourceSpans[]` into entries, or null on any shape failure. */
function readResourceSpans(resourceSpans: unknown): DecodedEntry[] | null {
  if (!Array.isArray(resourceSpans)) {
    return null;
  }
  const entries: DecodedEntry[] = [];
  for (const element of resourceSpans) {
    if (!isPlainObject(element) || !hasOwnData(element, 'resource') || !hasOwnData(element, 'scopeSpans')) {
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

/** Decodes the UTF-8 OTLP/JSON payload, or null when it does not parse. */
function decodePayload(payloadBytes: Uint8Array): DecodedPayload | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes);
    const parsed: unknown = JSON.parse(text);
    if (!isPlainObject(parsed) || !hasOwnData(parsed, 'resourceSpans')) {
      return null;
    }
    const entries = readResourceSpans(ownData(parsed, 'resourceSpans'));
    if (entries === null) {
      return null;
    }
    return { text, entries };
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

/** The `canaries` check (plan §3.2 test 1): no canary in the payload text. */
function checkCanaries(
  payload: DecodedPayload | null,
  canaryValues: readonly string[],
): { readonly pass: boolean; readonly offendingSpans: number; readonly skippedCanaries: number } {
  if (payload === null) {
    return { pass: false, offendingSpans: 0, skippedCanaries: 0 };
  }
  let pass = true;
  let offendingSpans = 0;
  let skippedCanaries = 0;
  for (const canary of canaryValues) {
    const trimmed = typeof canary === 'string' ? canary.trim() : '';
    // Blank or very short values match by accident, so they are skipped (§3.8).
    if (trimmed.length === 0 || trimmed.length < 4) {
      skippedCanaries += 1;
      continue;
    }
    if (!payload.text.includes(trimmed)) {
      continue;
    }
    pass = false;
    for (const entry of payload.entries) {
      if (attributeValuesContain(entry, trimmed)) {
        offendingSpans += 1;
      }
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
    for (const key of entry.attributes.keys()) {
      if (entry.kind === 'resource') {
        if (!(RUN_TELEMETRY_RESOURCE_KEYS as readonly string[]).includes(key)) {
          entryPass = false;
        }
        continue;
      }
      if (isNeverSentTelemetryKey(key) || !Object.hasOwn(RUN_TELEMETRY_ATTRIBUTES, key)) {
        entryPass = false;
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

/** Every span attribute value passes its rule (plan §3.2 test 4). */
function checkSpanValues(entry: DecodedEntry): boolean {
  if (!entry.decoded) {
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

/** The resource value rules (plan §3.2 "Resource attributes"). */
function checkResourceValues(entry: DecodedEntry): boolean {
  if (!entry.decoded) {
    return false;
  }
  for (const [key, value] of entry.attributes) {
    if (key === 'service.name') {
      if (value !== TELEMETRY_SERVICE_NAME) {
        return false;
      }
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
  return true;
}

/** The `values` check over every walked entry. */
function checkValues(payload: DecodedPayload | null): { readonly pass: boolean; readonly offendingSpans: number } {
  if (payload === null) {
    return { pass: false, offendingSpans: 0 };
  }
  let pass = true;
  let offendingSpans = 0;
  for (const entry of payload.entries) {
    const entryPass = entry.kind === 'resource' ? checkResourceValues(entry) : checkSpanValues(entry);
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

/** True when any attribute value of the entry is secret-shaped. */
function entryHasSecretShape(entry: DecodedEntry): boolean {
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
  // The payload text as a whole is checked too: a shape anywhere fails.
  const pass = !textHasSecretShape(payload.text);
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
 * §3.8): the payload must parse; no canary may appear; every key must be
 * allow-listed; every value must pass its rule; nothing may be secret-shaped.
 * The report carries only check names, booleans and counts, and is frozen.
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
