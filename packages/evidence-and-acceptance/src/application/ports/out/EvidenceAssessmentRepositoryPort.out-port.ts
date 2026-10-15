// @generated outbound contract scaffold — refined for step 4.
/**
 * Persist assessments and child receipts with revision-aware updates.
 */

import type { EvidenceAssessmentRecord } from '../../../domain/evidence-records.js';

export interface EvidenceAssessmentRepositoryPort {
  saveAssessment(record: EvidenceAssessmentRecord): Promise<void>;
  findAssessmentById(assessmentId: string): Promise<EvidenceAssessmentRecord | null>;
  findAssessmentByHead(candidateHeadSha: string): Promise<EvidenceAssessmentRecord | null>;
}
