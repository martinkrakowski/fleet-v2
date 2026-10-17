// Shared kernel (lane Q0): the secret-shape registry every context that sends
// text off-host must scan against. SECRET_PATTERNS moved here unchanged from
// KeeperPublicationAdapter; the helpers built on it report only whether or
// where a secret shape appears, never the matched text itself.

/**
 * Stable rule names for the registry above, positional order preserved. The
 * diff check reports a finding's rule as `secret-pattern:<name>`; the matched
 * text itself is never reported.
 */
export const SECRET_PATTERN_NAMES: readonly string[] = [
  'private-key-block',
  'github-token',
  'openai-style-key',
  'aws-access-key',
  'slack-token',
  'jwt',
];

/** One registry entry with its reporting rule name. */
export interface NamedSecretPattern {
  readonly name: string;
  readonly regex: RegExp;
}

/** Zip the registry with its names; the lengths are checked, never guessed. */
export function namedSecretPatterns(): readonly NamedSecretPattern[] {
  if (SECRET_PATTERN_NAMES.length !== SECRET_PATTERNS.length) {
    throw new Error('secret-pattern registry: names and patterns diverge');
  }
  return SECRET_PATTERNS.map((regex, index) => ({ name: SECRET_PATTERN_NAMES[index], regex }));
}

export const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
];

/**
 * The complete registry mirrored from `scripts/lane-diff-check.sh` (S2): all
 * 17 named patterns, in the script's table order, with each POSIX ERE
 * translated to an equivalent JS RegExp. This is the registry the lane diff
 * check scans with; `SECRET_PATTERNS` above stays untouched for the contexts
 * that already rely on it. The matched text is never reported — only the
 * rule name.
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
