// @generated outbound contract scaffold — refined for migration step 1.
/**
 * ForgeActionPort: perform permitted credential-bearing PR and merge
 * operations through stable action IDs and explicit expected-head checks.
 * Credentials stay in the adapter's environment; lanes never see them. An
 * ambiguous response is reported for reconciliation, never guessed. Every
 * refusal names its kind; an unrecognised one is `other`.
 */

import type { ForgeRefusalKind } from '../../../domain/coordination-keys.js';

export interface ForgeActionRequest {
  readonly actionId: string;
  readonly attemptId: string;
  readonly workOrderId: string;
  readonly kind: 'push-and-open-pr' | 'merge-pr';
  readonly expectedHeadSha: string;
  readonly branchName: string;
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
