// Implemented adapter — telemetry station (cross-context step).
/**
 * AcceptanceReceiptReadAdapter implements AcceptanceReceiptReadPort by
 * in-process delegation to the evidence context's inspection use case. The
 * lookup is attempt-bound: the attempt's own assessment id first, the legacy
 * id second, then the head alone; a found assessment counts only when it
 * matches both the attempt and the head. Every port-facing value is a fresh
 * projection of the receipt records; failure is a value (`unavailable`),
 * never a throw and never a partial result.
 */

import type {
  AcceptanceReceiptReadPort,
  ReadReceiptsForHeadResult,
  ReceiptResult,
  ReceiptReviewKind,
  ReviewReceiptProjection,
  VerificationReceiptProjection,
} from '../../application/ports/out/AcceptanceReceiptReadPort.out-port.js';

import {
  assessmentIdForAttempt,
  type EvidenceAssessmentRecord,
  type InspectAcceptanceEvidencePort,
  type ReviewFindingRecord,
  type ReviewReceiptRecord,
  type VerificationReceiptRecord,
} from '@fleet/evidence-and-acceptance';

import { telemetryHashInput } from '../../domain/run-telemetry-ids.js';

const RECEIPT_RESULTS = ['pending', 'pass', 'fail', 'unknown', 'not-applicable'] as const;
const RECEIPT_REVIEW_KINDS = ['brief-check', 'code-review', 'pre-merge'] as const;

function isKnownReceiptResult(value: unknown): value is ReceiptResult {
  return typeof value === 'string' && (RECEIPT_RESULTS as readonly string[]).includes(value);
}

function isKnownReviewKind(value: unknown): value is ReceiptReviewKind {
  return typeof value === 'string' && (RECEIPT_REVIEW_KINDS as readonly string[]).includes(value);
}

/** A finite integer in −1..255 (the verified exit code band), else null. */
function exitCodeOrNull(value: number | null): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= -1 && value <= 255 ? value : null;
}

/** Count review findings by severity; an unknown severity counts nowhere. */
function countFindings(findings: readonly ReviewFindingRecord[]): ReviewReceiptProjection['findings'] {
  const counts = { blocker: 0, major: 0, minor: 0, nit: 0 };
  for (const finding of findings) {
    if (finding.severity === 'blocker') counts.blocker += 1;
    else if (finding.severity === 'major') counts.major += 1;
    else if (finding.severity === 'minor') counts.minor += 1;
    else if (finding.severity === 'nit') counts.nit += 1;
  }
  return counts;
}

function projectVerification(receipt: VerificationReceiptRecord): VerificationReceiptProjection | null {
  const receiptId = telemetryHashInput(receipt.id);
  if (receiptId === null) {
    return null;
  }
  return {
    receiptId,
    result: isKnownReceiptResult(receipt.result) ? receipt.result : 'unknown',
    exitCode: exitCodeOrNull(receipt.exitCode),
    completedAtIso: receipt.completedAtIso,
  };
}

function projectReview(receipt: ReviewReceiptRecord): ReviewReceiptProjection | null {
  const receiptId = telemetryHashInput(receipt.id);
  if (receiptId === null) {
    return null;
  }
  return {
    receiptId,
    kind: isKnownReviewKind(receipt.kind) ? receipt.kind : 'code-review',
    result: isKnownReceiptResult(receipt.result) ? receipt.result : 'unknown',
    findings: countFindings(receipt.findings),
    completedAtIso: receipt.completedAtIso,
  };
}

function collectProjections<TIn, TOut>(
  inputs: readonly TIn[],
  project: (input: TIn) => TOut | null,
): TOut[] {
  const output: TOut[] = [];
  for (const input of inputs) {
    const projected = project(input);
    if (projected !== null) {
      output.push(projected);
    }
  }
  return output;
}

function matchesAttemptAtHead(attemptId: string, headSha: string, assessment: EvidenceAssessmentRecord): boolean {
  return assessment.attemptId === attemptId && assessment.candidateHeadSha === headSha;
}

export interface AcceptanceReceiptReadDelegate {
  readonly inspector?: Pick<InspectAcceptanceEvidencePort, 'inspectAcceptanceEvidence'>;
}

export class AcceptanceReceiptReadAdapter implements AcceptanceReceiptReadPort {
  constructor(private readonly delegate?: AcceptanceReceiptReadDelegate) {}

  async readReceiptsForHead(attemptId: string, headSha: string): Promise<ReadReceiptsForHeadResult> {
    const inspector = this.delegate?.inspector;
    if (!inspector) {
      throw new Error('Not implemented: AcceptanceReceiptReadAdapter.readReceiptsForHead');
    }
    if (typeof attemptId !== 'string' || attemptId.length === 0 || typeof headSha !== 'string' || headSha.length === 0) {
      return { outcome: 'none' };
    }
    try {
      const assessment = await this.lookupAssessment(inspector, attemptId, headSha);
      if (assessment === null) {
        return { outcome: 'none' };
      }
      return {
        outcome: 'found',
        verification: collectProjections(assessment.verificationReceipts, projectVerification),
        review: collectProjections(assessment.reviewReceipts, projectReview),
      };
    } catch {
      return { outcome: 'unavailable', reason: 'evidence-unreadable' };
    }
  }

  private async lookupAssessment(
    inspector: Pick<InspectAcceptanceEvidencePort, 'inspectAcceptanceEvidence'>,
    attemptId: string,
    headSha: string,
  ): Promise<EvidenceAssessmentRecord | null> {
    const byAttempt = await inspector.inspectAcceptanceEvidence({
      assessmentId: assessmentIdForAttempt(attemptId),
      candidateHeadSha: headSha,
    });
    if (byAttempt.outcome === 'found' && matchesAttemptAtHead(attemptId, headSha, byAttempt.assessment)) {
      return byAttempt.assessment;
    }
    const byLegacy = await inspector.inspectAcceptanceEvidence({
      assessmentId: attemptId,
      candidateHeadSha: headSha,
    });
    if (byLegacy.outcome === 'found' && matchesAttemptAtHead(attemptId, headSha, byLegacy.assessment)) {
      return byLegacy.assessment;
    }
    const byHead = await inspector.inspectAcceptanceEvidence({ candidateHeadSha: headSha });
    if (byHead.outcome === 'found' && matchesAttemptAtHead(attemptId, headSha, byHead.assessment)) {
      return byHead.assessment;
    }
    return null;
  }
}
