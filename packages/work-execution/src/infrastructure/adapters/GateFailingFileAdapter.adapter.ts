/**
 * GateFailingFileAdapter implements GateFailingFilePort by in-process
 * delegation to the evidence context's inspection use case (the same read
 * `AcceptanceReceiptReadAdapter` uses). The assessment must match the attempt
 * and the head; of its failing verification receipts at that head the latest
 * one that names a file supplies it, screened again. A missing assessment, no
 * failing receipt or no named file reads as `found` with `null`; an unbound
 * delegate or a thrown read reads as `unavailable`. Never throws.
 */

import {
  assessmentIdForAttempt,
  screenFailingFile,
  type InspectAcceptanceEvidencePort,
} from '@fleet/evidence-and-acceptance';

import type {
  GateFailingFilePort,
  ReadGateFailingFileRequest,
  ReadGateFailingFileResult,
} from '../../application/ports/out/GateFailingFilePort.out-port.js';

export interface GateFailingFileDelegate {
  readonly inspector?: Pick<InspectAcceptanceEvidencePort, 'inspectAcceptanceEvidence'>;
}

export class GateFailingFileAdapter implements GateFailingFilePort {
  constructor(private readonly delegate?: GateFailingFileDelegate) {}

  async readGateFailingFile(request: ReadGateFailingFileRequest): Promise<ReadGateFailingFileResult> {
    const inspector = this.delegate?.inspector;
    if (inspector === undefined) {
      return { outcome: 'unavailable' };
    }
    try {
      const attemptId: unknown = request.attemptId;
      const headSha: unknown = request.headSha;
      if (typeof attemptId !== 'string' || attemptId.length === 0 || typeof headSha !== 'string' || headSha.length === 0) {
        return { outcome: 'found', failingFile: null };
      }
      const found = await inspector.inspectAcceptanceEvidence({
        assessmentId: assessmentIdForAttempt(attemptId),
        candidateHeadSha: headSha,
      });
      if (found.outcome !== 'found') {
        return { outcome: 'found', failingFile: null };
      }
      const assessment = found.assessment;
      if (assessment.attemptId !== attemptId || assessment.candidateHeadSha !== headSha) {
        return { outcome: 'found', failingFile: null };
      }
      const failing = assessment.verificationReceipts.filter(
        (receipt) => receipt.result === 'fail' && receipt.candidateHeadSha === headSha,
      );
      for (let index = failing.length - 1; index >= 0; index -= 1) {
        const file = screenFailingFile(failing[index]?.failingFile);
        if (file !== null) {
          return { outcome: 'found', failingFile: file };
        }
      }
      return { outcome: 'found', failingFile: null };
    } catch {
      return { outcome: 'unavailable' };
    }
  }
}
