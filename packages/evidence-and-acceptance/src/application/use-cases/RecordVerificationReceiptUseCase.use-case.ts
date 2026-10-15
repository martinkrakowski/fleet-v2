// @generated use-case scaffold — refined for step 4.
/**
 * RecordVerificationReceiptUseCase retains a completed check against the exact
 * head and acceptance-policy revision it was produced for. Launching a check
 * is not completion, so a pending result is refused rather than recorded.
 */

import type { EvidenceAssessmentRecord } from '../../domain/evidence-records.js';
import { EvidenceAssessment } from '../../domain/entities/EvidenceAssessment.js';
import type { EvidenceAssessmentRepositoryPort } from '../ports/out/EvidenceAssessmentRepositoryPort.out-port.js';
import type {
  RecordVerificationReceiptPort,
  RecordVerificationReceiptRequest,
  RecordVerificationReceiptResult,
} from '../ports/in/RecordVerificationReceiptPort.in-port.js';

export interface RecordVerificationReceiptDependencies {
  readonly repo: EvidenceAssessmentRepositoryPort;
}

const NOT_IMPLEMENTED = 'Not implemented: RecordVerificationReceiptUseCase';

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export class RecordVerificationReceiptUseCase implements RecordVerificationReceiptPort {
  constructor(private readonly deps?: RecordVerificationReceiptDependencies) {}

  /** Generic entry point kept for callers that hold an untyped use case. */
  async execute(input: unknown): Promise<RecordVerificationReceiptResult> {
    return this.run(input as RecordVerificationReceiptRequest | undefined);
  }

  async recordVerificationReceipt(
    request: RecordVerificationReceiptRequest,
  ): Promise<RecordVerificationReceiptResult> {
    return this.run(request);
  }

  private async run(
    request?: RecordVerificationReceiptRequest,
  ): Promise<RecordVerificationReceiptResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error(NOT_IMPLEMENTED);
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body, and an
    // empty object body flows into the validation below as a rejection.
    if (typeof request !== 'object' || request === null) {
      throw new Error(NOT_IMPLEMENTED);
    }
    const deps = this.deps;

    if (!isNonEmptyTrimmedString(request.assessmentId) || typeof request.receipt !== 'object' || request.receipt === null) {
      return { outcome: 'rejected', reason: 'Recording requires an assessmentId and a receipt' };
    }
    const receipt = request.receipt;

    const assessment = await deps.repo.findAssessmentById(request.assessmentId);
    if (assessment === null) {
      return { outcome: 'rejected', reason: 'Assessment not found' };
    }
    if (receipt.candidateHeadSha !== assessment.candidateHeadSha) {
      return {
        outcome: 'rejected',
        reason: `Verification receipt belongs to head ${receipt.candidateHeadSha}, not the assessed head ${assessment.candidateHeadSha}`,
      };
    }
    if (receipt.policyRevision !== assessment.policyRevision) {
      return {
        outcome: 'rejected',
        reason: `Verification receipt was produced under policy revision ${receipt.policyRevision}, not the assessed ${assessment.policyRevision}`,
      };
    }
    if (receipt.result === 'pending') {
      return {
        outcome: 'rejected',
        reason: 'A launched check is not a completed one: a pending result is not evidence',
      };
    }
    if (receipt.assessmentId !== assessment.id) {
      return {
        outcome: 'rejected',
        reason: `Verification receipt belongs to assessment ${receipt.assessmentId}, not ${assessment.id}`,
      };
    }

    // One receipt per procedure: a later completion replaces the earlier one.
    const verificationReceipts = [
      ...assessment.verificationReceipts.filter(
        (existing) => existing.procedureName !== receipt.procedureName,
      ),
      { ...receipt },
    ];
    const updated: EvidenceAssessmentRecord = {
      ...assessment,
      verificationReceipts,
      revision: assessment.revision + 1,
      updatedAtIso: isNonEmptyTrimmedString(request.nowIso) ? request.nowIso : new Date().toISOString(),
    };
    const blockers = EvidenceAssessment.fromRecord(updated).collectBlockers();
    const saved: EvidenceAssessmentRecord = {
      ...updated,
      state: blockers.length > 0 ? 'blocked' : 'pending',
      blockers: [...blockers],
    };
    await deps.repo.saveAssessment(saved);
    return { outcome: 'recorded', assessment: saved };
  }
}