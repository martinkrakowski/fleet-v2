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

export interface LaneDiffCheckPort {
  /** Check one worktree's change set against the frozen brief's prefixes. */
  checkLaneDiff(request: LaneDiffCheckRequest): Promise<LaneDiffCheckResult>;
}
