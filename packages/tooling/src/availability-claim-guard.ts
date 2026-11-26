/**
 * Availability-claim guard (plan FC-17.10, guard only): a pure check that
 * flags a percentage availability figure in a document's text when no drill
 * record ID backs it at a token boundary.
 *
 * Like every tooling guard this module is pure: it never touches the
 * filesystem, a subprocess, the network, a clock or randomness, and it never
 * logs. Every untrusted input is read exactly once through
 * `snapshotPlainData` from `@fleet/shared` with the caller-supplied
 * positional `isProxy` detector, and every element is validated against a
 * closed schema in O(own keys), one enumeration. A rejected input value is
 * never echoed into a refusal.
 */

import {
  snapshotPlainData,
  type IsProxy,
  type PlainDataLimits,
} from '@fleet/shared';

/** One document whose text may claim an availability figure. */
export interface AvailabilityDoc {
  readonly id: string;
  readonly text: string;
}

/** One drill record whose ID may back a document's availability claim. */
export interface AvailabilityDrillRecord {
  readonly id: string;
}

/** One unbacked availability figure found in one document. */
export interface AvailabilityClaimFinding {
  readonly docId: string;
  readonly figure: string;
}

/** Why the guard refused to scan. */
export type AvailabilityClaimRefusalReason =
  | 'snapshot-refused'
  | 'not-array'
  | 'malformed-record'
  | 'prototype-polluting-key'
  | 'unknown-key';

/** The guard's outcome: a pass, a list of findings, or a typed refusal. */
export type AvailabilityClaimGuardResult =
  | { readonly status: 'pass' }
  | { readonly status: 'flagged'; readonly findings: readonly AvailabilityClaimFinding[] }
  | {
      readonly status: 'refused';
      readonly reason: AvailabilityClaimRefusalReason;
      readonly target: 'docs' | 'drillRecords';
    };

/**
 * Explicit stated limits for the `docs` snapshot. `maxStringLength` is
 * raised above the 16_384 default so ordinary documents are accepted while
 * staying bounded; `maxNodes >= maxArrayLength + 8` keeps the node budget
 * above the array budget. `snapshotPlainData` checks `length` before
 * `Reflect.ownKeys`.
 */
const DOC_SNAPSHOT_LIMITS: PlainDataLimits = Object.freeze({
  maxDepth: 4,
  maxKeys: 8,
  maxArrayLength: 1024,
  maxNodes: 4096,
  maxStringLength: 262_144,
});

/** Explicit stated limits for the `drillRecords` snapshot. */
const DRILL_SNAPSHOT_LIMITS: PlainDataLimits = Object.freeze({
  maxDepth: 4,
  maxKeys: 8,
  maxArrayLength: 1024,
  maxNodes: 4096,
  maxStringLength: 16_384,
});

/** The closed key set of a document record. */
const DOC_KEYS: readonly string[] = ['id', 'text'];

/** The closed key set of a drill record. */
const DRILL_KEYS: readonly string[] = ['id'];

/** Keys that must never appear as own data keys on a record. */
const POLLUTING_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

/** A drill ID: 3-64 token characters, starting with an alphanumeric. */
const DRILL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;

/**
 * Percentage figures, scanned in linear time. The lookbehind keeps a figure
 * from starting mid-number (`1100.5%` matches once, at `100.5%`-free
 * boundaries as written); the whole match is the reported figure.
 */
const PERCENTAGE_PATTERN = /(?<!\d)\d{1,3}(?:\.\d+)?%/g;

/**
 * ID-shaped tokens of document text, scanned in linear time. Matching a
 * drill ID against this set is a token-boundary match: `'drill-1'` never
 * backs text that only contains `'drill-10'`.
 */
const TOKEN_PATTERN = /[A-Za-z0-9][A-Za-z0-9._-]*/g;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

/**
 * Validate one snapshot element against its closed schema in O(own keys),
 * one enumeration. Returns the element cast to its record type, or the
 * refusal reason for the failure path.
 */
function validateElement(
  element: unknown,
  schemaKeys: readonly string[],
  requiredKeys: readonly ('id' | 'text')[],
): { ok: true; record: Record<string, unknown> } | { ok: false; reason: AvailabilityClaimRefusalReason } {
  if (!isPlainRecord(element)) {
    return { ok: false, reason: 'malformed-record' };
  }
  const keys = Reflect.ownKeys(element);
  for (const key of keys) {
    if (typeof key !== 'string') {
      return { ok: false, reason: 'unknown-key' };
    }
    if (POLLUTING_KEYS.includes(key)) {
      return { ok: false, reason: 'prototype-polluting-key' };
    }
    if (!schemaKeys.includes(key)) {
      return { ok: false, reason: 'unknown-key' };
    }
  }
  for (const required of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(element, required)) {
      return { ok: false, reason: 'malformed-record' };
    }
  }
  return { ok: true, record: element };
}

/**
 * Scan documents for percentage availability figures and flag each figure
 * in a document whose text no drill record ID backs at a token boundary.
 *
 * Both inputs are untrusted: each is read exactly once through
 * `snapshotPlainData` with the caller-supplied positional `isProxy`
 * detector. Every failure path returns a typed refusal that never echoes
 * the rejected value; a refusal is never a pass.
 */
export function findUnbackedAvailabilityClaims(
  docs: unknown,
  drillRecords: unknown,
  isProxy: IsProxy,
): AvailabilityClaimGuardResult {
  const docsSnapshot = snapshotPlainData(docs, isProxy, DOC_SNAPSHOT_LIMITS);
  if (!docsSnapshot.ok) {
    return { status: 'refused', reason: 'snapshot-refused', target: 'docs' };
  }
  if (!Array.isArray(docsSnapshot.value)) {
    return { status: 'refused', reason: 'not-array', target: 'docs' };
  }

  const drillsSnapshot = snapshotPlainData(
    drillRecords,
    isProxy,
    DRILL_SNAPSHOT_LIMITS,
  );
  if (!drillsSnapshot.ok) {
    return { status: 'refused', reason: 'snapshot-refused', target: 'drillRecords' };
  }
  if (!Array.isArray(drillsSnapshot.value)) {
    return { status: 'refused', reason: 'not-array', target: 'drillRecords' };
  }

  const docElements = docsSnapshot.value as readonly unknown[];
  const validatedDocs: AvailabilityDoc[] = [];
  for (const element of docElements) {
    const checked = validateElement(element, DOC_KEYS, ['id', 'text']);
    if (!checked.ok) {
      return { status: 'refused', reason: checked.reason, target: 'docs' };
    }
    const { record } = checked;
    const { id, text } = record;
    if (typeof id !== 'string' || id === '' || typeof text !== 'string') {
      return { status: 'refused', reason: 'malformed-record', target: 'docs' };
    }
    validatedDocs.push({ id, text });
  }

  const drillElements = drillsSnapshot.value as readonly unknown[];
  const drillIds: string[] = [];
  for (const element of drillElements) {
    const checked = validateElement(element, DRILL_KEYS, ['id']);
    if (!checked.ok) {
      return { status: 'refused', reason: checked.reason, target: 'drillRecords' };
    }
    const { id } = checked.record;
    if (typeof id !== 'string' || !DRILL_ID_PATTERN.test(id)) {
      return { status: 'refused', reason: 'malformed-record', target: 'drillRecords' };
    }
    drillIds.push(id);
  }

  const findings: AvailabilityClaimFinding[] = [];
  for (const doc of validatedDocs) {
    const figures = doc.text.match(PERCENTAGE_PATTERN);
    if (figures === null || figures.length === 0) {
      continue;
    }
    const tokens = new Set<string>();
    for (const match of doc.text.matchAll(TOKEN_PATTERN)) {
      tokens.add(match[0]);
    }
    const backed = drillIds.some((id) => tokens.has(id));
    if (!backed) {
      for (const figure of figures) {
        findings.push({ docId: doc.id, figure });
      }
    }
  }

  if (findings.length > 0) {
    return { status: 'flagged', findings };
  }
  return { status: 'pass' };
}
