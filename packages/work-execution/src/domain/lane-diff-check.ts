// Domain (pure): the lane diff check. This is the TypeScript twin of
// `scripts/lane-diff-check.sh` (S2); both must reach the same verdict on the
// same inputs. It answers three questions about one worktree's change set and
// never reports a matched secret value — findings carry path, line and rule
// name only.

/**
 * Status of one changed path. `untracked` files carry their whole content as
 * added lines; `deleted` files carry none and pass when under a prefix.
 */
export type LaneDiffFileStatus = "added" | "modified" | "deleted" | "untracked";

export interface LaneDiffChangedPath {
  readonly path: string;
  readonly status: LaneDiffFileStatus;
  /** 1-based line numbers with their added text, for added/modified/untracked. */
  readonly addedLines?: readonly {
    readonly line: number;
    readonly text: string;
  }[];
}

/** One secret shape to scan added lines against, with its reporting rule name. */
export interface LaneDiffSecretPattern {
  readonly name: string;
  readonly regex: RegExp;
}

export interface CheckLaneDiffInput {
  readonly changedPaths: readonly LaneDiffChangedPath[];
  /**
   * The frozen brief's allowed path prefixes. Every changed path must fall
   * under one; an absent or empty list refuses every path (fail closed), so
   * an old brief without the field can never pass the edit-only check.
   */
  readonly allowedPathPrefixes: readonly string[];
  /** Policy additions to the fixed protected list. */
  readonly policyProtectedPaths?: readonly string[];
  /**
   * Secret shapes to scan with. Required and never empty: an empty list is
   * a refusal (`secret-patterns-missing`), never a silent pass — the check
   * must not report clean when it could not scan.
   */
  readonly secretPatterns: readonly LaneDiffSecretPattern[];
}

export interface LaneDiffFinding {
  readonly path: string;
  readonly line?: number;
  readonly rule: string;
}

export interface LaneDiffVerdict {
  readonly ok: boolean;
  readonly findings: readonly LaneDiffFinding[];
}

/**
 * The fixed protected paths: lane plumbing, GitHub workflows, the lane's own
 * brief directory, the installation tree and lockfiles. The list mirrors
 * `scripts/lane-diff-check.sh`'s PROTECTED regex (line 84) plus the plan's
 * `.git/`, `installation/`, `package-lock.json` and `pnpm-lock.yaml`.
 */
const FIXED_PROTECTED_PREFIXES: readonly string[] = [
  ".git",
  ".github",
  ".gemini",
  ".agents",
  ".agy",
  ".lane",
  "bin",
  "scripts",
  ".architecture",
  "deploy",
  "installation",
];

/** Lockfiles and package manifests are protected at any depth. */
const FIXED_PROTECTED_FILES: readonly string[] = [
  "yarn.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "package.json",
];

/** Root-only files the script anchors with `$`. */
const FIXED_PROTECTED_ROOT_FILES: readonly string[] = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "Dockerfile",
];

/** Strip trailing slashes so a prefix compares as a path segment. */
function normalizePrefix(prefix: string): string {
  let normalized = prefix.trim();
  while (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

/** True when `path` is `prefix` itself or lives under it. */
export function pathUnderPrefix(path: string, prefix: string): boolean {
  const p = normalizePrefix(prefix);
  if (p === "") return false;
  return path === p || path.startsWith(`${p}/`);
}

/**
 * True when a protected path is explicitly allowed by a prefix. A lockfile
 * is exempt only when a prefix names it exactly; a protected directory's
 * contents are exempt only when a prefix names that directory itself
 * (`.github`, `.lane`, …). A prefixes list that never mentions them keeps
 * them protected — a broad prefix like `packages/x` never lifts the rule.
 */
function prefixExplicitlyAllowsProtected(
  path: string,
  prefixes: readonly string[],
): boolean {
  const top = path.split("/")[0];
  return prefixes.some((prefix) => {
    const normalized = normalizePrefix(prefix);
    return (
      normalized === path ||
      (FIXED_PROTECTED_PREFIXES.includes(top) && normalized === top)
    );
  });
}

/** The path's final segment; lockfiles are protected at any depth. */
function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * The fixed protected rule, matching the reference script's PROTECTED regex
 * plus the plan's additions. Exported for the parity test that reads the
 * script's line 84 and checks every alternative is covered here.
 */
export function isFixedProtectedPath(path: string): boolean {
  if (FIXED_PROTECTED_FILES.includes(basename(path))) return true;
  if (FIXED_PROTECTED_ROOT_FILES.includes(path)) return true;
  if (path.startsWith(".yarnrc") || path.startsWith(".pnp.")) return true;
  return FIXED_PROTECTED_PREFIXES.some((prefix) =>
    path.startsWith(`${prefix}/`),
  );
}

/**
 * Scan the added lines for secret shapes and report every hit as
 * `secret-pattern:<name>` with its 1-based line. The matched text is never
 * part of a finding.
 */
function secretFindings(
  changed: LaneDiffChangedPath,
  patterns: readonly LaneDiffSecretPattern[],
): LaneDiffFinding[] {
  const findings: LaneDiffFinding[] = [];
  for (const added of changed.addedLines ?? []) {
    for (const pattern of patterns) {
      if (pattern.regex.test(added.text)) {
        findings.push({
          path: changed.path,
          line: added.line,
          rule: `secret-pattern:${pattern.name}`,
        });
      }
    }
  }
  return findings;
}

/**
 * Check one worktree's change set: allowed prefixes, protected paths and
 * secret shapes on added lines. Pure: no filesystem, no subprocess.
 */
export function checkLaneDiff(input: CheckLaneDiffInput): LaneDiffVerdict {
  const findings: LaneDiffFinding[] = [];
  const prefixes = input.allowedPathPrefixes ?? [];
  const policyProtectedPaths = input.policyProtectedPaths ?? [];
  // Fail closed: a missing list is the same as an empty one — a refusal.
  const patterns = input.secretPatterns ?? [];

  for (const changed of input.changedPaths) {
    // Rule 1: every path must fall under an allowed prefix. Rule 2 is
    // independent, exactly like the script: a protected path is reported
    // even when it is also outside the prefixes.
    const underAllowed = prefixes.some((prefix) =>
      pathUnderPrefix(changed.path, prefix),
    );
    if (!underAllowed) {
      findings.push({ path: changed.path, rule: "outside-allowed-paths" });
    }
    // Rule 2: protected paths are refused. The fixed list is lifted only by
    // a prefix that explicitly names the protected path or directory; policy
    // additions are never lifted — they are OR-ed in and apply even when the
    // brief explicitly allows a fixed protected prefix.
    if (
      (isFixedProtectedPath(changed.path) &&
        !prefixExplicitlyAllowsProtected(changed.path, prefixes)) ||
      policyProtectedPaths.some((entry) => pathUnderPrefix(changed.path, entry))
    ) {
      findings.push({ path: changed.path, rule: "protected-path" });
    }
    // Rule 3: secret shapes on added lines, with path, line and rule only.
    // Fail closed: without any pattern the check cannot have scanned, so it
    // refuses instead of passing.
    if (patterns.length === 0) {
      findings.push({ path: changed.path, rule: "secret-patterns-missing" });
    } else {
      findings.push(...secretFindings(changed, patterns));
    }
  }

  return { ok: findings.length === 0, findings };
}

/**
 * Validate one allowed-path-prefix candidate for the frozen brief. Returns
 * the rejection reason, or null when the prefix is acceptable. Prefixes are
 * non-empty relative paths: no `..`, no absolute form, no leading `/`, and
 * never the lane plumbing directories `.git` or `.lane`.
 */
export function validateAllowedPathPrefix(prefix: string): string | null {
  if (typeof prefix !== "string" || prefix.trim() === "") {
    return "allowedPathPrefixes entries must be non-empty strings";
  }
  const value = prefix.trim();
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) {
    return `allowedPathPrefixes entry must be a relative path: ${value}`;
  }
  const segments = value.split("/");
  if (segments.includes("..")) {
    return `allowedPathPrefixes entry must not contain '..': ${value}`;
  }
  if (segments[0] === ".git" || segments[0] === ".lane") {
    return `allowedPathPrefixes entry must not name .git or .lane: ${value}`;
  }
  return null;
}
