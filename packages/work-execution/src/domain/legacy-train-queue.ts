/**
 * Pure parser for legacy shell merge-train queue lines of the form `pr sha base`.
 * Unknown lines are reported, never guessed. Secret-shaped input is refused.
 */
import { containsSecretShape } from '@fleet/shared';

import { parseBaseBranch } from './base-branch.js';
import type { BaseBranchValue } from './base-branch.js';
import { isMergeHex40 } from './merge-queue-records.js';

export interface LegacyTrainQueueEntry {
  readonly line: number;
  readonly pullRequest: number;
  readonly headOid: string;
  readonly base: BaseBranchValue;
}

export type LegacyTrainQueueLine =
  | { readonly ok: true; readonly entry: LegacyTrainQueueEntry }
  | { readonly ok: false; readonly line: number; readonly reason: 'unknown-line' };

export type LegacyTrainQueueParse =
  | { readonly ok: false; readonly reason: 'not-text' | 'secret-shaped' }
  | { readonly ok: true; readonly lines: readonly LegacyTrainQueueLine[] };

/**
 * Parked entries use the same `pr head base` line format as queue and
 * inprogress records (SH4d fix round 2): the cutover contract and the
 * exported parked documents both treat a parked record as a `pr sha base`
 * line, so no separate 6-field shape exists.
 */
export type LegacyTrainParkedLine = LegacyTrainQueueLine;

export type LegacyTrainParkedParse =
  | { readonly ok: false; readonly reason: 'not-text' | 'too-large' | 'secret-shaped' }
  | { readonly ok: true; readonly lines: readonly LegacyTrainParkedLine[] };

const PULL_REQUEST_PATTERN = /^[1-9][0-9]*$/;
const PARKED_DOCUMENT_CAP = 1_048_576;

export function parseLegacyTrainQueue(input: unknown): LegacyTrainQueueParse {
  if (typeof input !== 'string') {
    return { ok: false, reason: 'not-text' };
  }

  if (containsSecretShape(input)) {
    return { ok: false, reason: 'secret-shaped' };
  }

  const lines = splitDocumentLines(input).map((piece, index) => parseLine(index + 1, piece));
  return { ok: true, lines: Object.freeze(lines) };
}

/** Split on newline, dropping only the trailing empty piece after a final newline. */
function splitDocumentLines(input: string): string[] {
  const pieces = input.split('\n');
  if (pieces[pieces.length - 1] === '') {
    pieces.pop();
  }
  return pieces;
}

function parseLine(line: number, piece: string): LegacyTrainQueueLine {
  const fields = piece.split(' ');
  if (fields.length !== 3) {
    return { ok: false, line, reason: 'unknown-line' };
  }

  const [pullRequestField, headOid, baseField] = fields;

  const pullRequest = parsePullRequestNumber(pullRequestField);
  if (pullRequest === undefined) {
    return { ok: false, line, reason: 'unknown-line' };
  }

  if (!isMergeHex40(headOid)) {
    return { ok: false, line, reason: 'unknown-line' };
  }

  const base = parseBaseBranch(baseField);
  if (base === undefined) {
    return { ok: false, line, reason: 'unknown-line' };
  }

  return {
    ok: true,
    entry: Object.freeze({ line, pullRequest, headOid, base }),
  };
}

/**
 * Parse the shell `parked` file (SH4d). Parked records use the established
 * `pr head base` line format, the same as queue and inprogress records
 * (SH4d fix round 2); anything else is an unknown line, never a thrown
 * error. Cost: linear in the document length, capped at
 * `PARKED_DOCUMENT_CAP` characters, refused before any traversal beyond
 * the cap.
 *
 * Secret-shape detection refuses the whole document (CO4), exactly as the
 * queue parser does: a secret-shaped value anywhere yields
 * `ok: false, reason: 'secret-shaped'` and never a mixed document the
 * caller could proceed with. No secret-shaped value is ever echoed or
 * stored.
 */
export function parseLegacyTrainParkedQueue(input: unknown): LegacyTrainParkedParse {
  if (typeof input !== 'string') {
    return { ok: false, reason: 'not-text' };
  }

  if (input.length > PARKED_DOCUMENT_CAP) {
    return { ok: false, reason: 'too-large' };
  }

  if (containsSecretShape(input)) {
    return { ok: false, reason: 'secret-shaped' };
  }

  const lines = splitDocumentLines(input).map((piece, index) => parseLine(index + 1, piece));
  return { ok: true, lines: Object.freeze(lines) };
}

/** The queue parser's own pull-request validation, reused verbatim. */
function parsePullRequestNumber(field: string): number | undefined {
  if (!PULL_REQUEST_PATTERN.test(field)) {
    return undefined;
  }
  const value = Number(field);
  return Number.isSafeInteger(value) ? value : undefined;
}
