/**
 * Placeholder-evidence rejecter (Agensh adoption plan §3.1): pure, with no
 * imports or side effects. Lane A2 wires it into the evidence constructors
 * for new writes only (D1).
 */

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
