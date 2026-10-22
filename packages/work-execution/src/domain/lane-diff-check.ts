// Domain (pure): the lane diff check. This is the TypeScript twin of
// `scripts/lane-diff-check.sh` (S2); both must reach the same verdict on the
// same inputs. It answers three questions about one worktree's change set and
// never reports a matched secret value — findings carry path, line and rule
// name only.

/**
 * Status of one changed path. Non-deleted paths carry their whole scanned
 * content (worktree and index) as `addedLines`; `deleted` files carry none
 * and pass when under a prefix.
 */
export type LaneDiffFileStatus = "added" | "modified" | "deleted" | "untracked";

export interface LaneDiffChangedPath {
  readonly path: string;
  readonly status: LaneDiffFileStatus;
  /** 1-based line numbers with the scanned text (whole content), for non-deleted paths. */
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
 * One protected-path rule. `pattern` is an ERE fragment shared with
 * `scripts/lane-diff-check.protected`: a trailing "/" is a directory rule, a
 * trailing "*" is a name-prefix rule, anything else is the exact file name
 * (it may contain "/"). `anyDepth` matches at any depth (repository root only
 * otherwise); `caseInsensitive` folds case (every rule is case-insensitive:
 * macOS volumes are case-insensitive). Only `package.json` is exempted under a
 * `node_modules/` directory (dependency manifests); every other rule still
 * applies under `node_modules/`, so `node_modules/AGENTS.md`,
 * `node_modules/x/.yarnrc` and `.agents/node_modules/x` stay protected.
 */
export interface LaneDiffProtectedRule {
  readonly pattern: string;
  readonly anyDepth: boolean;
  readonly caseInsensitive: boolean;
}

/**
 * The single protected-path table, mirrored from `scripts/lane-diff-check.protected`
 * (S2); the parity test asserts the two produce the same verdict on a shared
 * fixture list. Keep them in lockstep.
 */
export const PROTECTED_PATH_RULES: readonly LaneDiffProtectedRule[] = [
  // Repository-root directories.
  { pattern: "\\.git/", anyDepth: false, caseInsensitive: true },
  { pattern: "\\.github/", anyDepth: false, caseInsensitive: true },
  { pattern: "\\.gemini/", anyDepth: false, caseInsensitive: true },
  { pattern: "\\.agents/", anyDepth: false, caseInsensitive: true },
  { pattern: "\\.agy/", anyDepth: false, caseInsensitive: true },
  { pattern: "\\.lane/", anyDepth: false, caseInsensitive: true },
  { pattern: "\\.architecture/", anyDepth: false, caseInsensitive: true },
  { pattern: "bin/", anyDepth: false, caseInsensitive: true },
  { pattern: "scripts/", anyDepth: false, caseInsensitive: true },
  { pattern: "deploy/", anyDepth: false, caseInsensitive: true },
  { pattern: "installation/", anyDepth: false, caseInsensitive: true },
  { pattern: "\\.yarn/plugins/", anyDepth: false, caseInsensitive: true },
  { pattern: "\\.yarn/releases/", anyDepth: false, caseInsensitive: true },
  { pattern: "\\.yarn/patches/", anyDepth: false, caseInsensitive: true },
  { pattern: "\\.husky/", anyDepth: false, caseInsensitive: true },
  // Directories at any depth (agent and editor tool trees).
  { pattern: "\\.claude/", anyDepth: true, caseInsensitive: true },
  { pattern: "\\.opencode/", anyDepth: true, caseInsensitive: true },
  { pattern: "\\.cursor/", anyDepth: true, caseInsensitive: true },
  { pattern: "\\.vscode/", anyDepth: true, caseInsensitive: true },
  // Repository-root files.
  { pattern: "Dockerfile", anyDepth: false, caseInsensitive: true },
  { pattern: "Makefile", anyDepth: false, caseInsensitive: true },
  { pattern: "makefile", anyDepth: false, caseInsensitive: true },
  { pattern: "GNUmakefile", anyDepth: false, caseInsensitive: true },
  { pattern: "\\.envrc", anyDepth: false, caseInsensitive: true },
  // Repository-root name prefixes.
  { pattern: "\\.pnp\\.*", anyDepth: false, caseInsensitive: true },
  // Files at any depth (package managers, lockfiles, git plumbing).
  { pattern: "package\\.json", anyDepth: true, caseInsensitive: true },
  { pattern: "\\.yarnrc", anyDepth: true, caseInsensitive: true },
  { pattern: "\\.yarnrc\\.yml", anyDepth: true, caseInsensitive: true },
  { pattern: "\\.npmrc", anyDepth: true, caseInsensitive: true },
  { pattern: "yarn\\.lock", anyDepth: true, caseInsensitive: true },
  { pattern: "package-lock\\.json", anyDepth: true, caseInsensitive: true },
  { pattern: "pnpm-lock\\.yaml", anyDepth: true, caseInsensitive: true },
  // Agent instruction and tool files at any depth, case-insensitively.
  { pattern: "CLAUDE\\.md", anyDepth: true, caseInsensitive: true },
  { pattern: "CLAUDE\\.local\\.md", anyDepth: true, caseInsensitive: true },
  { pattern: "AGENTS\\.md", anyDepth: true, caseInsensitive: true },
  { pattern: "GEMINI\\.md", anyDepth: true, caseInsensitive: true },
  { pattern: "\\.mcp\\.json", anyDepth: true, caseInsensitive: true },
  { pattern: "\\.cursorrules", anyDepth: true, caseInsensitive: true },
  { pattern: "\\.windsurfrules", anyDepth: true, caseInsensitive: true },
  {
    pattern: "\\.github/copilot-instructions\\.md",
    anyDepth: true,
    caseInsensitive: true,
  },
  { pattern: "\\.gitattributes", anyDepth: true, caseInsensitive: true },
  { pattern: "\\.gitmodules", anyDepth: true, caseInsensitive: true },
  // Name prefixes at any depth.
  { pattern: "opencode\\.json*", anyDepth: true, caseInsensitive: true },
  // Host-tool loaders added after Fable's review of #149.
  { pattern: "\\.devcontainer/", anyDepth: true, caseInsensitive: true },
  { pattern: "mise\\.toml", anyDepth: true, caseInsensitive: true },
  { pattern: "\\.mise\\.toml", anyDepth: true, caseInsensitive: true },
  { pattern: "\\.mise/", anyDepth: true, caseInsensitive: true },
  { pattern: "\\.tool-versions", anyDepth: true, caseInsensitive: true },
  { pattern: "\\.windsurf/", anyDepth: true, caseInsensitive: true },
  { pattern: "\\.clinerules*", anyDepth: true, caseInsensitive: true },
  { pattern: "\\.roo/", anyDepth: true, caseInsensitive: true },
  { pattern: "\\.aider\\.conf\\.yml", anyDepth: true, caseInsensitive: true },
  { pattern: "\\.idea/", anyDepth: true, caseInsensitive: true },
  { pattern: "\\.zed/", anyDepth: true, caseInsensitive: true },
  { pattern: "\\.dir-locals\\.el", anyDepth: true, caseInsensitive: true },
  { pattern: "\\.yarn/sdks/", anyDepth: false, caseInsensitive: true },
  { pattern: "\\.claude-plugin/", anyDepth: true, caseInsensitive: true },
  { pattern: "pnpm-workspace\\.yaml", anyDepth: false, caseInsensitive: true },
  { pattern: "\\.pnpmfile\\.cjs", anyDepth: true, caseInsensitive: true },
];

type LaneDiffProtectedRuleKind = "dir" | "prefix" | "file";

function ruleKind(pattern: string): LaneDiffProtectedRuleKind {
  if (pattern.endsWith("/")) return "dir";
  if (pattern.endsWith("*")) return "prefix";
  return "file";
}

function ruleBody(rule: LaneDiffProtectedRule): string {
  const kind = ruleKind(rule.pattern);
  return kind === "dir" || kind === "prefix"
    ? rule.pattern.slice(0, -1)
    : rule.pattern;
}

/** The rule's plain name (ERE escapes removed), for path-segment comparison. */
function ruleName(rule: LaneDiffProtectedRule): string {
  return ruleBody(rule).replaceAll("\\.", ".");
}

interface ProtectedRuleMatcher {
  readonly rule: LaneDiffProtectedRule;
  readonly regex: RegExp;
}

/** Precompiled matchers, mirroring the shell's case-insensitive grep groups. */
const PROTECTED_MATCHERS: readonly ProtectedRuleMatcher[] =
  PROTECTED_PATH_RULES.map((rule) => {
    const body = ruleBody(rule);
    const any = `(^|/)${body}`;
    const root = `^${body}`;
    let source: string;
    switch (ruleKind(rule.pattern)) {
      case "dir":
        source = `${rule.anyDepth ? any : root}(/|$)`;
        break;
      case "prefix":
        source = rule.anyDepth ? any : root;
        break;
      default:
        source = `${rule.anyDepth ? any : root}$`;
        break;
    }
    // ASCII-only case folding, the same as the shell's `grep -i` under LC_ALL=C (Grok re-review
    // of L1b): the `i` flag would also fold non-ASCII letters (U+017F matches "s"), so the two
    // gates would disagree. The source and the path are both ASCII-lowercased instead.
    return { rule, regex: new RegExp(asciiLower(source)) };
  });

/** Lower-cases ASCII A-Z only, as `grep -i` does in the C locale. */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** True when some ancestor directory of the path is named `node_modules`. */
function isUnderNodeModules(path: string): boolean {
  return /(^|\/)node_modules\//.test(asciiLower(path));
}

/** Every rule that protects `path` (only `package.json` is exempted under `node_modules/`). */
function protectingMatchers(path: string): readonly ProtectedRuleMatcher[] {
  return PROTECTED_MATCHERS.filter(({ rule, regex }) => {
    if (!regex.test(asciiLower(path))) return false;
    if (rule.pattern === "package\\.json" && isUnderNodeModules(path)) {
      return false;
    }
    return true;
  });
}

/**
 * The fixed protected rule, matching the table in
 * `scripts/lane-diff-check.protected`. Exported for the parity test.
 */
export function isFixedProtectedPath(path: string): boolean {
  return protectingMatchers(path).length > 0;
}

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
 * A protected file (lockfile, `package.json`, `.gitattributes`,
 * `.gitmodules`, or nested agent config) inside a lifted directory stays
 * protected unless a prefix names it exactly: lifting `scripts` does not
 * lift `scripts/package.json` or `scripts/.claude/settings.json`.
 */
function prefixExplicitlyAllowsProtected(
  path: string,
  prefixes: readonly string[],
): boolean {
  const top = path.split("/")[0];
  return prefixes.some((prefix) => {
    const normalized = normalizePrefix(prefix);
    if (normalized === path) return true;
    if (normalized !== top) return false;
    const matchers = protectingMatchers(path);
    if (matchers.length === 0) return false;
    return matchers.every(
      ({ rule }) =>
        ruleKind(rule.pattern) === "dir" && ruleName(rule) === top,
    );
  });
}

/**
 * Scan the scanned content lines (whole file content for non-deleted
 * paths) for secret shapes and report every hit as
 * `secret-pattern:<name>` with its 1-based line. The matched text is never
 * part of a finding.
 */
function secretFindings(
  changed: LaneDiffChangedPath,
  patterns: readonly LaneDiffSecretPattern[],
): LaneDiffFinding[] {
  const findings: LaneDiffFinding[] = [];
  // Copy each pattern once without the `g`/`y` flags: a supplied regex
  // carrying `g` keeps `lastIndex` across `.test()` calls and would silently
  // skip lines, and `y` anchors at lastIndex. Without them `.test()` keeps
  // no state, so one copy serves every line.
  const matchers = patterns.map((pattern) => ({
    name: pattern.name,
    matcher: new RegExp(
      pattern.regex.source,
      pattern.regex.flags.replace(/[gy]/g, ""),
    ),
  }));
  for (const added of changed.addedLines ?? []) {
    for (const { name, matcher } of matchers) {
      if (matcher.test(added.text)) {
        findings.push({
          path: changed.path,
          line: added.line,
          rule: `secret-pattern:${name}`,
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
