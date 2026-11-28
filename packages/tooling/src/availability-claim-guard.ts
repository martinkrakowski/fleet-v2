/**
 * Availability-claim guard (plan FC-17.10, guard only, no drill).
 *
 * Flags percentage availability figures (such as `99.9%`) in document text
 * unless a drill record ID appears at a token boundary in the same clause and
 * that drill record substantiates that exact figure.
 *
 * Pure module: no filesystem, subprocess, network, clock, randomness or
 * `console` use. Every untrusted input is read once through
 * `snapshotPlainData` with the caller-supplied positional `isProxy` detector,
 * and every failure is a typed refusal that never echoes a rejected value.
 */

import { snapshotPlainData, type IsProxy, type PlainDataLimits } from '@fleet/shared';

/** Bounds `doc.id` independently of `doc.text`. */
const MAX_DOC_ID_LENGTH = 256;

/** Bounds the total number of returned findings. */
const MAX_FINDINGS = 1024;

/**
 * Ordinary documents stay bounded: a raised `maxStringLength` accepts them
 * while `maxNodes >= maxArrayLength + 8`. The `length` of an array is checked
 * before `Reflect.ownKeys`, so an enormous array is refused cheaply.
 */
const DOC_SNAPSHOT_LIMITS: PlainDataLimits = {
  maxDepth: 4,
  maxKeys: 8,
  maxArrayLength: 1024,
  maxNodes: 4096,
  maxStringLength: 262_144,
};

const DRILL_SNAPSHOT_LIMITS: PlainDataLimits = {
  maxDepth: 4,
  maxKeys: 8,
  maxArrayLength: 1024,
  maxNodes: 4096,
  maxStringLength: 16_384,
};

export interface AvailabilityDoc {
  readonly id: string;
  readonly text: string;
}

export interface AvailabilityDrillRecord {
  readonly id: string;
  readonly backedFigures: readonly string[];
}

export interface AvailabilityClaimFinding {
  readonly docId: string;
  readonly figure: string;
}

export type AvailabilityClaimRefusalReason =
  | 'snapshot-refused'
  | 'not-array'
  | 'malformed-record'
  | 'prototype-polluting-key'
  | 'unknown-key'
  | 'too-many-findings';

export type AvailabilityClaimGuardResult =
  | { readonly status: 'pass' }
  | { readonly status: 'flagged'; readonly findings: readonly AvailabilityClaimFinding[] }
  | {
      readonly status: 'refused';
      readonly reason: AvailabilityClaimRefusalReason;
      readonly target: 'docs' | 'drillRecords';
    };

/** Valid drill record ID: 3-64 characters of token-safe text. */
const DRILL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;

/** Valid backed figure: `99.9%`-shaped, one to three integer digits. */
const BACKED_FIGURE_PATTERN = /^\d{1,3}(?:\.\d{1,16})?%$/;

/**
 * Clause separator. `;`, newlines, `!` and `?` always split; a `.` splits only
 * at a sentence end, so decimal points inside `99.9%` and dots inside
 * `drill.1` never split a clause. Linear-time on the document text.
 */
const CLAUSE_SEPARATOR = /(?:[;\r\n!?]+|\.(?=\s|$))/;

/** ID-shaped token, greedily spanning letters, digits, dots, underscores and hyphens. */
const ID_TOKEN_PATTERN = /[A-Za-z0-9][A-Za-z0-9._-]*/g;

/** Percentage figure: bounded, so the scan is linear in the clause length. */
const FIGURE_PATTERN = /(?<!\d)\d{1,3}(?:\.\d{1,16})?%/g;

const PROTOTYPE_POLLUTING_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

const DOC_KEYS: ReadonlySet<string> = new Set(['id', 'text']);
const DRILL_KEYS: ReadonlySet<string> = new Set(['id', 'backedFigures']);

function refusal(
  reason: AvailabilityClaimRefusalReason,
  target: 'docs' | 'drillRecords',
): AvailabilityClaimGuardResult {
  return { status: 'refused', reason, target };
}

/**
 * One closed-schema enumeration of a record element. Returns `null` when the
 * element is a malformed record, otherwise the record's required strings.
 */
function readRecord(
  element: unknown,
  requiredKeys: readonly string[],
  allowedKeys: ReadonlySet<string>,
  out: Map<string, unknown>,
): boolean {
  if (typeof element !== 'object' || element === null || Array.isArray(element)) {
    return false;
  }
  const keys = Reflect.ownKeys(element);
  for (const key of keys) {
    if (typeof key !== 'string') {
      return false;
    }
    if (PROTOTYPE_POLLUTING_KEYS.has(key)) {
      out.set('__polluting', null);
      return true;
    }
    if (!allowedKeys.has(key)) {
      out.set('__unknown', null);
      return true;
    }
    out.set(key, (element as Record<string, unknown>)[key]);
  }
  for (const key of requiredKeys) {
    if (!out.has(key)) {
      return false;
    }
  }
  return true;
}

/**
 * Whether any backing drill ID is present as a whole token of the clause.
 * Iterates the smaller of the two sets, so the cost is bounded by the
 * smaller side and never by figures x tokens of the whole document.
 */
function isBackedInClause(backers: ReadonlySet<string>, clauseTokens: ReadonlySet<string>): boolean {
  if (backers.size <= clauseTokens.size) {
    for (const id of backers) {
      if (clauseTokens.has(id)) {
        return true;
      }
    }
    return false;
  }
  for (const token of clauseTokens) {
    if (backers.has(token)) {
      return true;
    }
  }
  return false;
}

/**
 * Flags percentage availability figures in document text that no same-clause,
 * token-boundary drill record ID substantiates with that exact figure.
 */
export function findUnbackedAvailabilityClaims(
  docs: unknown,
  drillRecords: unknown,
  isProxy: IsProxy,
): AvailabilityClaimGuardResult {
  const docsSnapshot = snapshotPlainData(docs, isProxy, DOC_SNAPSHOT_LIMITS);
  if (!docsSnapshot.ok) {
    return refusal('snapshot-refused', 'docs');
  }
  const drillsSnapshot = snapshotPlainData(drillRecords, isProxy, DRILL_SNAPSHOT_LIMITS);
  if (!drillsSnapshot.ok) {
    return refusal('snapshot-refused', 'drillRecords');
  }
  if (!Array.isArray(docsSnapshot.value)) {
    return refusal('not-array', 'docs');
  }
  if (!Array.isArray(drillsSnapshot.value)) {
    return refusal('not-array', 'drillRecords');
  }

  // Inverted index: figure -> the drill IDs that substantiate it. The
  // snapshot bounds (`maxNodes`) cap the total number of entries, so the
  // index is small, and a clause's figure check never rebuilds a set.
  const figureBackers = new Map<string, Set<string>>();
  for (const element of drillsSnapshot.value) {
    const fields = new Map<string, unknown>();
    if (!readRecord(element, ['id', 'backedFigures'], DRILL_KEYS, fields)) {
      return refusal('malformed-record', 'drillRecords');
    }
    if (fields.has('__polluting')) {
      return refusal('prototype-polluting-key', 'drillRecords');
    }
    if (fields.has('__unknown')) {
      return refusal('unknown-key', 'drillRecords');
    }
    const id = fields.get('id');
    if (typeof id !== 'string' || !DRILL_ID_PATTERN.test(id)) {
      return refusal('malformed-record', 'drillRecords');
    }
    const backedFigures = fields.get('backedFigures');
    if (!Array.isArray(backedFigures)) {
      return refusal('malformed-record', 'drillRecords');
    }
    for (const figure of backedFigures) {
      if (typeof figure !== 'string' || !BACKED_FIGURE_PATTERN.test(figure)) {
        return refusal('malformed-record', 'drillRecords');
      }
      let backers = figureBackers.get(figure);
      if (backers === undefined) {
        backers = new Set<string>();
        figureBackers.set(figure, backers);
      }
      backers.add(id);
    }
  }

  const findings: AvailabilityClaimFinding[] = [];
  for (const element of docsSnapshot.value) {
    const fields = new Map<string, unknown>();
    if (!readRecord(element, ['id', 'text'], DOC_KEYS, fields)) {
      return refusal('malformed-record', 'docs');
    }
    if (fields.has('__polluting')) {
      return refusal('prototype-polluting-key', 'docs');
    }
    if (fields.has('__unknown')) {
      return refusal('unknown-key', 'docs');
    }
    const id = fields.get('id');
    if (typeof id !== 'string' || id.length < 1 || id.length > MAX_DOC_ID_LENGTH) {
      return refusal('malformed-record', 'docs');
    }
    const text = fields.get('text');
    if (typeof text !== 'string') {
      return refusal('malformed-record', 'docs');
    }

    const unbackedFigures = new Set<string>();
    const clauses = text.split(CLAUSE_SEPARATOR);
    for (const clause of clauses) {
      // Distinct figures in this clause (bounded by the clause length).
      const clauseFigures = new Set<string>();
      for (const match of clause.matchAll(FIGURE_PATTERN)) {
        clauseFigures.add(match[0]);
      }
      if (clauseFigures.size === 0) {
        continue;
      }
      let clauseTokens: Set<string> | undefined;
      for (const figure of clauseFigures) {
        const backers = figureBackers.get(figure);
        if (backers === undefined) {
          unbackedFigures.add(figure);
          continue;
        }
        if (clauseTokens === undefined) {
          clauseTokens = new Set<string>();
          for (const match of clause.matchAll(ID_TOKEN_PATTERN)) {
            clauseTokens.add(match[0]);
          }
        }
        if (!isBackedInClause(backers, clauseTokens)) {
          unbackedFigures.add(figure);
        }
      }
    }
    for (const figure of unbackedFigures) {
      if (findings.length >= MAX_FINDINGS) {
        return refusal('too-many-findings', 'docs');
      }
      findings.push({ docId: id, figure });
    }
  }

  if (findings.length > 0) {
    return { status: 'flagged', findings };
  }
  return { status: 'pass' };
}
