// @generated inbound contract scaffold — refined for step 4.
/**
 * Evaluate every required check and finding against the current head and
 * policy; issue a scoped acceptance receipt or explicit blockers. Never
 * performs a merge.
 *
 * The request carries coordinates only. Owner decision references are not a
 * request field: acceptance reads them from the attempt record through a port,
 * so a caller can never name the one-way doors it is being judged against.
 *
 * Blockers carry a kind (`AcceptanceBlockerKind`); the text is for display only.
 */

import type { AcceptanceBlocker } from '../../../domain/acceptance-blockers.js';
import type { EvidenceAssessmentRecord } from '../../../domain/evidence-records.js';
import type { ReviewTally } from '../../../domain/review-selection.js';

export interface AssessHeadAcceptanceRequest {
  readonly assessmentId: string;
  readonly candidateHeadSha: string;
  readonly policyRevision: string;
  readonly nowIso?: string;
}

export type AssessHeadAcceptanceResult =
  | { readonly outcome: 'accepted'; readonly receiptId: string; readonly candidateHeadSha: string; readonly assessment: EvidenceAssessmentRecord; readonly reviewTally?: ReviewTally }
  | {
      readonly outcome: 'blocked';
      /** Display texts, unchanged; `blockers[i]` is `blockerDetails[i].text`. */
      readonly blockers: readonly string[];
      /** The same blockers with their kinds (A11), in the same order. Decide on `kind`, never on text. */
      readonly blockerDetails: readonly AcceptanceBlocker[];
      readonly assessment?: EvidenceAssessmentRecord;
      readonly reviewTally?: ReviewTally;
    }
  | { readonly outcome: 'stale'; readonly reason: string }
  | { readonly outcome: 'rejected'; readonly reason: string };

/**
 * The result of a receipts-only head assessment. It never carries
 * `accepted`: a receipts pass is the conductor's pre-PR evidence, not an
 * acceptance, and is never stored as one. Every merge decision uses
 * `assessHeadAcceptance`.
 */
export type AssessHeadReceiptsResult =
  | {
      readonly outcome: 'receipts-passed';
      readonly receiptsId: string;
      readonly candidateHeadSha: string;
      // No assessment record: a stored acceptance (state, acceptance receipt
      // id) never travels through the receipts-only result.
      readonly reviewTally?: ReviewTally;
    }
  | Extract<AssessHeadAcceptanceResult, { outcome: 'blocked' | 'stale' | 'rejected' }>;

export interface AssessHeadAcceptancePort {
  assessHeadAcceptance(request: AssessHeadAcceptanceRequest): Promise<AssessHeadAcceptanceResult>;
  /**
   * Receipts-only head assessment (checks, reviews, findings, doors), for the
   * conductor's pre-PR step. It skips the forge read only — no pull request
   * exists yet — and never stores `accepted`. Every merge decision uses
   * `assessHeadAcceptance`.
   */
  assessHeadReceipts(request: AssessHeadAcceptanceRequest): Promise<AssessHeadReceiptsResult>;
}