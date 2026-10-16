// Shared kernel (lane Q0): the secret-shape registry every context that sends
// text off-host must scan against. SECRET_PATTERNS moved here unchanged from
// KeeperPublicationAdapter; the helpers built on it report only whether or
// where a secret shape appears, never the matched text itself.

export const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
];

/** True when any secret pattern matches anywhere in `text`. */
export function containsSecretShape(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Returns the 1-based line numbers of the lines that contain a secret
 * shape, in ascending order with duplicates removed. Returns numbers
 * only — never the matched text.
 */
export function findSecretShapeLines(text: string): number[] {
  if (typeof text !== 'string' || text.length === 0) {
    return [];
  }
  const lines = text.split('\n');
  const hits: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (containsSecretShape(lines[index])) {
      hits.push(index + 1);
    }
  }
  return hits;
}
