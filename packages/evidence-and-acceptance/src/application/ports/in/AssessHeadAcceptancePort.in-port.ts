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

export interface AssessHeadAcceptancePort {
  assessHeadAcceptance(request: AssessHeadAcceptanceRequest): Promise<AssessHeadAcceptanceResult>;
}