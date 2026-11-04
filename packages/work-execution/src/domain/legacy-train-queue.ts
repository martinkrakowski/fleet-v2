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

const PULL_REQUEST_PATTERN = /^[1-9][0-9]*$/;

export function parseLegacyTrainQueue(input: unknown): LegacyTrainQueueParse {
  if (typeof input !== 'string') {
    return { ok: false, reason: 'not-text' };
  }

  if (containsSecretShape(input)) {
    return { ok: false, reason: 'secret-shaped' };
  }

  const pieces = input.split('\n');
  if (pieces[pieces.length - 1] === '') {
    pieces.pop();
  }

  const lines = pieces.map((piece, index) => parseLine(index + 1, piece));
  return { ok: true, lines: Object.freeze(lines) };
}

function parseLine(line: number, piece: string): LegacyTrainQueueLine {
  const fields = piece.split(' ');
  if (fields.length !== 3) {
    return { ok: false, line, reason: 'unknown-line' };
  }

  const [pullRequestField, headOid, baseField] = fields;
  if (!PULL_REQUEST_PATTERN.test(pullRequestField)) {
    return { ok: false, line, reason: 'unknown-line' };
  }

  const pullRequest = Number(pullRequestField);
  if (!Number.isSafeInteger(pullRequest)) {
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
