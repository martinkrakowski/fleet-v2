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
 * A parked record from the shell's `parked` file: `pr head reason attempt
 * notBefore base` (SH4d; confirmed against `tools/fleet-v2-orchestrator/train/tick.sh`
 * in the private fleet repo, `echo "$pr $h $reason $att $nb $base" >>
 * "$PARKED"`). This is a genuinely different 6-field shape from the queue
 * and inprogress 3-field `pr sha base` line: `notBefore` is the shell's own
 * `now()` (`date +%s`), compared with `[ "$(now)" -ge "$nb" ]`, so it is
 * epoch seconds, never an ISO timestamp.
 */
export interface LegacyTrainParkedEntry {
  readonly line: number;
  readonly pullRequest: number;
  readonly headOid: string;
  readonly reason: string;
  readonly attempt: number;
  readonly notBefore: number;
  readonly base: BaseBranchValue;
}

export type LegacyTrainParkedLine =
  | { readonly ok: true; readonly entry: LegacyTrainParkedEntry }
  | { readonly ok: false; readonly line: number; readonly reason: 'unknown-line' };

export type LegacyTrainParkedParse =
  | { readonly ok: false; readonly reason: 'not-text' | 'too-large' | 'secret-shaped' }
  | { readonly ok: true; readonly lines: readonly LegacyTrainParkedLine[] };

const PULL_REQUEST_PATTERN = /^[1-9][0-9]*$/;
const NON_NEGATIVE_INTEGER_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const PARKED_REASON_MAX_LENGTH = 128;
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
 * Parse the shell `parked` file (SH4d). A parked record is a genuinely
 * different 6-field shape from the queue/inprogress 3-field line (see
 * `LegacyTrainParkedEntry`); exactly 6 whitespace-separated fields are
 * required, and anything else — including the 3-field queue/inprogress
 * shape — is an unknown line, never a thrown error. Cost: linear in the
 * document length, capped at `PARKED_DOCUMENT_CAP` characters, refused
 * before any traversal beyond the cap.
 *
 * Secret-shape detection refuses the whole document (CO4), exactly as the
 * queue parser does: a secret-shaped value anywhere — including in the
 * free-text `reason` field — yields `ok: false, reason: 'secret-shaped'`
 * and never a mixed document the caller could proceed with. No
 * secret-shaped value is ever echoed or stored.
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

/**
 * Parse one `pr head reason attempt notBefore base` parked line. Exactly 6
 * fields are required — a 3-field queue/inprogress line, or a 7-field line,
 * is unknown here, never accepted. Every field reuses the same validation
 * primitive its queue/inprogress counterpart already uses where one exists
 * (`pr`, `head`, `base`); `reason`, `attempt` and `notBefore` are new
 * primitives for this file (see `parseParkedReason` and
 * `parseNonNegativeInteger`).
 */
function parseParkedLine(line: number, piece: string): LegacyTrainParkedLine {
  const fields = piece.split(' ');
  if (fields.length !== 6) {
    return { ok: false, line, reason: 'unknown-line' };
  }

  const [pullRequestField, headOid, reasonField, attemptField, notBeforeField, baseField] = fields;

  const pullRequest = parsePullRequestNumber(pullRequestField);
  if (pullRequest === undefined) {
    return { ok: false, line, reason: 'unknown-line' };
  }

  if (!isMergeHex40(headOid)) {
    return { ok: false, line, reason: 'unknown-line' };
  }

  const parkedReason = parseParkedReason(reasonField);
  if (parkedReason === undefined) {
    return { ok: false, line, reason: 'unknown-line' };
  }

  const attempt = parseNonNegativeInteger(attemptField);
  if (attempt === undefined) {
    return { ok: false, line, reason: 'unknown-line' };
  }

  const notBefore = parseNonNegativeInteger(notBeforeField);
  if (notBefore === undefined) {
    return { ok: false, line, reason: 'unknown-line' };
  }

  const base = parseBaseBranch(baseField);
  if (base === undefined) {
    return { ok: false, line, reason: 'unknown-line' };
  }

  return {
    ok: true,
    entry: Object.freeze({
      line,
      pullRequest,
      headOid,
      reason: parkedReason,
      attempt,
      notBefore,
      base,
    }),
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

/**
 * A parked record's `reason` field: non-empty and at most
 * `PARKED_REASON_MAX_LENGTH` characters. It is free text the shell writer
 * could in principle populate with anything, so document-level secret-shape
 * detection (above) is this field's only content check beyond its length;
 * the value is stored only as a validated field, never echoed raw.
 */
function parseParkedReason(field: string): string | undefined {
  if (field.length === 0 || field.length > PARKED_REASON_MAX_LENGTH) {
    return undefined;
  }
  return field;
}

/**
 * A non-negative safe integer field, shared by `attempt` (a retry count)
 * and `notBefore` (the shell's own epoch-seconds `now()`): digits only, no
 * leading zero other than a lone `0`, within `Number.isSafeInteger` range.
 */
function parseNonNegativeInteger(field: string): number | undefined {
  if (!NON_NEGATIVE_INTEGER_PATTERN.test(field)) {
    return undefined;
  }
  const value = Number(field);
  return Number.isSafeInteger(value) ? value : undefined;
}
