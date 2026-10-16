// @generated use-case scaffold — refined for step 4.
/**
 * RequestVerificationUseCase runs the required checks for one exact candidate
 * head on the configured verification host and retains only completed
 * receipts. A launched check is never treated as a completed one: the executor
 * result, its archived evidence and the derived blockers are written together.
 */

import type {
  EvidenceAssessmentRecord,
  VerificationReceiptRecord,
} from '../../domain/evidence-records.js';
import { EvidenceAssessment } from '../../domain/entities/EvidenceAssessment.js';
import { AssessmentState } from '../../domain/value-objects/AssessmentState.vo.js';
import type { EvidenceAssessmentRepositoryPort } from '../ports/out/EvidenceAssessmentRepositoryPort.out-port.js';
import type { EvidenceArchivePort } from '../ports/out/EvidenceArchivePort.out-port.js';
import type { VerificationExecutorPort } from '../ports/out/VerificationExecutorPort.out-port.js';
import type {
  RequestVerificationPort,
  RequestVerificationRequest,
  RequestVerificationResult,
} from '../ports/in/RequestVerificationPort.in-port.js';

export interface RequestVerificationDependencies {
  readonly repo: EvidenceAssessmentRepositoryPort;
  readonly executor: VerificationExecutorPort;
  readonly archive: EvidenceArchivePort;
}

const NOT_IMPLEMENTED = 'Not implemented: RequestVerificationUseCase';

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Replace any earlier receipt for the same procedure, keeping one per check. */
function mergeReceiptsByProcedure(
  existing: readonly VerificationReceiptRecord[],
  received: readonly VerificationReceiptRecord[],
): readonly VerificationReceiptRecord[] {
  const receivedNames = new Set(received.map((receipt) => receipt.procedureName));
  return [
    ...existing.filter((receipt) => !receivedNames.has(receipt.procedureName)),
    ...received.map((receipt) => ({ ...receipt })),
  ];
}

export class RequestVerificationUseCase implements RequestVerificationPort {
  constructor(private readonly deps?: RequestVerificationDependencies) {}

  /** Generic entry point kept for callers that hold an untyped use case. */
  async execute(input: unknown): Promise<RequestVerificationResult> {
    return this.run(input as RequestVerificationRequest | undefined);
  }

  async requestVerification(request: RequestVerificationRequest): Promise<RequestVerificationResult> {
    return this.run(request);
  }

  private async run(request?: RequestVerificationRequest): Promise<RequestVerificationResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error(NOT_IMPLEMENTED);
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body, and an
    // empty object body flows into the validation below as a rejection.
    if (!isRecord(request)) {
      throw new Error(NOT_IMPLEMENTED);
    }
    const deps = this.deps;

    if (
      !isNonEmptyTrimmedString(request.assessmentId) ||
      !isNonEmptyTrimmedString(request.projectId) ||
      !isNonEmptyTrimmedString(request.attemptId) ||
      !isNonEmptyTrimmedString(request.candidateHeadSha) ||
      !isNonEmptyTrimmedString(request.policyRevision) ||
      !isNonEmptyTrimmedString(request.hostId)
    ) {
      return {
        outcome: 'rejected',
        reason:
          'Verification requires non-empty assessmentId, projectId, attemptId, candidateHeadSha, policyRevision and hostId',
      };
    }
    if (
      !Array.isArray(request.requiredChecks) ||
      request.requiredChecks.length === 0 ||
      !request.requiredChecks.every(isNonEmptyTrimmedString)
    ) {
      return { outcome: 'rejected', reason: 'Verification requires at least one required check' };
    }

    const nowIso = isNonEmptyTrimmedString(request.nowIso) ? request.nowIso : new Date().toISOString();
    const existing = await deps.repo.findAssessmentById(request.assessmentId);
    if (existing !== null) {
      if (AssessmentState.create(existing.state).value?.isTerminal()) {
        return {
          outcome: 'rejected',
          reason: `Assessment '${existing.id}' is in terminal state '${existing.state}'`,
        };
      }
      if (existing.candidateHeadSha !== request.candidateHeadSha) {
        return {
          outcome: 'rejected',
          reason: `Assessment candidate head '${existing.candidateHeadSha}' does not match requested head '${request.candidateHeadSha}'`,
        };
      }
      if (existing.policyRevision !== request.policyRevision) {
        return {
          outcome: 'rejected',
          reason: `Assessment policy revision '${existing.policyRevision}' does not match requested policy revision '${request.policyRevision}'`,
        };
      }
      if (existing.attemptId !== request.attemptId) {
        return {
          outcome: 'rejected',
          reason: `Assessment attempt ID '${existing.attemptId}' does not match requested attempt ID '${request.attemptId}'`,
        };
      }
      if (existing.projectId !== request.projectId) {
        return {
          outcome: 'rejected',
          reason: `Assessment project ID '${existing.projectId}' does not match requested project ID '${request.projectId}'`,
        };
      }
    }
    const base: EvidenceAssessmentRecord = existing ?? {
      id: request.assessmentId,
      projectId: request.projectId,
      attemptId: request.attemptId,
      candidateHeadSha: request.candidateHeadSha,
      policyRevision: request.policyRevision,
      requiredChecks: [...request.requiredChecks],
      state: 'pending',
      verificationReceipts: [],
      reviewReceipts: [],
      findingDispositions: [],
      acceptanceReceiptId: null,
      blockers: [],
      revision: 0,
      updatedAtIso: nowIso,
    };

    const receipts: VerificationReceiptRecord[] = [];
    for (const procedureName of request.requiredChecks) {
      const execution = await deps.executor.executeVerificationCheck({
        hostId: request.hostId,
        candidateHeadSha: request.candidateHeadSha,
        procedureName,
      });
      const archived = await deps.archive.archiveEvidence({
        artifactId: `verification-${request.assessmentId}-${procedureName}-${request.candidateHeadSha}`,
        candidateHeadSha: request.candidateHeadSha,
        content: execution.outputSummary,
      });
      receipts.push({
        id: `vr-${request.assessmentId}-${procedureName}`,
        assessmentId: request.assessmentId,
        projectId: base.projectId,
        attemptId: base.attemptId,
        candidateHeadSha: request.candidateHeadSha,
        hostId: request.hostId,
        procedureName,
        result: execution.result,
        exitCode: execution.exitCode,
        evidenceRef: archived.evidenceRef,
        policyRevision: base.policyRevision,
        completedAtIso: execution.completedAtIso,
      });
    }

    const merged: EvidenceAssessmentRecord = {
      ...base,
      verificationReceipts: mergeReceiptsByProcedure(base.verificationReceipts, receipts),
      revision: base.revision + 1,
      updatedAtIso: nowIso,
    };
    // Blockers and state are derived from the merged evidence, never assumed:
    // pending, unknown and failing checks all keep the assessment open.
    const blockers = EvidenceAssessment.fromRecord(merged).collectBlockers();
    const assessment: EvidenceAssessmentRecord = {
      ...merged,
      state: blockers.length > 0 ? 'blocked' : 'pending',
      blockers: [...blockers],
    };
    await deps.repo.saveAssessment(assessment);
    return { outcome: 'completed', assessment, receipts };
  }
}

function isRecord(value: unknown): value is RequestVerificationRequest {
  return typeof value === 'object' && value !== null;
}