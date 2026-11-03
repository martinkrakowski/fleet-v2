/**
 * The bounded review-findings view of a parked run (GB2 part 1): the only
 * shape in which untrusted reviewer findings may reach an owner surface (the
 * keyed owner question of a blocker-after-round-2 park and `conductor status`).
 * Every field is validated and capped; findings that cannot be bounded are
 * dropped, never guessed. Pure, no port and no I/O.
 */

import { containsSecretShape } from '@fleet/shared';

export interface LaneRunParkFindingView {
  readonly findingId: string;
  readonly severity: 'blocker' | 'major' | 'minor' | 'nit';
  readonly summary: string;
  readonly filePath: string | null;
  readonly line: number | null;
}

/** At most this many findings ever reach an owner surface. */
export const PARK_FINDINGS_MAX_COUNT = 5;

/** A summary's code-point cap before it is truncated (characters, not bytes). */
export const PARK_FINDING_SUMMARY_MAX = 160;

const FINDING_ID_PATTERN = /^[0-9A-Za-z-]{1,128}$/;
const FILE_PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/**
 * Any run of characters that is not a Unicode letter, a Unicode digit or
 * ASCII punctuation (`\x21-\x7E` also covers ASCII letters and digits): the
 * ASCII space, all other whitespace, controls, Unicode format characters,
 * line and paragraph separators, combining marks and lone surrogates. Every
 * such run is collapsed to a single space in the bounded view.
 */
const NON_ALLOWED_SUMMARY_RUN = /[^\p{L}\p{N}\x21-\x7E]+/gu;

const SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const;

/** True for a plain object (prototype Object.prototype or null). */
function isPlainRecordObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** The bounded summary; null drops the whole finding. */
function summaryOf(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  // Allow-list cleaning: every run of characters that is not a Unicode letter,
  // a Unicode digit or ASCII punctuation collapses to a single space, and
  // leading/trailing spaces are trimmed. The secret check runs last, on the
  // final string only, never on the raw input.
  const flattened = value.replace(NON_ALLOWED_SUMMARY_RUN, ' ');
  const stripped = flattened.replace(/^ +| +$/g, '');
  const bounded = Array.from(stripped).slice(0, PARK_FINDING_SUMMARY_MAX).join('');
  // The code-point cap can leave a trailing space behind; trim it again.
  const final = bounded.replace(/ +$/, '');
  if (final.length === 0) {
    return null;
  }
  if (containsSecretShape(final) || containsSecretShape(final.replace(/ /g, ''))) {
    return null;
  }
  return final;
}

/** A plain worktree-relative path, or null when the finding's path is dropped. */
function filePathOf(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  if (value.includes('..') || value.includes('\\')) {
    return null;
  }
  if (!FILE_PATH_PATTERN.test(value)) {
    return null;
  }
  if (containsSecretShape(value)) {
    return null;
  }
  return value;
}

/** One of the four severity codes, or null when the finding is dropped. */
function severityOf(value: unknown): LaneRunParkFindingView['severity'] | null {
  return (SEVERITIES as readonly string[]).includes(value as string)
    ? (value as LaneRunParkFindingView['severity'])
    : null;
}

/** A non-negative safe integer, or null when the line is dropped. */
function lineOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** A finding id matching the bounded shape, or null when the finding is dropped. */
function findingIdOf(value: unknown): string | null {
  return typeof value === 'string' && FINDING_ID_PATTERN.test(value) ? value : null;
}

/**
 * True when `value` is exactly a bounded findings-view object: the five fields
 * present with the contract's types, an allow-list-cleaned bounded summary,
 * and no extra keys. Used to validate a stored snapshot.
 */
export function isParkFindingView(value: unknown): value is LaneRunParkFindingView {
  if (!isPlainRecordObject(value)) {
    return false;
  }
  if (Reflect.ownKeys(value).length !== 5) {
    return false;
  }
  if (typeof value.findingId !== 'string' || !FINDING_ID_PATTERN.test(value.findingId)) {
    return false;
  }
  if (severityOf(value.severity) === null) {
    return false;
  }
  if (typeof value.summary !== 'string') {
    return false;
  }
  if (Array.from(value.summary).length > PARK_FINDING_SUMMARY_MAX) {
    return false;
  }
  if (summaryOf(value.summary) !== value.summary) {
    return false;
  }
  if (value.filePath !== null && filePathOf(value.filePath) === null) {
    return false;
  }
  if (value.line !== null && lineOf(value.line) === null) {
    return false;
  }
  return true;
}

/**
 * The stored snapshot read: the exact snapshot is answered unchanged when it
 * is an array within the cap of valid bounded findings; anything else — a
 * non-array, more than the cap, or a malformed entry — answers null.
 */
export function parkFindingsSnapshotOf(snapshot: unknown): readonly LaneRunParkFindingView[] | null {
  if (!Array.isArray(snapshot)) {
    return null;
  }
  if (snapshot.length > PARK_FINDINGS_MAX_COUNT) {
    return null;
  }
  for (const entry of snapshot) {
    if (!isParkFindingView(entry)) {
      return null;
    }
  }
  return snapshot;
}

/**
 * The bounded view of one receipt's findings: at most `PARK_FINDINGS_MAX_COUNT`
 * findings, each with a truncated, allow-list-cleaned and secret-free summary, a
 * kept (or null) worktree-relative file path and a non-negative line. Anything
 * that is not an array (including null) yields `[]`. Unknown shapes are dropped,
 * never guessed.
 */
export function boundedFindingsView(
  findings:
    | readonly {
        findingId: string;
        severity: string;
        summary: string;
        filePath: string | null;
        line: number | null;
      }[]
    | null
    | undefined,
): LaneRunParkFindingView[] {
  if (!Array.isArray(findings)) {
    return [];
  }
  const out: LaneRunParkFindingView[] = [];
  for (const raw of findings) {
    if (out.length >= PARK_FINDINGS_MAX_COUNT) {
      break;
    }
    if (!isPlainRecordObject(raw)) {
      continue;
    }
    const findingId = findingIdOf(raw.findingId);
    const severity = severityOf(raw.severity);
    const summary = summaryOf(raw.summary);
    if (findingId === null || severity === null || summary === null) {
      continue;
    }
    out.push({
      findingId,
      severity,
      summary,
      filePath: filePathOf(raw.filePath),
      line: lineOf(raw.line),
    });
  }
  return out;
}
