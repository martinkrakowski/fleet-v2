// @generated use-case scaffold — refined for step 4.
/**
 * AssessHeadAcceptanceUseCase evaluates every required check, the independent
 * review and the forge state against one exact head, then issues a scoped
 * acceptance receipt or an explicit blocker list. It never merges: a changed
 * head or policy revision makes prior evidence stale instead of accepted.
 */

import type { EvidenceAssessmentRecord, ReviewReceiptRecord } from '../../domain/evidence-records.js';
import { EvidenceAssessment } from '../../domain/entities/EvidenceAssessment.js';
import type { EvidenceAssessmentRepositoryPort } from '../ports/out/EvidenceAssessmentRepositoryPort.out-port.js';
import type { ForgeEvidencePort } from '../ports/out/ForgeEvidencePort.out-port.js';
import type { AssessmentStateValue } from '../../domain/value-objects/AssessmentState.vo.js';
import type {
  AssessHeadAcceptancePort,
  AssessHeadAcceptanceRequest,
  AssessHeadAcceptanceResult,
} from '../ports/in/AssessHeadAcceptancePort.in-port.js';

export interface AssessHeadAcceptanceDependencies {
  readonly repo: EvidenceAssessmentRepositoryPort;
  readonly forgeEvidence?: ForgeEvidencePort;
}

const NOT_IMPLEMENTED = 'Not implemented: AssessHeadAcceptanceUseCase';

const PASSING_RESULTS: readonly string[] = ['pass', 'not-applicable'];

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Required checks without a completed, passing receipt for this exact head. */
function collectCheckBlockers(assessment: EvidenceAssessmentRecord): readonly string[] {
  const blockers: string[] = [];
  for (const check of assessment.requiredChecks) {
    const receipt = assessment.verificationReceipts.find(
      (candidate) =>
        candidate.procedureName === check &&
        candidate.candidateHeadSha === assessment.candidateHeadSha,
    );
    if (receipt === undefined) {
      blockers.push(`required check '${check}' has no completed verification receipt`);
      continue;
    }
    if (!PASSING_RESULTS.includes(receipt.result)) {
      blockers.push(`required check '${check}' completed as '${receipt.result}'`);
    }
  }
  return blockers;
}

/** At least one attributable read-only review that passed for this head. */
function collectReviewBlockers(assessment: EvidenceAssessmentRecord): readonly string[] {
  const reviews: readonly ReviewReceiptRecord[] = assessment.reviewReceipts.filter(
    (receipt) => receipt.candidateHeadSha === assessment.candidateHeadSha,
  );
  const passing = reviews.some(
    (receipt) => receipt.readOnlyVerified && receipt.result === 'pass',
  );
  if (reviews.length === 0) {
    return ['no independent review was recorded for this candidate head'];
  }
  return passing ? [] : ['no read-only independent review passed for this candidate head'];
}

/** Unresolved findings block acceptance until they are fixed or refuted. */
function collectFindingBlockers(assessment: EvidenceAssessmentRecord): readonly string[] {
  const resolved = new Set(
    assessment.findingDispositions
      .filter((disposition) => disposition.state !== 'unresolved')
      .map((disposition) => disposition.findingId),
  );
  const blockers: string[] = [];
  for (const receipt of assessment.reviewReceipts) {
    for (const finding of receipt.findings) {
      if (finding.state === 'unresolved' && !resolved.has(finding.findingId)) {
        blockers.push(`finding '${finding.findingId}' is unresolved`);
      }
    }
  }
  return blockers;
}

export class AssessHeadAcceptanceUseCase implements AssessHeadAcceptancePort {
  constructor(private readonly deps?: AssessHeadAcceptanceDependencies) {}

  /** Generic entry point kept for callers that hold an untyped use case. */
  async execute(input: unknown): Promise<AssessHeadAcceptanceResult> {
    return this.run(input as AssessHeadAcceptanceRequest | undefined);
  }

  async assessHeadAcceptance(request: AssessHeadAcceptanceRequest): Promise<AssessHeadAcceptanceResult> {
    return this.run(request);
  }

  private async run(request?: AssessHeadAcceptanceRequest): Promise<AssessHeadAcceptanceResult> {
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
      !isNonEmptyTrimmedString(request.candidateHeadSha) ||
      !isNonEmptyTrimmedString(request.policyRevision)
    ) {
      return {
        outcome: 'rejected',
        reason: 'Acceptance requires an assessmentId, a candidateHeadSha, and a policyRevision',
      };
    }

    const assessment = await deps.repo.findAssessmentById(request.assessmentId);
    if (assessment === null) {
      return { outcome: 'rejected', reason: 'Assessment not found' };
    }

    const nowIso = isNonEmptyTrimmedString(request.nowIso) ? request.nowIso : new Date().toISOString();

    if (assessment.state === 'stale') {
      return { outcome: 'stale', reason: 'Assessment is stale and cannot be accepted' };
    }
    if (assessment.state === 'accepted') {
      if (
        assessment.candidateHeadSha === request.candidateHeadSha &&
        assessment.policyRevision === request.policyRevision
      ) {
        return {
          outcome: 'accepted',
          receiptId: assessment.acceptanceReceiptId ?? '',
          candidateHeadSha: assessment.candidateHeadSha,
          assessment,
        };
      }
      return {
        outcome: 'rejected',
        reason: `Assessment is already in terminal state '${assessment.state}'`,
      };
    }
    if (assessment.state === 'rejected') {
      return {
        outcome: 'rejected',
        reason: `Assessment is already in terminal state '${assessment.state}'`,
      };
    }

    // A changed head or policy revision invalidates the evidence collected so
    // far; it never carries over as acceptance.
    const policyChanged = assessment.policyRevision !== request.policyRevision;
    if (assessment.candidateHeadSha !== request.candidateHeadSha || policyChanged) {
      const aggregate = EvidenceAssessment.fromRecord(assessment);
      aggregate.markStale(nowIso);
      await deps.repo.saveAssessment(aggregate.toRecord());
      return { outcome: 'stale', reason: 'Candidate head or policy revision changed' };
    }

    const blockers: string[] = [
      ...collectCheckBlockers(assessment),
      ...collectReviewBlockers(assessment),
      ...collectFindingBlockers(assessment),
    ];

    if (deps.forgeEvidence !== undefined) {
      const status = await deps.forgeEvidence.readForgeCheckStatus({
        candidateHeadSha: assessment.candidateHeadSha,
      });
      if (!PASSING_RESULTS.includes(status.ciState)) {
        blockers.push(`forge reports CI state '${status.ciState}' for this candidate head`);
      }
      if (status.unresolvedThreadCount === null) {
        blockers.push('forge could not read review threads for this candidate head');
      } else if (status.unresolvedThreadCount > 0) {
        blockers.push(
          `forge reports ${status.unresolvedThreadCount} unresolved review thread(s) for this candidate head`,
        );
      }
    }

    const aggregate = EvidenceAssessment.fromRecord(assessment);
    if (blockers.length > 0) {
      aggregate.block(blockers, nowIso);
      const updated: EvidenceAssessmentRecord = {
        ...aggregate.toRecord(),
        acceptanceReceiptId: null,
        state: 'blocked' as AssessmentStateValue,
      };
      await deps.repo.saveAssessment(updated);
      return { outcome: 'blocked', blockers, assessment: updated };
    }

    const receiptId = `acc-${assessment.id}-${assessment.candidateHeadSha.slice(0, 8)}`;
    aggregate.accept(receiptId, nowIso);
    const accepted = aggregate.toRecord();
    await deps.repo.saveAssessment(accepted);
    return {
      outcome: 'accepted',
      receiptId,
      candidateHeadSha: assessment.candidateHeadSha,
      assessment: accepted,
    };
  }
}