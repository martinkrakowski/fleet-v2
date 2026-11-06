// @generated inbound contract scaffold — refined for lane CO24.
/**
 * PreparePullRequestFeedbackFixPort: turn one open pull request's review
 * feedback into a fix round. The unresolved review threads at the exact
 * current head are read as typed fields, every forge-sourced text is wrapped
 * as untrusted input, and a fresh fix attempt is prepared through
 * PrepareFixAttempt with the numbered findings, keyed
 * `pr-feedback/<pullRequest>@<head12>`. The fixed head is pushed only through
 * `push-to-pr` under the run's grant. A moved head, an unreadable forge or no
 * unresolved thread refuses with a reason code. It never resolves a thread.
 * Results carry ids, codes and counts only.
 */

export type PreparePullRequestFeedbackFixCode =
  | 'invalid-request'
  | 'not-configured'
  | 'head-moved'
  | 'forge-unreadable'
  | 'partial-page'
  | 'no-unresolved-threads'
  | 'redaction-refused'
  | 'too-large'
  | 'fix-attempt-refused'
  | 'push-refused';

export interface PreparePullRequestFeedbackFixRequest {
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly pullRequestNumber: number;
  /** The exact current head of the pull request. */
  readonly headSha: string;
  readonly branchName: string;
  readonly workOrderId: string;
  readonly priorAttemptId: string;
  /** Defaults to the derived id `pr-feedback-<pullRequestNumber>-<head12>`. */
  readonly fixAttemptId?: string;
  /** The run's grant id (ids only). Required for the push. */
  readonly grantId?: string;
  /** Optional pass-through to PrepareFixAttempt (S1 unhealthy seats). */
  readonly unhealthySeatIds?: readonly string[];
  readonly nowIso?: string;
}

export type PreparePullRequestFeedbackFixResult =
  | {
      readonly outcome: 'prepared';
      readonly key: string;
      readonly fixAttemptId: string;
      readonly findingCount: number;
    }
  | {
      readonly outcome: 'already-prepared';
      readonly key: string;
      readonly fixAttemptId: string;
      readonly findingCount: number;
    }
  | {
      readonly outcome: 'refused';
      readonly code: PreparePullRequestFeedbackFixCode;
      readonly detail?: string;
    };

export interface PushPullRequestFeedbackFixRequest {
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly pullRequestNumber: number;
  readonly branchName: string;
  /** The head the round started from. */
  readonly expectedHeadSha: string;
  /** The head the fix attempt produced. */
  readonly fixedHeadSha: string;
  readonly workOrderId: string;
  /** The fix attempt. */
  readonly attemptId: string;
  /** The run's grant id (ids only). */
  readonly grantId: string;
  readonly nowIso?: string;
}

export type PushPullRequestFeedbackFixResult =
  | { readonly outcome: 'pushed'; readonly key: string; readonly headSha: string }
  | { readonly outcome: 'already-pushed'; readonly key: string; readonly headSha: string }
  | {
      readonly outcome: 'ambiguous';
      readonly key: string;
      readonly headSha: string;
      readonly code: 'forge-ambiguous';
    }
  | {
      readonly outcome: 'refused';
      readonly key: string | null;
      readonly headSha: string | null;
      readonly code: PreparePullRequestFeedbackFixCode;
      readonly detail?: string;
    };

export interface PreparePullRequestFeedbackFixPort {
  /** Prepare one fix round from the pull request's unresolved review threads at the current head. */
  preparePullRequestFeedbackFix(
    request: PreparePullRequestFeedbackFixRequest,
  ): Promise<PreparePullRequestFeedbackFixResult>;

  /** Push the fixed head through `push-to-pr` only; never resolves a thread. */
  pushPullRequestFeedbackFix(
    request: PushPullRequestFeedbackFixRequest,
  ): Promise<PushPullRequestFeedbackFixResult>;
}
