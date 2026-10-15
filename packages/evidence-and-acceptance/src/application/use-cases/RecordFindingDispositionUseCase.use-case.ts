// @generated use-case scaffold — refined for step 4.
/**
 * RecordFindingDispositionUseCase resolves one finding with a fix or an
 * evidence-backed refutation for the exact head it was raised against. Only the
 * named finding changes: unrelated unresolved findings keep blocking.
 */

import type { EvidenceAssessmentRecord, ReviewFindingRecord } from '../../domain/evidence-records.js';
import { EvidenceAssessment } from '../../domain/entities/EvidenceAssessment.js';
import type { EvidenceAssessmentRepositoryPort } from '../ports/out/EvidenceAssessmentRepositoryPort.out-port.js';
import type {
  RecordFindingDispositionPort,
  RecordFindingDispositionRequest,
  RecordFindingDispositionResult,
} from '../ports/in/RecordFindingDispositionPort.in-port.js';

export interface RecordFindingDispositionDependencies {
  readonly repo: EvidenceAssessmentRepositoryPort;
}

const NOT_IMPLEMENTED = 'Not implemented: RecordFindingDispositionUseCase';

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Apply the disposition to the named finding only; other findings are kept. */
function applyDisposition(
  receiptFindings: readonly ReviewFindingRecord[],
  findingId: string,
  state: 'fixed' | 'refuted',
  reason: string,
  evidenceRef: string,
): readonly ReviewFindingRecord[] {
  return receiptFindings.map((finding) =>
    finding.findingId === findingId
      ? { ...finding, state, dispositionReason: reason, dispositionEvidenceRef: evidenceRef }
      : { ...finding },
  );
}

export class RecordFindingDispositionUseCase implements RecordFindingDispositionPort {
  constructor(private readonly deps?: RecordFindingDispositionDependencies) {}

  /** Generic entry point kept for callers that hold an untyped use case. */
  async execute(input: unknown): Promise<RecordFindingDispositionResult> {
    return this.run(input as RecordFindingDispositionRequest | undefined);
  }

  async recordFindingDisposition(
    request: RecordFindingDispositionRequest,
  ): Promise<RecordFindingDispositionResult> {
    return this.run(request);
  }

  private async run(
    request?: RecordFindingDispositionRequest,
  ): Promise<RecordFindingDispositionResult> {
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

    if (
      !isNonEmptyTrimmedString(request.assessmentId) ||
      typeof request.disposition !== 'object' ||
      request.disposition === null
    ) {
      return { outcome: 'rejected', reason: 'Recording requires an assessmentId and a disposition' };
    }
    const disposition = request.disposition;
    const dispositionState = disposition.state;

    const assessment = await deps.repo.findAssessmentById(request.assessmentId);
    if (assessment === null) {
      return { outcome: 'rejected', reason: 'Assessment not found' };
    }
    if (dispositionState !== 'fixed' && dispositionState !== 'refuted') {
      return {
        outcome: 'rejected',
        reason: 'A finding must be resolved as fixed or refuted; an unresolved state is not a disposition',
      };
    }
    if (
      !isNonEmptyTrimmedString(disposition.reason) ||
      !isNonEmptyTrimmedString(disposition.evidenceRef)
    ) {
      return {
        outcome: 'rejected',
        reason: 'A finding disposition requires a reason and an evidence reference',
      };
    }
    if (disposition.candidateHeadSha !== assessment.candidateHeadSha) {
      return {
        outcome: 'rejected',
        reason: `Finding disposition belongs to head ${disposition.candidateHeadSha}, not the assessed head ${assessment.candidateHeadSha}`,
      };
    }
    if (disposition.assessmentId !== assessment.id) {
      return {
        outcome: 'rejected',
        reason: `Finding disposition belongs to assessment ${disposition.assessmentId}, not ${assessment.id}`,
      };
    }
    if (
      !isNonEmptyTrimmedString(disposition.findingId) ||
      !assessment.reviewReceipts.some((receipt) =>
        receipt.findings.some((finding) => finding.findingId === disposition.findingId),
      )
    ) {
      return {
        outcome: 'rejected',
        reason: `No finding '${disposition.findingId}' was raised for assessment ${assessment.id}`,
      };
    }

    const updated: EvidenceAssessmentRecord = {
      ...assessment,
      reviewReceipts: assessment.reviewReceipts.map((receipt) => ({
        ...receipt,
        findings: applyDisposition(
          receipt.findings,
          disposition.findingId,
          dispositionState,
          disposition.reason,
          disposition.evidenceRef,
        ),
      })),
      findingDispositions: [...assessment.findingDispositions, { ...disposition }],
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