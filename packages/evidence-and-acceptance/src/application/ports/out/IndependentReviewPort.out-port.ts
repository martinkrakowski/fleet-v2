// @generated outbound contract scaffold — refined for step 4.
/**
 * Obtain an attributable read-only review from the configured independent
 * seat; transport and provider selection belong to the adapter.
 */

import type { EvidenceResultValue } from '../../../domain/value-objects/EvidenceResult.vo.js';
import type {
  ReviewFindingRecord,
  ReviewKind,
} from '../../../domain/evidence-records.js';

export interface RunIndependentReviewRequest {
  readonly attemptId: string;
  readonly candidateHeadSha: string;
  readonly implementerModel: string;
  readonly reviewerModel: string;
  readonly diffSummary?: string;
  /** The review kind for conductor requests; a manual review carries no kind. */
  readonly kind?: ReviewKind;
  /** The frozen brief for a brief-check request; only meaningful with `kind`. */
  readonly briefText?: string;
}

export type RunIndependentReviewResult =
  | {
      readonly outcome: 'completed';
      readonly readOnlyVerified: boolean;
      readonly result: EvidenceResultValue;
      readonly findings: readonly ReviewFindingRecord[];
      readonly rawOutput: string;
      readonly completedAtIso: string;
    }
  | { readonly outcome: 'unavailable'; readonly reason: string };

export interface IndependentReviewPort {
  runIndependentReview(request: RunIndependentReviewRequest): Promise<RunIndependentReviewResult>;
}
