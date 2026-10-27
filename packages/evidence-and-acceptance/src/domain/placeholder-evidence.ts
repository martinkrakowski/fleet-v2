/**
 * Placeholder-evidence rejecter (Agensh adoption plan §3.1): pure, with
 * type-only imports and no side effects. Lane A2 wires it into the evidence
 * constructors for new writes only (D1).
 */

import type {
  FindingDispositionRecord,
  ReviewFindingRecord,
  VerificationReceiptRecord,
} from './evidence-records.js';

/** Refused when the text STARTS with one of these as a whole word (plan §3.1). */
export const PLACEHOLDER_PREFIXES = [
  'tbd',
  'todo',
  'n/a',
  'na',
  'should work',
  'looks right',
  'looks good',
  'lgtm',
] as const;

/** Refused only when one of these is the WHOLE text, after trailing punctuation is dropped (D2, 2026-10-26). */
export const PLACEHOLDER_WHOLE_TEXTS = ['none', 'seems', 'probably', 'i think'] as const;

const WORD_CHAR = /^[\p{L}\p{N}_]$/u;
const PUNCT_OR_SPACE = /^[\p{P}\s]$/u;

function isWordChar(ch: string): boolean {
  return WORD_CHAR.test(ch);
}

/** True when `text` carries no evidence (plan §3.1). */
export function isPlaceholderEvidence(text: string): boolean {
  const normalised = text.trim().toLowerCase().split(/\s+/).join(' ');
  if (normalised === '') {
    return true;
  }
  const hasPrefix = PLACEHOLDER_PREFIXES.some((p) => {
    if (!normalised.startsWith(p)) {
      return false;
    }
    return normalised.length === p.length || !isWordChar(normalised[p.length]);
  });
  if (hasPrefix) {
    return true;
  }
  let end = normalised.length;
  while (end > 0 && PUNCT_OR_SPACE.test(normalised[end - 1])) {
    end -= 1;
  }
  const stripped = normalised.slice(0, end);
  if (stripped === '') {
    return true;
  }
  return (PLACEHOLDER_WHOLE_TEXTS as readonly string[]).includes(stripped);
}

/**
 * Whole-value placeholder check (amendment D-a/D-b): true only when the value
 * is empty after trimming, or when the normalised, trailing-punctuation-
 * stripped text equals a whole placeholder phrase. A reference like
 * `todo.ts:40` or a sentence like "TODO: null check missing at line 40"
 * carries evidence and is accepted.
 */
export function isWholeValuePlaceholder(text: string): boolean {
  if (text.trim() === '') {
    return true;
  }
  const normalised = text.trim().toLowerCase().split(/\s+/).join(' ');
  let end = normalised.length;
  while (end > 0 && PUNCT_OR_SPACE.test(normalised[end - 1])) {
    end -= 1;
  }
  const stripped = normalised.slice(0, end);
  return (
    (PLACEHOLDER_PREFIXES as readonly string[]).includes(stripped) ||
    (PLACEHOLDER_WHOLE_TEXTS as readonly string[]).includes(stripped)
  );
}

/** True only for a string that is placeholder text; a non-string is left to the entity's shape check. */
function isPlaceholderString(value: unknown): boolean {
  return typeof value === 'string' && isPlaceholderEvidence(value);
}

/** True only for a string that is whole-value placeholder text; a non-string is left to the entity's shape check. */
function isWholeValuePlaceholderString(value: unknown): boolean {
  return typeof value === 'string' && isWholeValuePlaceholder(value);
}

/**
 * Write-side check for a new review receipt (plan §3.1, D1, amendment D-b):
 * the first field holding whole-value placeholder text, or null. Never called
 * on stored records.
 */
export function placeholderReviewReceiptField(receipt: {
  readonly evidenceRef: unknown;
  readonly findings: readonly ReviewFindingRecord[];
}): string | null {
  if (isWholeValuePlaceholderString(receipt.evidenceRef)) {
    return 'evidenceRef';
  }
  if (!Array.isArray(receipt.findings)) {
    return null;
  }
  const index = receipt.findings.findIndex((finding) => isWholeValuePlaceholderString(finding?.summary));
  return index === -1 ? null : 'findings[' + String(index) + '].summary';
}

/** Write-side check for a new verification receipt (amendment D-a): only evidenceRef carries evidence. */
export function placeholderVerificationReceiptField(
  receipt: Pick<VerificationReceiptRecord, 'evidenceRef'>,
): string | null {
  return isWholeValuePlaceholderString(receipt.evidenceRef) ? 'evidenceRef' : null;
}

/**
 * Write-side check for a new finding disposition (amendment D-a): reason keeps
 * the full rule first, then evidenceRef uses the whole-value check.
 */
export function placeholderFindingDispositionField(
  disposition: Pick<FindingDispositionRecord, 'reason' | 'evidenceRef'>,
): string | null {
  if (isPlaceholderString(disposition.reason)) {
    return 'reason';
  }
  return isWholeValuePlaceholderString(disposition.evidenceRef) ? 'evidenceRef' : null;
}

/** The refusal text: names the record and field, never the value. */
export function placeholderEvidenceRefusal(recordName: string, field: string): string {
  return recordName + ' ' + field + ' is placeholder text, not evidence';
}
