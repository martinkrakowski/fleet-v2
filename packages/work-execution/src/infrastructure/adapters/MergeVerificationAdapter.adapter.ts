// Implemented adapter — merge verification station (DT8).
/**
 * MergeVerificationAdapter implements MergeVerificationPort by in-process
 * delegation to the evidence context's inspection and request use cases.
 *
 * Identity, not head-only: the lookup is attempt-bound through
 * `assessmentIdForAttempt`, and a receipt verifies only when the assessment
 * and receipt match the expected assessment id, project, attempt, exact head
 * and policy revision, the required procedure, and a passing result. Evidence
 * records carry no repository identity; repository scope comes from the
 * trusted queue-entry-to-attempt relationship the merge-pass caller resolves
 * before invoking this adapter.
 *
 * Every failure mode is `unknown` with a lowercase reason code, never an
 * assumed pass. The budget rule is enforced before each evidence call: a call
 * with under 2 seconds remaining is not started, and the deadline is forwarded
 * through the verification request so the procedure executor bounds itself.
 */

import { assessmentIdForAttempt, type EvidenceAssessmentRecord, type InspectAcceptanceEvidencePort, type InspectAcceptanceEvidenceResult, type RequestVerificationPort, type RequestVerificationResult } from '@fleet/evidence-and-acceptance';
import { computeCallBudget } from '../../domain/daemon-tick.js';
import type {
  MergeVerificationPort,
  MergeVerificationReadRequest,
  MergeVerificationReasonCode,
  MergeVerificationResult,
  MergeVerificationTriggerRequest,
} from '../../application/ports/out/MergeVerificationPort.out-port.js';

/** Normal wall-clock budget for one evidence call; the deadline bounds it. */
const VERIFICATION_NORMAL_TIMEOUT_MS = 30 * 60 * 1000;

export type MergeVerificationClock = () => Date | number | string;

export interface MergeVerificationDelegate {
  readonly inspector?: Pick<InspectAcceptanceEvidencePort, 'inspectAcceptanceEvidence'>;
  readonly requester?: Pick<RequestVerificationPort, 'requestVerification'>;
  readonly clock?: MergeVerificationClock;
}

function clockToIso(clock: MergeVerificationClock): string {
  const value = clock();
  if (typeof value === 'string') {
    return value;
  }
  return new Date(value).toISOString();
}

function unknownResult(reasonCode: MergeVerificationReasonCode): MergeVerificationResult {
  return { outcome: 'unknown', reasonCode };
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export class MergeVerificationAdapter implements MergeVerificationPort {
  private readonly clock: MergeVerificationClock;

  constructor(
    private readonly delegate?: MergeVerificationDelegate,
    clock?: MergeVerificationClock,
  ) {
    this.clock = clock ?? delegate?.clock ?? (() => new Date());
  }

  async readVerification(request: MergeVerificationReadRequest): Promise<MergeVerificationResult> {
    const inspector = this.delegate?.inspector;
    if (inspector === undefined) {
      throw new Error('Not implemented: MergeVerificationAdapter.readVerification');
    }
    const attemptId = request.attemptId;
    if (!isNonEmptyTrimmedString(attemptId)) {
      return unknownResult('no-attempt-identity');
    }
    if (!this.budgetAllows(request)) {
      return unknownResult('budget-exhausted');
    }
    let inspected: InspectAcceptanceEvidenceResult;
    try {
      inspected = await inspector.inspectAcceptanceEvidence({
        assessmentId: assessmentIdForAttempt(attemptId),
        candidateHeadSha: request.headOid,
      });
    } catch {
      return unknownResult('evidence-unreadable');
    }
    if (inspected.outcome !== 'found') {
      return unknownResult('no-receipt');
    }
    return this.resolveFromAssessment(inspected.assessment, request);
  }

  async runVerification(request: MergeVerificationTriggerRequest): Promise<MergeVerificationResult> {
    const requester = this.delegate?.requester;
    if (requester === undefined) {
      throw new Error('Not implemented: MergeVerificationAdapter.runVerification');
    }
    const attemptId = request.attemptId;
    if (!isNonEmptyTrimmedString(attemptId)) {
      return unknownResult('no-attempt-identity');
    }
    if (!this.budgetAllows(request)) {
      return unknownResult('budget-exhausted');
    }
    let result: RequestVerificationResult;
    try {
      result = await requester.requestVerification({
        assessmentId: assessmentIdForAttempt(attemptId),
        projectId: request.projectId,
        attemptId,
        candidateHeadSha: request.headOid,
        policyRevision: request.policyRevision,
        hostId: request.hostId,
        implementerModel: request.implementerModel,
        requiredChecks: [...request.requiredChecks],
        deadlineIso: request.deadlineIso,
      });
    } catch {
      return unknownResult('evidence-unreadable');
    }
    if (result.outcome === 'rejected') {
      return unknownResult('evidence-unreadable');
    }
    if (result.outcome === 'not-started') {
      return unknownResult('budget-exhausted');
    }
    return this.resolveFromAssessment(result.assessment, request);
  }

  private resolveFromAssessment(
    assessment: EvidenceAssessmentRecord,
    request: MergeVerificationReadRequest,
  ): MergeVerificationResult {
    const attemptId = request.attemptId;
    if (!isNonEmptyTrimmedString(attemptId)) {
      return unknownResult('no-attempt-identity');
    }
    const expectedAssessmentId = assessmentIdForAttempt(attemptId);
    if (
      assessment.id !== expectedAssessmentId ||
      assessment.attemptId !== attemptId ||
      assessment.projectId !== request.projectId
    ) {
      return unknownResult('evidence-unreadable');
    }
    if (assessment.candidateHeadSha !== request.headOid) {
      return unknownResult('other-head-receipt');
    }
    if (assessment.policyRevision !== request.policyRevision) {
      return unknownResult('receipt-failed');
    }
    const receipt = assessment.verificationReceipts.find(
      (candidate) => candidate.procedureName === request.macosProcedure,
    );
    if (receipt === undefined) {
      return unknownResult('no-receipt');
    }
    if (
      receipt.assessmentId !== expectedAssessmentId ||
      receipt.projectId !== request.projectId ||
      receipt.attemptId !== attemptId
    ) {
      return unknownResult('evidence-unreadable');
    }
    if (receipt.candidateHeadSha !== request.headOid) {
      return unknownResult('other-head-receipt');
    }
    if (receipt.policyRevision !== request.policyRevision) {
      return unknownResult('receipt-failed');
    }
    if (receipt.result !== 'pass') {
      return unknownResult('receipt-failed');
    }
    return {
      outcome: 'verified',
      receiptHeadOid: request.headOid,
      receiptId: receipt.id,
      verifiedBy: 'procedure',
    };
  }

  private budgetAllows(request: MergeVerificationReadRequest): boolean {
    const decision = computeCallBudget({
      nowIso: clockToIso(this.clock),
      deadlineIso: request.deadlineIso,
      normalTimeoutMs: VERIFICATION_NORMAL_TIMEOUT_MS,
    });
    return decision.allowed;
  }
}
