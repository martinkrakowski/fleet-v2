// @generated outbound contract scaffold — refined for migration step 1.
/**
 * ForgeActionPort: perform permitted credential-bearing PR and merge
 * operations through stable action IDs and explicit expected-head checks.
 * Credentials stay in the adapter's environment; lanes never see them. An
 * ambiguous response is reported for reconciliation, never guessed. Every
 * refusal names its kind; an unrecognised one is `other`. The
 * `push-to-pr` kind updates an existing open pull request's branch and
 * never opens a new one.
 */

import type { ForgeActionKind, ForgeRefusalKind } from '../../../domain/coordination-keys.js';

export interface ForgeActionRequest {
  readonly actionId: string;
  readonly attemptId: string;
  readonly workOrderId: string;
  readonly kind: ForgeActionKind;
  readonly expectedHeadSha: string;
  readonly branchName: string;
  /** Known pull request number (e.g. from an earlier push-and-open-pr), when available. */
  readonly pullRequestNumber?: number;
  /** PR title override used only for `push-and-open-pr`; absent keeps the default. */
  readonly title?: string;
  /** PR body override used only for `push-and-open-pr`; absent keeps the default. */
  readonly body?: string;
  /**
   * Status to post for `post-status`: the pre-merge review receipt of the
   * expected head. Only `post-status` may carry it.
   */
  readonly status?: {
    readonly context: 'premerge';
    readonly state: 'success' | 'pending' | 'failure';
    readonly description: string;
  };
}

export type ForgeActionResult =
  | { readonly outcome: 'executed'; readonly pullRequestNumber?: number; readonly headSha: string }
  | { readonly outcome: 'ambiguous'; readonly reason: string }
  | { readonly outcome: 'refused'; readonly reason: string; readonly refusalKind: ForgeRefusalKind };

export interface ForgeActionPort {
  /** Perform one forge action only against the expected head. */
  performForgeAction(request: ForgeActionRequest): Promise<ForgeActionResult>;

  /** Report whether this forge port has an underlying execution delegate configured. */
  isConfigured(): boolean;
}
