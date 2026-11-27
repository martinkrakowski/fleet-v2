/**
 * Availability-claim guard (plan FC-17.10): a pure check that flags any
 * percentage availability figure (such as `99.9%`) in document text when no
 * matching drill record ID backs it at a token boundary.
 *
 * Pure domain/tooling code: no filesystem, subprocess, network, clock or
 * randomness. Every untrusted input is read once through
 * `snapshotPlainData` with the caller-supplied `isProxy` detector, every
 * record schema is closed, and every failure path is a typed refusal that
 * never echoes the rejected value.
 */

import { snapshotPlainData } from '@fleet/shared';
import type { IsProxy, PlainDataLimits } from '@fleet/shared';

/** Bounds `doc.id` independently of `doc.text` so a huge ID cannot be duplicated across findings. */
const MAX_DOC_ID_LENGTH = 256;

/** Bounds total returned findings to prevent memory amplification. */
const MAX_FINDINGS = 1024;

/**
 * Raises `maxStringLength` above the shared default so ordinary documents are
 * accepted while staying bounded; `maxNodes >= maxArrayLength + 8`.
 */
const DOC_SNAPSHOT_LIMITS: PlainDataLimits = Object.freeze({
  maxDepth: 4,
  maxKeys: 8,
  maxArrayLength: 1024,
  maxNodes: 4096,
  maxStringLength: 262_144,
});

const DRILL_SNAPSHOT_LIMITS: PlainDataLimits = Object.freeze({
  maxDepth: 4,
  maxKeys: 8,
  maxArrayLength: 1024,
  maxNodes: 4096,
  maxStringLength: 16_384,
});

/** Drill record IDs must be 3-64 characters of token-safe ID shape. */
const DRILL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;

/**
 * Percentage figures such as `99.9%`: at most three integer digits plus an
 * optional fractional part of unbounded length (so a 19-fraction-digit figure
 * like `99.99999999999999999%` is still matched), not preceded by another
 * digit (linear time, no dynamic construction).
 */
const PERCENTAGE_PATTERN = /(?<!\d)\d{1,3}(?:\.\d+)?%/g;

/**
 * ID-shaped tokens in text; a drill ID backs a document only when it appears
 * here at a token boundary (never a substring of a longer token).
 */
const TOKEN_PATTERN = /[A-Za-z0-9][A-Za-z0-9._-]*/g;

/** A document whose text may claim an availability figure. */
export interface AvailabilityDoc {
  readonly id: string;
  readonly text: string;
}

/** A drill record that can back an availability claim by its ID. */
export interface AvailabilityDrillRecord {
  readonly id: string;
}

/** One unbacked availability claim: a distinct figure in one document. */
export interface AvailabilityClaimFinding {
  readonly docId: string;
  readonly figure: string;
}

/** Why the guard refused to answer. */
export type AvailabilityClaimRefusalReason =
  | 'snapshot-refused'
  | 'not-array'
  | 'malformed-record'
  | 'prototype-polluting-key'
  | 'unknown-key'
  | 'too-many-findings';

/** The guard's outcome: a pass, a list of findings, or a typed refusal. */
export type AvailabilityClaimGuardResult =
  | { readonly status: 'pass' }
  | { readonly status: 'flagged'; readonly findings: readonly AvailabilityClaimFinding[] }
  | {
      readonly status: 'refused';
      readonly reason: AvailabilityClaimRefusalReason;
      readonly target: 'docs' | 'drillRecords';
    };

const PROTOTYPE_POLLUTING_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

const DOC_KEYS: ReadonlySet<string> = new Set(['id', 'text']);
const DRILL_KEYS: ReadonlySet<string> = new Set(['id']);

interface ElementCheck {
  ok: true;
  record: Record<string, unknown>;
}
interface ElementRefusal {
  ok: false;
  reason: 'malformed-record' | 'prototype-polluting-key' | 'unknown-key';
}

/**
 * Validate one element of a snapshot array in O(own keys), one enumeration:
 * a non-null non-array plain object, no prototype-polluting own key, no key
 * outside the closed schema, no missing required key.
 */
function checkElement(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  requiredKeys: readonly string[],
): ElementCheck | ElementRefusal {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'malformed-record' };
  }
  const record = value as Record<string, unknown>;
  let seen = 0;
  for (const key of Object.keys(record)) {
    if (PROTOTYPE_POLLUTING_KEYS.has(key)) {
      return { ok: false, reason: 'prototype-polluting-key' };
    }
    if (!allowedKeys.has(key)) {
      return { ok: false, reason: 'unknown-key' };
    }
    seen += 1;
  }
  for (const required of requiredKeys) {
    if (seen < requiredKeys.length || !(required in record)) {
      return { ok: false, reason: 'malformed-record' };
    }
  }
  return { ok: true, record };
}

/**
 * Flag percentage availability figures in `docs` that no drill record ID
 * backs at a token boundary. `isProxy` is the required positional detector
 * every snapshot read uses; there is no default.
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

  const drillsSnapshot = snapshotPlainData(drillRecords, isProxy, DRILL_SNAPSHOT_LIMITS);
  if (!drillsSnapshot.ok) {
    return { status: 'refused', reason: 'snapshot-refused', target: 'drillRecords' };
  }
  if (!Array.isArray(drillsSnapshot.value)) {
    return { status: 'refused', reason: 'not-array', target: 'drillRecords' };
  }

  const drillIds = new Set<string>();
  for (const element of drillsSnapshot.value) {
    const check = checkElement(element, DRILL_KEYS, ['id']);
    if (!check.ok) {
      return { status: 'refused', reason: check.reason, target: 'drillRecords' };
    }
    const id = check.record['id'];
    if (typeof id !== 'string' || !DRILL_ID_PATTERN.test(id)) {
      return { status: 'refused', reason: 'malformed-record', target: 'drillRecords' };
    }
    drillIds.add(id);
  }

  const findings: AvailabilityClaimFinding[] = [];
  for (const element of docsSnapshot.value) {
    const check = checkElement(element, DOC_KEYS, ['id', 'text']);
    if (!check.ok) {
      return { status: 'refused', reason: check.reason, target: 'docs' };
    }
    const id = check.record['id'];
    const text = check.record['text'];
    if (typeof id !== 'string' || id.length < 1 || id.length > MAX_DOC_ID_LENGTH) {
      return { status: 'refused', reason: 'malformed-record', target: 'docs' };
    }
    if (typeof text !== 'string') {
      return { status: 'refused', reason: 'malformed-record', target: 'docs' };
    }

    const figures = new Set<string>();
    for (const match of text.matchAll(PERCENTAGE_PATTERN)) {
      figures.add(match[0]);
    }
    if (figures.size === 0) {
      continue;
    }

    const textTokens = new Set<string>();
    for (const match of text.matchAll(TOKEN_PATTERN)) {
      textTokens.add(match[0]);
    }
    let backed = false;
    for (const drillId of drillIds) {
      if (textTokens.has(drillId)) {
        backed = true;
        break;
      }
    }
    if (backed) {
      continue;
    }

    for (const figure of figures) {
      if (findings.length >= MAX_FINDINGS) {
        return { status: 'refused', reason: 'too-many-findings', target: 'docs' };
      }
      findings.push({ docId: id, figure });
    }
  }

  if (findings.length > 0) {
    return { status: 'flagged', findings };
  }
  return { status: 'pass' };
}
