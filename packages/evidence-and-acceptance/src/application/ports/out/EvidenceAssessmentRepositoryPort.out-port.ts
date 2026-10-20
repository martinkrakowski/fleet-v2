// @generated outbound contract scaffold — refined for step 4.
/**
 * Persist assessments and child receipts with revision-aware updates.
 */

import type { EvidenceAssessmentRecord } from '../../../domain/evidence-records.js';

/**
 * A save the store refused because the record's revision is stale or conflicts
 * with the revision it freshly read: another writer moved the record first.
 * It is a lost race, not a malformed record, so a use case maps it to a typed
 * outcome instead of letting an adapter error cross the boundary.
 */
export class EvidenceAssessmentRevisionConflictError extends Error {
  /** Id of the assessment whose revision moved under the writer. */
  readonly assessmentId: string;
  /** Revision the caller attempted to write. */
  readonly attemptedRevision: number;

  constructor(assessmentId: string, attemptedRevision: number, reason: string) {
    super(reason);
    this.name = 'EvidenceAssessmentRevisionConflictError';
    this.assessmentId = assessmentId;
    this.attemptedRevision = attemptedRevision;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface EvidenceAssessmentRepositoryPort {
  saveAssessment(record: EvidenceAssessmentRecord): Promise<void>;
  findAssessmentById(assessmentId: string): Promise<EvidenceAssessmentRecord | null>;
  findAssessmentByHead(candidateHeadSha: string): Promise<EvidenceAssessmentRecord | null>;
}
