// Outbound contract: the edit-only lane diff check. Refined for lane O14d1;
// the operator twin and reference is `scripts/lane-diff-check.sh` (S2), and
// both must reach the same verdicts on the same inputs.
/**
 * LaneDiffCheckPort: given a worktree and the base commit it is checked
 * against, collect the worktree's tracked and untracked changed paths and
 * run the pure `checkLaneDiff` over their whole scanned content. Findings
 * carry path, line and rule name only — a matched secret value is never
 * printed, returned or logged.
 */

import type {
  LaneDiffFinding,
  LaneDiffSecretPattern,
} from "../../../domain/lane-diff-check.js";

export type { LaneDiffFinding, LaneDiffSecretPattern };

export interface LaneDiffCheckRequest {
  /** The disposable worktree to check. */
  readonly worktreePath: string;
  /** The commit the worktree is compared against (the dispatch base). */
  readonly baseCommit: string;
  /** The frozen brief's allowed path prefixes. */
  readonly allowedPathPrefixes: readonly string[];
  /** Policy additions to the fixed protected list. */
  readonly policyProtectedPaths?: readonly string[];
  /** Secret shapes; when omitted the shared registry (`@fleet/shared`, Q0) is used. */
  readonly secretPatterns?: readonly LaneDiffSecretPattern[];
}

export type LaneDiffCheckResult =
  | { readonly outcome: "clean" }
  /** At least one finding; the change set is refused. */
  | {
      readonly outcome: "findings";
      readonly findings: readonly LaneDiffFinding[];
    }
  /** The change set could not be collected; the check fails closed. */
  | { readonly outcome: "error"; readonly reason: string };

/**
 * SN2: the request of the per-commit range scan. Every commit in
 * `baseCommit..headCommit` is scanned on its own diff against its first
 * parent, so a secret added by one commit and removed by a later one cannot
 * hide behind a clean final tree.
 */
export interface LaneDiffCommitRangeRequest extends LaneDiffCheckRequest {
  /** The head the range ends at (a full 40- or 64-hex commit id). */
  readonly headCommit: string;
}

/** The per-commit range verdict: the diff-check outcomes plus a typed size refusal. */
export type LaneDiffCommitRangeResult =
  | LaneDiffCheckResult
  /** The range exceeds the commit-count or byte budget; nothing was adopted. */
  | { readonly outcome: 'range-too-large'; readonly limit: 'commits' | 'bytes' };

export interface LaneDiffCheckPort {
  /** Check one worktree's change set against the frozen brief's prefixes. */
  checkLaneDiff(request: LaneDiffCheckRequest): Promise<LaneDiffCheckResult>;
  /**
   * SN2: scan every commit of `baseCommit..headCommit` on its own diff
   * against its first parent. Optional: an implementation without it cannot
   * back a head adoption, and the dispatch refuses.
   */
  checkLaneDiffCommitRange?(request: LaneDiffCommitRangeRequest): Promise<LaneDiffCommitRangeResult>;
}
