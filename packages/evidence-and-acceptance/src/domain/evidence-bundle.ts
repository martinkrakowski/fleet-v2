/**
 * FC12C: the pure per-PR evidence bundle assembler. It gathers
 * already-recorded per-pull-request facts (receipts, findings, gate output,
 * seats, the policy revision and the authority-events JSONL) into a fixed,
 * ordered list of `{ path, text }` entries ready to be archived, plus a
 * manifest naming each payload entry's path and UTF-8 byte length. No hashes
 * (a later unit adds them), no archive writing, no signing, no clock reads,
 * no I/O and no mutation of `input`.
 *
 * Pure domain: no `node:` or vendor import. Every function reading untrusted
 * input is total: it returns a typed refusal and never throws, never runs an
 * accessor (every read — including `length` and array indices — goes through
 * `Object.getOwnPropertyDescriptor`) and never mutates its arguments. A
 * throwing `Proxy` trap is caught and reads as `hostile-input`; a `Proxy`
 * that lies consistently in every trap is an accepted residual.
 *
 * Cost bounds: every size refusal (list length, string lengths, JSONL length)
 * is decided in O(1) from a length before the contents are scanned; each scan
 * is then linear over the input, whose total size every cap bounds (5,000
 * items per list, 1 MiB of JSONL). Validation is a single pass plus one
 * linear secret-pattern screen per string field and per serialised entry.
 */

import { checkJsonDuplicateKeys } from './json-duplicate-keys.js';
import { containsReviewSecretShape } from './review-answer-schema.js';

/** At most this many items in any one list of the bundle input. */
export const MAX_BUNDLE_LIST_ITEMS = 5000;
/** At most this many characters in an identifier-shaped string. */
export const MAX_ID_LENGTH = 128;
/** At most this many characters in a timestamp string. */
export const MAX_TIMESTAMP_LENGTH = 64;
/** At most this many characters in a gate command string. */
export const MAX_COMMAND_LENGTH = 1024;
/** At most this many characters in a gate output excerpt. */
export const MAX_GATE_OUTPUT_EXCERPT_LENGTH = 4096;
/** At most this many characters in the policy revision string. */
export const MAX_POLICY_REVISION_LENGTH = 128;
/** At most this many characters in the authority-events JSONL text. */
export const MAX_AUTHORITY_EVENTS_JSONL_LENGTH = 1048576;

/** Fixed entry paths of the assembled bundle, in assembly order. */
export const BUNDLE_ENTRY_PATH_MANIFEST = 'manifest.json';
export const BUNDLE_ENTRY_PATH_RECEIPTS = 'receipts.json';
export const BUNDLE_ENTRY_PATH_FINDINGS = 'findings.json';
export const BUNDLE_ENTRY_PATH_GATE_OUTPUT = 'gate-output.json';
export const BUNDLE_ENTRY_PATH_SEATS = 'seats.json';
export const BUNDLE_ENTRY_PATH_POLICY = 'policy.json';
export const BUNDLE_ENTRY_PATH_AUTHORITY_EVENTS = 'authority-events.json';

/** The fixed order of the assembled entries. */
export const BUNDLE_ENTRY_PATHS = [
  BUNDLE_ENTRY_PATH_MANIFEST,
  BUNDLE_ENTRY_PATH_RECEIPTS,
  BUNDLE_ENTRY_PATH_FINDINGS,
  BUNDLE_ENTRY_PATH_GATE_OUTPUT,
  BUNDLE_ENTRY_PATH_SEATS,
  BUNDLE_ENTRY_PATH_POLICY,
  BUNDLE_ENTRY_PATH_AUTHORITY_EVENTS,
] as const;

/** One already-recorded receipt fact. */
export interface EvidenceBundleReceipt {
  readonly receiptId: string;
  readonly kind: string;
  readonly atIso: string;
  readonly verdict: string;
}

/** One already-recorded finding fact. */
export interface EvidenceBundleFinding {
  readonly findingId: string;
  readonly severity: string;
  readonly disposition: string;
}

/** One already-recorded gate-command fact. */
export interface EvidenceBundleGateOutput {
  readonly command: string;
  readonly exitCode: number;
  readonly outputExcerpt: string;
}

/** One already-recorded seat fact. */
export interface EvidenceBundleSeat {
  readonly role: string;
  readonly seatId: string;
}

/** The per-PR facts of one bundle, exactly as recorded. */
export interface EvidenceBundleInput {
  readonly headSha: string;
  readonly organizationId: string | null;
  readonly receipts: readonly EvidenceBundleReceipt[];
  readonly findings: readonly EvidenceBundleFinding[];
  readonly gateOutput: readonly EvidenceBundleGateOutput[];
  readonly seats: readonly EvidenceBundleSeat[];
  readonly policyRevision: string;
  readonly authorityEventsJsonl: string;
}

/** One archive-ready entry: its fixed path and canonical JSON text. */
export interface EvidenceBundleEntry {
  readonly path: string;
  readonly text: string;
}

/** Every refusal the assembler can return, never echoing input values. */
export type EvidenceBundleRefusalReason =
  | 'invalid-input'
  | 'hostile-input'
  | 'list-too-large'
  | 'invalid-head-sha'
  | 'invalid-timestamp'
  | 'invalid-policy-revision'
  | 'excerpt-too-long'
  | 'string-too-long'
  | 'cross-organization-event'
  | 'secret-shaped-content';

export type EvidenceBundleResult =
  | { readonly ok: true; readonly entries: readonly EvidenceBundleEntry[]; readonly manifestText: string }
  | { readonly ok: false; readonly reason: EvidenceBundleRefusalReason; readonly path?: string };

const HEAD_SHA_PATTERN = /^[0-9a-f]{40}$/;
const AT_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const POLLUTING_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const TOP_LEVEL_KEYS = [
  'headSha',
  'organizationId',
  'receipts',
  'findings',
  'gateOutput',
  'seats',
  'policyRevision',
  'authorityEventsJsonl',
] as const;

const RECEIPT_KEYS = ['receiptId', 'kind', 'atIso', 'verdict'] as const;
const FINDING_KEYS = ['findingId', 'severity', 'disposition'] as const;
const GATE_OUTPUT_KEYS = ['command', 'exitCode', 'outputExcerpt'] as const;
const SEAT_KEYS = ['role', 'seatId'] as const;

/**
 * The exact own keys a serialised `AuthorityEvent` JSONL line carries, the
 * kinds it may name and the `actor` shape it must match — the same record
 * rules as `parseAuthorityEvent` in `@fleet/operator-coordination`, restated
 * here because no cross-context dependency is declared in that direction.
 */
const AUTHORITY_EVENT_KEYS = [
  'eventId',
  'kind',
  'actor',
  'organizationId',
  'atIso',
  'beforeRevision',
  'afterRevision',
] as const;

const AUTHORITY_EVENT_KINDS: ReadonlySet<string> = new Set([
  'dispatch',
  'stop',
  'grant',
  'merge',
  'policy-change',
  'key-change',
  'membership-change',
  'operator-access',
]);

const AUTHORITY_ACTOR_PATTERN = /^[A-Za-z0-9._@-]{1,128}$/;

const UNREADABLE = Symbol('unreadable');
const HOSTILE = Symbol('hostile');

/**
 * The receiver's own data property `key`, read without running any accessor.
 * An absent, accessor-shaped or trapped property is `UNREADABLE`; a throwing
 * trap is `HOSTILE`. Never throws. O(1).
 */
function ownValue(source: unknown, key: PropertyKey, requireEnumerable = false): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor === undefined) {
      return UNREADABLE;
    }
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      return HOSTILE;
    }
    if (requireEnumerable && !descriptor.enumerable) {
      return HOSTILE;
    }
    return descriptor.value;
  } catch {
    return HOSTILE;
  }
}

type RecordSnapshot =
  | { readonly kind: 'invalid' }
  | { readonly kind: 'hostile' }
  | { readonly kind: 'ok'; readonly value: Readonly<Record<string, unknown>> };

/**
 * Snapshot an untrusted value into a plain record of own enumerable data
 * properties only. `null`, `undefined`, a primitive, an array and a
 * non-plain prototype are `invalid`; a hostile shape (accessor,
 * non-enumerable, throwing trap) is `hostile`. Never throws. O(keys).
 */
function snapshotRecord(raw: unknown): RecordSnapshot {
  try {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { kind: 'invalid' };
    }
    const prototype = Object.getPrototypeOf(raw);
    if (prototype !== Object.prototype && prototype !== null) {
      return { kind: 'invalid' };
    }
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    // `Reflect.ownKeys` (not `Object.keys`) so a hidden non-enumerable or
    // symbol own property is still enumerated and refused instead of being
    // silently skipped; a throwing trap reads as hostile.
    for (const key of Reflect.ownKeys(raw as object)) {
      if (typeof key !== 'string') {
        // A symbol own property is an unexpected extra key.
        return { kind: 'invalid' };
      }
      const value = ownValue(raw, key, true);
      if (value === HOSTILE) {
        return { kind: 'hostile' };
      }
      if (value === UNREADABLE) {
        // `Reflect.ownKeys` enumerated it, so a missing descriptor is a lying
        // Proxy: treated as hostile rather than silently skipped.
        return { kind: 'hostile' };
      }
      if (POLLUTING_KEYS.has(key)) {
        // Refused, never renamed and carried into the snapshot: a record with
        // an own `__proto__`, `constructor` or `prototype` key is invalid
        // input, whatever its value.
        return { kind: 'invalid' };
      }
      out[key] = value;
    }
    return { kind: 'ok', value: out };
  } catch {
    return { kind: 'hostile' };
  }
}

type ListSnapshot =
  | { readonly kind: 'invalid' }
  | { readonly kind: 'hostile' }
  | { readonly kind: 'too-large' }
  | { readonly kind: 'ok'; readonly items: readonly Readonly<Record<string, unknown>>[] };

/**
 * Snapshot an untrusted list into plain records: a real array only (an
 * array-like object is not an array), whose own `length` is a safe-integer
 * data property within `MAX_BUNDLE_LIST_ITEMS`, with no sparse hole and no
 * accessor at any index. The length refusal runs before any element is read,
 * so an oversized list costs O(1). Never throws.
 */
function snapshotList(raw: unknown): ListSnapshot {
  try {
    if (!Array.isArray(raw)) {
      return { kind: 'invalid' };
    }
    // Even `length` is read through its own data-property descriptor.
    const length = ownValue(raw, 'length');
    if (length === HOSTILE) {
      return { kind: 'hostile' };
    }
    if (length === UNREADABLE || typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
      return { kind: 'invalid' };
    }
    if (length > MAX_BUNDLE_LIST_ITEMS) {
      return { kind: 'too-large' };
    }
    const items: Readonly<Record<string, unknown>>[] = [];
    for (let index = 0; index < length; index += 1) {
      // `requireEnumerable` so a hidden non-enumerable element is refused
      // rather than silently accepted.
      const item = ownValue(raw, index, true);
      if (item === HOSTILE) {
        return { kind: 'hostile' };
      }
      if (item === UNREADABLE) {
        // A missing index descriptor is a sparse hole.
        return { kind: 'invalid' };
      }
      const snapshot = snapshotRecord(item);
      if (snapshot.kind !== 'ok') {
        return { kind: snapshot.kind };
      }
      items.push(snapshot.value);
    }
    return { kind: 'ok', items };
  } catch {
    return { kind: 'hostile' };
  }
}

/** Exact own-key set equality over a snapshot: no missing key, no extra key. */
function hasExactKeys(
  record: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(record);
  return keys.length === expected.length && expected.every((key) => key in record);
}

/**
 * A bounded identifier-shaped string: a string of at most `maxLength`
 * characters. O(1) beyond the length read.
 */
function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength;
}

/**
 * A bounded required text: a non-empty string of at most `maxLength`
 * characters with no control character, mirroring the authority-event field
 * rules. O(length), every length cap bounds the scan.
 */
function isBoundedAuthorityText(value: unknown, maxLength: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return false;
    }
  }
  return true;
}

/** A bounded optional text: `null` or a bounded required text. */
function isBoundedOptionalAuthorityText(value: unknown, maxLength: number): boolean {
  return value === null || isBoundedAuthorityText(value, maxLength);
}

/**
 * One parsed JSONL line, already snapshotted to own enumerable data
 * properties, is a complete `AuthorityEvent`: exactly the seven keys, every
 * field present, well-formed and within its bound. O(1) per line beyond the
 * bounded field scans. Invalid shape reads as `invalid-input`, never a pass —
 * a bare `{"organizationId":"org-1"}` line carries no evidence.
 */
function isAuthorityEventLine(record: Readonly<Record<string, unknown>>): boolean {
  if (!hasExactKeys(record, AUTHORITY_EVENT_KEYS)) {
    return false;
  }
  if (!isBoundedAuthorityText(record.eventId, MAX_ID_LENGTH)) {
    return false;
  }
  if (typeof record.kind !== 'string' || !AUTHORITY_EVENT_KINDS.has(record.kind)) {
    return false;
  }
  if (typeof record.actor !== 'string' || !AUTHORITY_ACTOR_PATTERN.test(record.actor)) {
    return false;
  }
  if (!isBoundedOptionalAuthorityText(record.organizationId, MAX_ID_LENGTH)) {
    return false;
  }
  const atIso = record.atIso;
  if (
    !isBoundedAuthorityText(atIso, MAX_TIMESTAMP_LENGTH)
    || !AT_ISO_PATTERN.test(atIso)
    || !Number.isFinite(Date.parse(atIso))
  ) {
    return false;
  }
  if (!isBoundedOptionalAuthorityText(record.beforeRevision, MAX_ID_LENGTH)) {
    return false;
  }
  return isBoundedOptionalAuthorityText(record.afterRevision, MAX_ID_LENGTH);
}

/** The JSON text of `value` with no key-order dependence: a leaf only. */
function jsonLeaf(value: string | number): string {
  return JSON.stringify(value);
}

/**
 * One `{ path, text }` refusal naming the entry path and never the matched
 * value or any other part of the input.
 */
function secretRefusal(path: string): EvidenceBundleResult {
  return { ok: false, reason: 'secret-shaped-content', path };
}

/** Serialize one receipt item in fixed key order. */
function serializeReceipt(receipt: Readonly<Record<string, unknown>>): string {
  return `{${['receiptId', 'kind', 'atIso', 'verdict']
    .map((key) => `"${key}":${jsonLeaf(receipt[key] as string)}`)
    .join(',')}}`;
}

/** Serialize one finding item in fixed key order. */
function serializeFinding(finding: Readonly<Record<string, unknown>>): string {
  return `{${['findingId', 'severity', 'disposition']
    .map((key) => `"${key}":${jsonLeaf(finding[key] as string)}`)
    .join(',')}}`;
}

/** Serialize one gate-output item in fixed key order. */
function serializeGateOutput(gate: Readonly<Record<string, unknown>>): string {
  return `{${['command', 'exitCode', 'outputExcerpt']
    .map((key) => `"${key}":${jsonLeaf(gate[key] as string | number)}`)
    .join(',')}}`;
}

/** Serialize one seat item in fixed key order. */
function serializeSeat(seat: Readonly<Record<string, unknown>>): string {
  return `{${['role', 'seatId']
    .map((key) => `"${key}":${jsonLeaf(seat[key] as string)}`)
    .join(',')}}`;
}

/**
 * Assemble the per-PR evidence bundle. Never throws, never mutates `input`,
 * never runs an accessor and never echoes an input value: every failure is a
 * typed refusal naming at most a fixed entry path.
 */
export function assembleEvidenceBundle(input: unknown): EvidenceBundleResult {
  try {
    const root = snapshotRecord(input);
    if (root.kind !== 'ok') {
      return { ok: false, reason: root.kind === 'hostile' ? 'hostile-input' : 'invalid-input' };
    }
    const record = root.value;
    if (!hasExactKeys(record, TOP_LEVEL_KEYS)) {
      return { ok: false, reason: 'invalid-input' };
    }

    const headSha = record.headSha;
    if (typeof headSha !== 'string' || !HEAD_SHA_PATTERN.test(headSha)) {
      return { ok: false, reason: 'invalid-head-sha' };
    }

    const organizationId = record.organizationId;
    if (organizationId !== null) {
      if (!isBoundedString(organizationId, MAX_ID_LENGTH) || organizationId.length === 0) {
        return { ok: false, reason: 'string-too-long' };
      }
    }

    const policyRevision = record.policyRevision;
    if (
      typeof policyRevision !== 'string'
      || policyRevision.length === 0
      || policyRevision.length > MAX_POLICY_REVISION_LENGTH
    ) {
      return { ok: false, reason: 'invalid-policy-revision' };
    }

    const authorityEventsJsonl = record.authorityEventsJsonl;
    if (typeof authorityEventsJsonl !== 'string'
      || authorityEventsJsonl.length > MAX_AUTHORITY_EVENTS_JSONL_LENGTH) {
      return { ok: false, reason: 'string-too-long' };
    }

    const receipts = snapshotList(record.receipts);
    if (receipts.kind !== 'ok') {
      return receipts.kind === 'too-large'
        ? { ok: false, reason: 'list-too-large' }
        : { ok: false, reason: receipts.kind === 'hostile' ? 'hostile-input' : 'invalid-input' };
    }
    const findings = snapshotList(record.findings);
    if (findings.kind !== 'ok') {
      return findings.kind === 'too-large'
        ? { ok: false, reason: 'list-too-large' }
        : { ok: false, reason: findings.kind === 'hostile' ? 'hostile-input' : 'invalid-input' };
    }
    const gateOutput = snapshotList(record.gateOutput);
    if (gateOutput.kind !== 'ok') {
      return gateOutput.kind === 'too-large'
        ? { ok: false, reason: 'list-too-large' }
        : { ok: false, reason: gateOutput.kind === 'hostile' ? 'hostile-input' : 'invalid-input' };
    }
    const seats = snapshotList(record.seats);
    if (seats.kind !== 'ok') {
      return seats.kind === 'too-large'
        ? { ok: false, reason: 'list-too-large' }
        : { ok: false, reason: seats.kind === 'hostile' ? 'hostile-input' : 'invalid-input' };
    }

    for (const item of receipts.items) {
      if (!hasExactKeys(item, RECEIPT_KEYS)) {
        return { ok: false, reason: 'invalid-input' };
      }
      for (const key of ['receiptId', 'kind', 'verdict'] as const) {
        if (!isBoundedString(item[key], MAX_ID_LENGTH)) {
          return { ok: false, reason: 'string-too-long' };
        }
      }
      const atIso = item.atIso;
      if (typeof atIso !== 'string' || atIso.length > MAX_TIMESTAMP_LENGTH
        || !AT_ISO_PATTERN.test(atIso) || !Number.isFinite(Date.parse(atIso))) {
        return { ok: false, reason: 'invalid-timestamp' };
      }
    }
    for (const item of findings.items) {
      if (!hasExactKeys(item, FINDING_KEYS)) {
        return { ok: false, reason: 'invalid-input' };
      }
      for (const key of FINDING_KEYS) {
        if (!isBoundedString(item[key], MAX_ID_LENGTH)) {
          return { ok: false, reason: 'string-too-long' };
        }
      }
    }
    for (const item of gateOutput.items) {
      if (!hasExactKeys(item, GATE_OUTPUT_KEYS)) {
        return { ok: false, reason: 'invalid-input' };
      }
      if (!isBoundedString(item.command, MAX_COMMAND_LENGTH)) {
        return { ok: false, reason: 'string-too-long' };
      }
      if (typeof item.exitCode !== 'number' || !Number.isSafeInteger(item.exitCode)) {
        return { ok: false, reason: 'invalid-input' };
      }
      if (typeof item.outputExcerpt !== 'string'
        || item.outputExcerpt.length > MAX_GATE_OUTPUT_EXCERPT_LENGTH) {
        return { ok: false, reason: 'excerpt-too-long' };
      }
    }
    for (const item of seats.items) {
      if (!hasExactKeys(item, SEAT_KEYS)) {
        return { ok: false, reason: 'invalid-input' };
      }
      for (const key of SEAT_KEYS) {
        if (!isBoundedString(item[key], MAX_ID_LENGTH)) {
          return { ok: false, reason: 'string-too-long' };
        }
      }
    }

    // The authority-events JSONL: every non-empty line must be a complete
    // `AuthorityEvent` object with unique keys, whose `organizationId`
    // matches the bundle's.
    for (const line of authorityEventsJsonl.split('\n')) {
      if (line === '') {
        continue;
      }
      const duplicateKeyCheck = checkJsonDuplicateKeys(line, MAX_AUTHORITY_EVENTS_JSONL_LENGTH);
      if (!duplicateKeyCheck.ok) {
        // Refused before `JSON.parse`, so a duplicate `organizationId` key
        // cannot bypass the organisation check by last-write-wins parsing.
        return { ok: false, reason: 'invalid-input' };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return { ok: false, reason: 'invalid-input' };
      }
      const lineSnapshot = snapshotRecord(parsed);
      if (lineSnapshot.kind !== 'ok') {
        return { ok: false, reason: 'invalid-input' };
      }
      // A line that is not a complete `AuthorityEvent` is malformed data,
      // refused even when its `organizationId` matches: it must never be
      // archived as audit evidence.
      if (!isAuthorityEventLine(lineSnapshot.value)) {
        return { ok: false, reason: 'invalid-input' };
      }
      const lineOrgId = lineSnapshot.value.organizationId;
      if (organizationId !== null) {
        if (lineOrgId !== organizationId) {
          return { ok: false, reason: 'cross-organization-event' };
        }
      } else if (lineOrgId !== undefined && lineOrgId !== null) {
        return { ok: false, reason: 'cross-organization-event' };
      }
    }

    // Secret screen over every raw string field, before serialisation. Only
    // the corresponding entry path is named, never the matched value.
    const rawFieldPaths: readonly (readonly [unknown, string])[] = [
      [headSha, BUNDLE_ENTRY_PATH_RECEIPTS],
      [organizationId, BUNDLE_ENTRY_PATH_AUTHORITY_EVENTS],
      [policyRevision, BUNDLE_ENTRY_PATH_POLICY],
      [authorityEventsJsonl, BUNDLE_ENTRY_PATH_AUTHORITY_EVENTS],
      ...receipts.items.flatMap((item) => RECEIPT_KEYS.map((key) => [item[key], BUNDLE_ENTRY_PATH_RECEIPTS] as const)),
      ...findings.items.flatMap((item) => FINDING_KEYS.map((key) => [item[key], BUNDLE_ENTRY_PATH_FINDINGS] as const)),
      ...gateOutput.items.flatMap((item) => ['command', 'outputExcerpt'].map((key) => [item[key], BUNDLE_ENTRY_PATH_GATE_OUTPUT] as const)),
      ...seats.items.flatMap((item) => SEAT_KEYS.map((key) => [item[key], BUNDLE_ENTRY_PATH_SEATS] as const)),
    ];
    for (const [value, path] of rawFieldPaths) {
      if (typeof value === 'string' && containsReviewSecretShape(value)) {
        return secretRefusal(path);
      }
    }

    // Canonical serialisation: fixed key order, never input insertion order.
    const encoder = new TextEncoder();
    const payloadEntries: EvidenceBundleEntry[] = [
      {
        path: BUNDLE_ENTRY_PATH_RECEIPTS,
        text: `{"headSha":${jsonLeaf(headSha)},"receipts":[${receipts.items.map(serializeReceipt).join(',')}]}\n`,
      },
      {
        path: BUNDLE_ENTRY_PATH_FINDINGS,
        text: `{"headSha":${jsonLeaf(headSha)},"findings":[${findings.items.map(serializeFinding).join(',')}]}\n`,
      },
      {
        path: BUNDLE_ENTRY_PATH_GATE_OUTPUT,
        text: `{"headSha":${jsonLeaf(headSha)},"gateOutput":[${gateOutput.items.map(serializeGateOutput).join(',')}]}\n`,
      },
      {
        path: BUNDLE_ENTRY_PATH_SEATS,
        text: `{"headSha":${jsonLeaf(headSha)},"seats":[${seats.items.map(serializeSeat).join(',')}]}\n`,
      },
      {
        path: BUNDLE_ENTRY_PATH_POLICY,
        text: `{"headSha":${jsonLeaf(headSha)},"policyRevision":${jsonLeaf(policyRevision)}}\n`,
      },
      {
        path: BUNDLE_ENTRY_PATH_AUTHORITY_EVENTS,
        text: `{"headSha":${jsonLeaf(headSha)},"authorityEventsJsonl":${jsonLeaf(authorityEventsJsonl)}}\n`,
      },
    ];

    const manifestText = `{"headSha":${jsonLeaf(headSha)},"entries":[${payloadEntries
      .map((entry) => `{"path":${jsonLeaf(entry.path)},"byteLength":${encoder.encode(entry.text).byteLength}}`)
      .join(',')}]}\n`;

    const entries: EvidenceBundleEntry[] = [
      { path: BUNDLE_ENTRY_PATH_MANIFEST, text: manifestText },
      ...payloadEntries,
    ];

    // Secret screen across every serialised entry, manifest included.
    for (const entry of entries) {
      if (containsReviewSecretShape(entry.text)) {
        return secretRefusal(entry.path);
      }
    }

    return { ok: true, entries, manifestText };
  } catch {
    // A hostile trap escaping every inner guard reads as a typed refusal,
    // never an exception and never a pass.
    return { ok: false, reason: 'hostile-input' };
  }
}
