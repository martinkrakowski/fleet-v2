// @generated adapter stub — signature-matched for step 4 (no behaviour).
/**
 * EvidenceAssessmentRepositoryAdapter implements EvidenceAssessmentRepositoryPort.
 * Behaviour lands with the station implementation; every method refuses.
 */

import type {
  EvidenceAssessmentRecord,
} from '../../domain/evidence-records.js';
import type { EvidenceAssessmentRepositoryPort } from '../../application/ports/out/EvidenceAssessmentRepositoryPort.out-port.js';

export class EvidenceAssessmentRepositoryAdapter implements EvidenceAssessmentRepositoryPort {
  async saveAssessment(_record: EvidenceAssessmentRecord): Promise<void> {
    throw new Error('Not implemented: EvidenceAssessmentRepositoryAdapter.saveAssessment');
  }

  async findAssessmentById(_assessmentId: string): Promise<EvidenceAssessmentRecord | null> {
    throw new Error('Not implemented: EvidenceAssessmentRepositoryAdapter.findAssessmentById');
  }

  async findAssessmentByHead(_candidateHeadSha: string): Promise<EvidenceAssessmentRecord | null> {
    throw new Error('Not implemented: EvidenceAssessmentRepositoryAdapter.findAssessmentByHead');
  }
}
