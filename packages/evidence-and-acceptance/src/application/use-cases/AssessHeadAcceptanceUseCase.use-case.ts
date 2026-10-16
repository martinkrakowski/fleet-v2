// @generated use-case scaffold — refined for step 4.
/**
 * AssessHeadAcceptanceUseCase evaluates every required check, the independent
 * review, the forge state and the attempt's one-way doors against one exact
 * head, then issues a scoped acceptance receipt or an explicit blocker list. It
 * never merges: a changed head or policy revision makes prior evidence stale
 * instead of accepted.
 *
 * Owner decision references are read from the attempt record through
 * AttemptOwnerDecisionPort, never from the request, and every reference is
 * resolved through OwnerDecisionPort. The door check runs before a stored
 * acceptance is returned, so "already accepted" is never an early return past
 * a door that is now undecided, unknown or unreadable.
 */

import type { EvidenceAssessmentRecord, ReviewReceiptRecord } from '../../domain/evidence-records.js';
import { EvidenceAssessment } from '../../domain/entities/EvidenceAssessment.js';
import type { EvidenceAssessmentRepositoryPort } from '../ports/out/EvidenceAssessmentRepositoryPort.out-port.js';
import type { ForgeEvidencePort } from '../ports/out/ForgeEvidencePort.out-port.js';
import type { OwnerDecisionPort } from '../ports/out/OwnerDecisionPort.out-port.js';
import type { AttemptOwnerDecisionPort } from '../ports/out/AttemptOwnerDecisionPort.out-port.js';
import type {
  AssessHeadAcceptancePort,
  AssessHeadAcceptanceRequest,
  AssessHeadAcceptanceResult,
} from '../ports/in/AssessHeadAcceptancePort.in-port.js';

export interface AssessHeadAcceptanceDependencies {
  readonly repo: EvidenceAssessmentRepositoryPort;
  readonly forgeEvidence?: ForgeEvidencePort;
  readonly ownerDecisionPort?: OwnerDecisionPort;
  /** Reads the one-way doors the frozen brief named for this attempt. */
  readonly attemptOwnerDecisionPort?: AttemptOwnerDecisionPort;
}

const NOT_IMPLEMENTED = 'Not implemented: AssessHeadAcceptanceUseCase';

const PASSING_RESULTS: readonly string[] = ['pass', 'not-applicable'];

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

    // Owner decision references are never a request field: a caller that
    // supplies them is naming the doors it is judged against, which is refused
    // rather than honoured.
    if ('ownerDecisionReferences' in (request as unknown as Record<string, unknown>)) {
      return {
        outcome: 'rejected',
        reason:
          "'ownerDecisionReferences' must not be supplied; owner decisions are read from the attempt record",
      };
    }

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
      if (assessment.state === 'accepted') {
        return {
          outcome: 'rejected',
          reason: `Assessment is already in terminal state '${assessment.state}'`,
        };
      }
      const aggregate = EvidenceAssessment.fromRecord(assessment);
      aggregate.markStale(nowIso);
      await deps.repo.saveAssessment(aggregate.toRecord());
      return { outcome: 'stale', reason: 'Candidate head or policy revision changed' };
    }

    // One-way doors are checked before a stored acceptance is returned: an
    // idempotent "already accepted" read is not a way past a door that is now
    // undecided, unknown or unreadable.
    const doorBlockers = await this.collectOwnerDecisionBlockers(assessment);

    if (assessment.state === 'accepted') {
      if (doorBlockers.length > 0) {
        return await this.block(deps, assessment, doorBlockers, nowIso);
      }
      return {
        outcome: 'accepted',
        receiptId: assessment.acceptanceReceiptId ?? '',
        candidateHeadSha: assessment.candidateHeadSha,
        assessment,
      };
    }

    const blockers: string[] = [
      ...doorBlockers,
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

    if (blockers.length > 0) {
      return await this.block(deps, assessment, blockers, nowIso);
    }

    const receiptId = `acc-${assessment.id}-${assessment.candidateHeadSha.slice(0, 8)}`;
    const aggregate = EvidenceAssessment.fromRecord(assessment);
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

  /**
   * The doors frozen in the attempt's brief package, resolved against this
   * exact head. Anything unreadable, unrecorded or unresolved is a blocker:
   * a door that cannot be seen open has not been shown open.
   */
  private async collectOwnerDecisionBlockers(
    assessment: EvidenceAssessmentRecord,
  ): Promise<readonly string[]> {
    const deps = this.deps;
    if (deps === undefined) {
      return ['owner decision references could not be read: the station is unconfigured'];
    }
    if (deps.attemptOwnerDecisionPort === undefined) {
      return [
        `owner decision references for attempt '${assessment.attemptId}' could not be read: no attempt owner decision port is configured`,
      ];
    }
    let recorded: Awaited<
      ReturnType<AttemptOwnerDecisionPort['readAttemptOwnerDecisionReferences']>
    >;
    try {
      recorded = await deps.attemptOwnerDecisionPort.readAttemptOwnerDecisionReferences({
        attemptId: assessment.attemptId,
      });
    } catch (error: unknown) {
      return [
        `owner decision references for attempt '${assessment.attemptId}' could not be read: ${describeError(error)}`,
      ];
    }
    if (recorded.outcome === 'unknown') {
      return [
        `owner decision references for attempt '${assessment.attemptId}' are unknown: ${recorded.reason}`,
      ];
    }

    const blockers: string[] = [];
    for (const reference of recorded.ownerDecisionReferences) {
      if (!isNonEmptyTrimmedString(reference)) {
        blockers.push(`attempt '${assessment.attemptId}' records an empty owner decision reference`);
        continue;
      }
      if (deps.ownerDecisionPort === undefined) {
        blockers.push(`owner decision '${reference}' could not be resolved: no owner decision port is configured`);
        continue;
      }
      try {
        const decision = await deps.ownerDecisionPort.resolveOwnerDecision({
          decisionReference: reference,
          candidateHeadSha: assessment.candidateHeadSha,
        });
        if (decision.outcome === 'not-approved') {
          blockers.push(`owner decision '${reference}' is not approved: ${decision.reason}`);
        } else if (decision.outcome === 'unknown') {
          blockers.push(`owner decision '${reference}' is unknown: ${decision.reason}`);
        }
      } catch (error: unknown) {
        blockers.push(
          `owner decision '${reference}' could not be resolved: ${describeError(error)}`,
        );
      }
    }
    return blockers;
  }

  /** Record the explicit blocker list and hold the assessment open. */
  private async block(
    deps: AssessHeadAcceptanceDependencies,
    assessment: EvidenceAssessmentRecord,
    blockers: readonly string[],
    nowIso: string,
  ): Promise<AssessHeadAcceptanceResult> {
    const aggregate = EvidenceAssessment.fromRecord(assessment);
    aggregate.block(blockers, nowIso);
    const updated = aggregate.toRecord();
    await deps.repo.saveAssessment(updated);
    return { outcome: 'blocked', blockers, assessment: updated };
  }
}