// @generated inbound contract scaffold — refined for step 4.
/**
 * Evaluate every required check and finding against the current head and
 * policy; issue a scoped acceptance receipt or explicit blockers. Never
 * performs a merge.
 *
 * The request carries coordinates only. Owner decision references are not a
 * request field: acceptance reads them from the attempt record through a port,
 * so a caller can never name the one-way doors it is being judged against.
 */

import type { EvidenceAssessmentRecord } from '../../../domain/evidence-records.js';

export interface AssessHeadAcceptanceRequest {
  readonly assessmentId: string;
  readonly candidateHeadSha: string;
  readonly policyRevision: string;
  readonly nowIso?: string;
}

export type AssessHeadAcceptanceResult =
  | { readonly outcome: 'accepted'; readonly receiptId: string; readonly candidateHeadSha: string; readonly assessment: EvidenceAssessmentRecord }
  | { readonly outcome: 'blocked'; readonly blockers: readonly string[]; readonly assessment?: EvidenceAssessmentRecord }
  | { readonly outcome: 'stale'; readonly reason: string }
  | { readonly outcome: 'rejected'; readonly reason: string };

export interface AssessHeadAcceptancePort {
  assessHeadAcceptance(request: AssessHeadAcceptanceRequest): Promise<AssessHeadAcceptanceResult>;
}