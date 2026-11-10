// Shared kernel (lane Q0): the secret-shape registry every context that sends
// text off-host must scan against. SECRET_PATTERNS moved here unchanged from
// KeeperPublicationAdapter; the helpers built on it report only whether or
// where a secret shape appears, never the matched text itself.

/** One registry entry with its reporting rule name. */
export interface NamedSecretPattern {
  readonly name: string;
  readonly regex: RegExp;
}

/**
 * The legacy six secret shapes: one internal list from which both
 * `SECRET_PATTERNS` and `SECRET_PATTERN_NAMES` are derived, so the two legacy
 * exports cannot drift apart. Keep each regex and name character-for-character:
 * `@fleet/brief-knowledge` pins the six entries, and widening this narrow scan
 * to the canonical set is the SP-1 follow-up.
 */
const LEGACY_SECRET_SHAPES: readonly NamedSecretPattern[] = [
  { name: 'private-key-block', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'github-token', regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'openai-style-key', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'aws-access-key', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'slack-token', regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
];

export const SECRET_PATTERNS: readonly RegExp[] = LEGACY_SECRET_SHAPES.map((s) => s.regex);

export const SECRET_PATTERN_NAMES: readonly string[] = LEGACY_SECRET_SHAPES.map((s) => s.name);

/** The legacy six shapes, in registry order. */
export function namedSecretPatterns(): readonly NamedSecretPattern[] {
  return LEGACY_SECRET_SHAPES;
}

/**
 * The one canonical secret-pattern registry. All 17 named rules live here, in
 * the shell table's order, each POSIX ERE translated to an equivalent JS
 * RegExp. The exported name is historical — this list began as the lane-diff
 * check's rule set and the barrel keeps the old name. The shell twin's table
 * is the `PAT` heredoc in `scripts/lane-diff-check.sh` (its non-secret rows are declared in the parity test); the parity test that pins this
 * registry to that table is
 * `packages/shared/src/__tests__/lane-diff-pattern-parity.test.ts`. The
 * matched text is never reported — only the rule name.
 */
export const LANE_DIFF_SECRET_PATTERNS: readonly NamedSecretPattern[] = [
  { name: 'aws-access-key', regex: /AKIA[0-9A-Z]{16}/ },
  { name: 'github-token', regex: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'github-fine-grained-token', regex: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'private-key-block', regex: /BEGIN [A-Z ]*PRIVATE KEY/ },
  { name: 'google-oauth-access-token', regex: /ya29\.[A-Za-z0-9_-]{20,}/ },
  { name: 'google-api-key', regex: /AIza[0-9A-Za-z_-]{30,}/ },
  { name: 'openai-style-key', regex: /sk-[A-Za-z0-9_-]{20,}/ },
  { name: 'openrouter-key', regex: /sk-or-v1-[0-9a-f]{20,}/ },
  { name: 'slack-token', regex: /xox[abpr]-[A-Za-z0-9-]{10,}/ },
  { name: 'jwt', regex: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'ssh-public-key-material', regex: /ssh-(rsa|ed25519|dss|ecdsa) AAAA[A-Za-z0-9+/]{20,}/ },
  { name: 'opencode-server-password', regex: /OPENCODE_SERVER_PASSWORD[ \t\v\f\r]*=[ \t\v\f\r]*[^ \t\v\f\r]+/ },
  { name: 'agy-oauth-file', regex: /antigravity-oauth-token/ },
  { name: 'home-credential-path', regex: /\/home\/[a-z]+\/\.(ssh|config\/gh|gemini|aws|docker\/config\.json)/ },
  { name: 'password-assignment', regex: /[Pp]assword[ \t\v\f\r]*[:=][ \t\v\f\r]*["'][^"']{6,}["']/ },
  { name: 'token-assignment', regex: /[Tt]oken[ \t\v\f\r]*[:=][ \t\v\f\r]*["'][A-Za-z0-9_./+=-]{16,}["']/ },
  { name: 'basic-auth-url', regex: /https?:\/\/[^/:@ \t\v\f\r]+:[^/@ \t\v\f\r]{6,}@/ },
];

/**
 * True when any secret pattern matches anywhere in `text`. Scans only the
 * legacy six, not the canonical seventeen: widening the shared scan is the
 * SP-1 follow-up (`@fleet/operator-coordination` pins the narrow behaviour and
 * is Track C's package).
 */
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
