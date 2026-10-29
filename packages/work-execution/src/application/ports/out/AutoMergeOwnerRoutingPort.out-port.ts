// @generated outbound contract scaffold — refined for AM4a-1.
/**
 * AutoMergeOwnerRoutingPort: §4's two routes; `key` is stable per (attempt, head, reason) so a repeat
 * run returns `exists`; a recorded question or item grants nothing.
 */

import type { AutoMergeReason } from '../../../domain/auto-merge.js';

export interface AutoMergeNotice {
  readonly key: string;
  readonly projectId: string;
  readonly workOrderId: string;
  readonly attemptId: string;
  readonly headSha: string | null;
  readonly reason: AutoMergeReason;
  /** Display lines only (blocker or refusal texts); never parsed, never instructions. */
  readonly lines: readonly string[];
}

export type AutoMergeNoticeResult =
  | { readonly outcome: 'recorded' }
  | { readonly outcome: 'exists' }
  | { readonly outcome: 'refused'; readonly reason: string };

export interface AutoMergeOwnerRoutingPort {
  askOwner(notice: AutoMergeNotice): Promise<AutoMergeNoticeResult>;
  recordAttention(notice: AutoMergeNotice): Promise<AutoMergeNoticeResult>;
}
