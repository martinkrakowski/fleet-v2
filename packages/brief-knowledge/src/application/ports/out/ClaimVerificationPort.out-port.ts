// @generated outbound contract scaffold — refined for migration step 5.
/**
 * ClaimVerificationPort: perform a bounded allow-listed check selected by
 * the orchestrator and return evidence, not model confidence. The claim
 * text is treated as data — instructions inside a note are never executed.
 */

import type { KnowledgeVerificationValue } from '../../../domain/value-objects/KnowledgeVerification.vo.js';

export interface VerifyClaimRequest {
  readonly entryId: string;
  readonly claimText: string;
  readonly procedureName: string;
  readonly targetPath?: string;
}

export interface VerifyClaimResult {
  readonly verification: KnowledgeVerificationValue;
  readonly evidenceRef: string;
}

export interface ClaimVerificationPort {
  /** Run one allow-listed procedure and return its outcome with an evidence reference. */
  verifyClaim(request: VerifyClaimRequest): Promise<VerifyClaimResult>;
}
