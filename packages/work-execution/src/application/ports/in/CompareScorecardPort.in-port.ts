// @generated inbound contract scaffold — refined for lane CO20.
/**
 * CompareScorecardPort compares scorecard rows before and after a split date
 * within an optional from and to range, read-only: per period the counts of
 * runs, first-pass completions, fix rounds, review findings by severity and
 * escaped defects, and the CI cost of each merged pull request read from the
 * forge. A row or CI cost that cannot be read is counted as unknown and
 * named, never as zero. It writes nothing. Ids, codes and counts only.
 */

import type { LaneScorecardFindings } from '../out/LaneScorecardPort.out-port.js';
import type { WorkflowCiCost } from '../out/ForgeReadPort.out-port.js';

/** Rows or problem lines above this are refused, never read partially. */
export const COMPARE_SCORECARD_MAX_ROWS = 5_000;
/** The comparison budget when the request names none. */
export const COMPARE_SCORECARD_DEFAULT_BUDGET_MS = 60_000;
/** A budget above this is refused; a smaller budget is honoured exactly. */
export const COMPARE_SCORECARD_MAX_BUDGET_MS = 300_000;

export interface CompareScorecardRequest {
  /** A zoned ISO-8601 datetime, or a strict `YYYY-MM-DD` (start of that UTC day). */
  readonly split: string;
  /** Optional range start; a `YYYY-MM-DD` is the start of that UTC day. */
  readonly from?: string;
  /** Optional range end; a `YYYY-MM-DD` is the end of that UTC day. */
  readonly to?: string;
  /** Optional positive safe-integer budget cap, `<= COMPARE_SCORECARD_MAX_BUDGET_MS`. */
  readonly budgetMs?: number;
}

/** Why one scorecard row (or line) could not be read; ids and codes only. */
export type UnknownScorecardRowReason =
  | 'malformed-line' | 'malformed-row' | 'invalid-row-id' | 'duplicate-run-id'
  | 'run-not-found' | 'work-order-not-found' | 'timestamp-unreadable'
  | 'stores-unreadable' | 'budget-exhausted';

/**
 * One row or line counted as unknown: a malformed line by its line number, a
 * structurally invalid row's id by its row index (the id itself is never
 * echoed when it is the problem), and a structurally valid row by its run id.
 */
export type UnknownScorecardRow =
  | { readonly kind: 'line'; readonly lineNumber: number; readonly reason: 'malformed-line' }
  | { readonly kind: 'row'; readonly runId: string; readonly reason: Exclude<UnknownScorecardRowReason, 'malformed-line' | 'invalid-row-id'> }
  | { readonly kind: 'row-index'; readonly rowIndex: number; readonly reason: 'invalid-row-id' };

/** Why one merged pull request's CI cost is unknown; ids and codes only. */
export type UnknownCiCostReason =
  | 'missing-pr-number' | 'invalid-repository' | 'pr-not-found' | 'ci-cost-unavailable' | 'budget-exhausted';

/** One merged pull request whose CI cost could not be read. */
export interface UnknownPullRequestCiCost {
  readonly runId: string;
  readonly prNumber: number | null;
  readonly reason: UnknownCiCostReason;
}

/** One merged pull request whose CI cost was read. */
export interface MergedPullRequestCiCostItem {
  readonly runId: string;
  readonly prNumber: number;
  readonly checkRuns: number;
  readonly billedMinutes: number;
  readonly workflows: readonly WorkflowCiCost[];
}

/** The CI cost of one period's merged pull requests; unknown stays unknown. */
export interface ScorecardPeriodCiCostSummary {
  readonly knownPullRequestCount: number;
  readonly unknownPullRequestCount: number;
  readonly totalCheckRuns: number;
  readonly totalBilledMinutes: number;
  readonly pullRequests: readonly MergedPullRequestCiCostItem[];
  readonly unknownPullRequests: readonly UnknownPullRequestCiCost[];
}

/** One period's aggregate over its readable rows; unknown rows are named, never folded into the counts. */
export interface ScorecardPeriodSummary {
  readonly runCount: number;
  readonly mergedRunCount: number;
  readonly stoppedRunCount: number;
  readonly firstPassCompletions: number;
  readonly fixRounds: number;
  readonly reviewFindings: LaneScorecardFindings;
  readonly escapedDefects: number;
  readonly ciCost: ScorecardPeriodCiCostSummary;
}

export type CompareScorecardRefusalReason =
  | 'invalid-request' | 'invalid-range' | 'scorecard-unreadable' | 'scorecard-too-large';

export type CompareScorecardResult =
  | {
      readonly outcome: 'compared';
      readonly fromIso: string | null;
      readonly splitIso: string;
      readonly toIso: string | null;
      readonly scorecardAbsent: boolean;
      readonly before: ScorecardPeriodSummary;
      readonly after: ScorecardPeriodSummary;
      readonly unknownRowCount: number;
      readonly unknownRows: readonly UnknownScorecardRow[];
    }
  | { readonly outcome: 'refused'; readonly reason: CompareScorecardRefusalReason };

export interface CompareScorecardPort {
  /** Read-only comparison; it writes nothing and never throws on runtime input. */
  compareScorecard(request: CompareScorecardRequest): Promise<CompareScorecardResult>;
}
