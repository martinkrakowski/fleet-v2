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
 * One entry of the real shell's 6-field `parked` file:
 * `pr head reason attempt notBefore base` (SH4d). The shell writes
 * `echo "$pr $h $reason $att $nb $base" >> "$PARKED"`. `notBefore` is
 * assumed to be epoch seconds (a non-negative integer); the private fleet
 * repo was not reachable from this lane to confirm the exact shell format,
 * so this interpretation is recorded here and flagged for challenge.
 */
export interface LegacyTrainParkedEntry {
  readonly line: number;
  readonly pullRequest: number;
  readonly headOid: string;
  readonly reason: string;
  readonly attempt: number;
  readonly notBeforeEpochSeconds: number;
  readonly base: BaseBranchValue;
}

export type LegacyTrainParkedLine =
  | { readonly ok: true; readonly entry: LegacyTrainParkedEntry }
  | { readonly ok: false; readonly line: number; readonly reason: 'unknown-line' };

export type LegacyTrainParkedParse =
  | { readonly ok: false; readonly reason: 'not-text' | 'too-large' | 'secret-shaped' }
  | { readonly ok: true; readonly lines: readonly LegacyTrainParkedLine[] };

const PULL_REQUEST_PATTERN = /^[1-9][0-9]*$/;
const NON_NEGATIVE_INTEGER_PATTERN = /^[0-9]+$/;
const REASON_PATTERN = /^[!-~]+$/;
const REASON_MAX_LENGTH = 128;
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
 * Parse the real shell `parked` file (SH4d). Requires exactly 6
 * whitespace-separated fields per line, `pr head reason attempt notBefore
 * base`; anything else — including a 3-field queue-format line — is an
 * unknown line, never a thrown error. Cost: linear in the document length,
 * capped at `PARKED_DOCUMENT_CAP` characters and `REASON_MAX_LENGTH` per
 * reason field, refused before any traversal beyond the cap.
 *
 * Secret-shape detection refuses the whole document (CO4), exactly as the
 * queue parser does: a secret-shaped value anywhere — in particular in the
 * free-text `reason` field — yields `ok: false, reason: 'secret-shaped'`
 * and never a mixed document the caller could proceed with. No secret-
 * shaped value is ever echoed or stored.
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

  const lines = splitDocumentLines(input).map((piece, index) => parseParkedLine(index + 1, piece));
  return { ok: true, lines: Object.freeze(lines) };
}

function parseParkedLine(line: number, piece: string): LegacyTrainParkedLine {
  const fields = piece.split(' ');
  if (fields.length !== 6) {
    return { ok: false, line, reason: 'unknown-line' };
  }

  const [pullRequestField, headOid, reason, attemptField, notBeforeField, baseField] = fields;

  const pullRequest = parsePullRequestNumber(pullRequestField);
  if (pullRequest === undefined || !isMergeHex40(headOid)) {
    return { ok: false, line, reason: 'unknown-line' };
  }

  if (reason.length > REASON_MAX_LENGTH || !REASON_PATTERN.test(reason)) {
    return { ok: false, line, reason: 'unknown-line' };
  }

  const attempt = parseNonNegativeSafeInteger(attemptField);
  const notBefore = parseNonNegativeSafeInteger(notBeforeField);
  if (attempt === undefined || notBefore === undefined) {
    return { ok: false, line, reason: 'unknown-line' };
  }

  const base = parseBaseBranch(baseField);
  if (base === undefined) {
    return { ok: false, line, reason: 'unknown-line' };
  }

  return {
    ok: true,
    entry: Object.freeze({ line, pullRequest, headOid, reason, attempt, notBeforeEpochSeconds: notBefore, base }),
  };
}

/** The queue parser's own pull-request validation, reused verbatim. */
function parsePullRequestNumber(field: string): number | undefined {
  if (!PULL_REQUEST_PATTERN.test(field)) {
    return undefined;
  }
  const value = Number(field);
  return Number.isSafeInteger(value) ? value : undefined;
}

/** A non-negative safe integer, for `attempt` and the epoch-seconds `notBefore`. */
function parseNonNegativeSafeInteger(field: string): number | undefined {
  if (!NON_NEGATIVE_INTEGER_PATTERN.test(field)) {
    return undefined;
  }
  const value = Number(field);
  return Number.isSafeInteger(value) ? value : undefined;
}
