/**
 * Shared evidence records used by more than one contract. They are pure domain
 * facts, not outbound port behaviour, so they live here rather than in any
 * single port module.
 */

import type { EvidenceResultValue } from './value-objects/EvidenceResult.vo.js';
import type { FindingStateValue } from './value-objects/FindingState.vo.js';
import type { AssessmentStateValue } from './value-objects/AssessmentState.vo.js';

/** Serializable record of one completed verification-host check. */
export interface VerificationReceiptRecord {
  readonly id: string;
  readonly assessmentId: string;
  readonly projectId: string;
  readonly attemptId: string;
  readonly candidateHeadSha: string;
  readonly hostId: string;
  readonly procedureName: string;
  readonly result: EvidenceResultValue;
  readonly exitCode: number | null;
  readonly evidenceRef: string;
  readonly policyRevision: string;
  readonly completedAtIso: string;
}

/** Severity of one reviewer finding. */
export type FindingSeverity = 'blocker' | 'major' | 'minor' | 'nit';

/** Serializable record of one finding raised by an independent review. */
export interface ReviewFindingRecord {
  readonly findingId: string;
  readonly severity: FindingSeverity;
  readonly summary: string;
  readonly filePath: string | null;
  readonly line: number | null;
  readonly state: FindingStateValue;
  readonly dispositionReason: string | null;
  readonly dispositionEvidenceRef: string | null;
}

/** Serializable record of one attributable independent review of an exact head. */
export interface ReviewReceiptRecord {
  readonly id: string;
  readonly assessmentId: string;
  readonly projectId: string;
  readonly attemptId: string;
  readonly candidateHeadSha: string;
  readonly reviewerModel: string;
  readonly implementerModel: string;
  readonly readOnlyVerified: boolean;
  readonly result: EvidenceResultValue;
  readonly findings: readonly ReviewFindingRecord[];
  readonly evidenceRef: string;
  readonly policyRevision: string;
  readonly completedAtIso: string;
}

/** Serializable record of one fix or evidence-backed refutation of a finding. */
export interface FindingDispositionRecord {
  readonly id: string;
  readonly assessmentId: string;
  readonly findingId: string;
  readonly candidateHeadSha: string;
  readonly state: FindingStateValue;
  readonly reason: string;
  readonly evidenceRef: string;
  readonly recordedBy: string;
  readonly recordedAtIso: string;
}

/**
 * Serializable aggregate record of one acceptance assessment with its child
 * receipts, dispositions and derived blockers.
 */
export interface EvidenceAssessmentRecord {
  readonly id: string;
  readonly projectId: string;
  readonly attemptId: string;
  readonly candidateHeadSha: string;
  readonly policyRevision: string;
  /**
   * The implementer seat the assessment's attempt was dispatched on, recorded
   * at assessment creation from the attempt itself. It is the independence
   * reference every review receipt is checked against.
   */
  readonly implementerModel: string;
  /**
   * The reviewer the last request-review named; a recorded review receipt must
   * name the same model. Absent when no review was requested.
   */
  readonly requestedReviewerModel?: string;
  readonly requiredChecks: readonly string[];
  readonly state: AssessmentStateValue;
  /**
   * Forge evidence state recorded at acceptance time (D6). `not-configured`
   * is a distinct value, legal only when the installation's forge mode is
   * `none`; it is never `unknown` and never satisfies a CI-state requirement.
   */
  readonly forgeEvidence?: 'not-configured';
  readonly verificationReceipts: readonly VerificationReceiptRecord[];
  readonly reviewReceipts: readonly ReviewReceiptRecord[];
  readonly findingDispositions: readonly FindingDispositionRecord[];
  readonly acceptanceReceiptId: string | null;
  readonly blockers: readonly string[];
  readonly revision: number;
  readonly updatedAtIso: string;
}
