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
import { isCheckCoverage } from '../../domain/check-coverage.js';
import { EvidenceAssessment } from '../../domain/entities/EvidenceAssessment.js';
import { AssessmentState } from '../../domain/value-objects/AssessmentState.vo.js';
import { placeholderEvidenceRefusal, placeholderVerificationReceiptField } from '../../domain/placeholder-evidence.js';
import type { EvidenceAssessmentRepositoryPort } from '../ports/out/EvidenceAssessmentRepositoryPort.out-port.js';
import type { EvidenceArchivePort } from '../ports/out/EvidenceArchivePort.out-port.js';
import type {
  ExecuteVerificationCheckReceipt,
  VerificationExecutorPort,
} from '../ports/out/VerificationExecutorPort.out-port.js';
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

const MIN_REMAINING_BUDGET_MS = 2_000;

/** True when the deadline leaves under 2 seconds or is malformed (plan line 44). */
function isBudgetExhausted(deadlineIso: string | undefined): boolean {
  if (deadlineIso === undefined) {
    return false;
  }
  const deadlineMs = Date.parse(deadlineIso);
  if (!Number.isFinite(deadlineMs)) {
    return true;
  }
  return deadlineMs - Date.now() < MIN_REMAINING_BUDGET_MS;
}

function validateRequestFields(request: RequestVerificationRequest): string | null {
  const fields = [
    request.assessmentId,
    request.projectId,
    request.attemptId,
    request.candidateHeadSha,
    request.policyRevision,
    request.hostId,
    request.implementerModel,
  ];
  if (fields.some((field) => !isNonEmptyTrimmedString(field))) {
    return 'Verification requires non-empty assessmentId, projectId, attemptId, candidateHeadSha, policyRevision, hostId and implementerModel';
  }
  if (
    !Array.isArray(request.requiredChecks) ||
    request.requiredChecks.length === 0 ||
    !request.requiredChecks.every(isNonEmptyTrimmedString)
  ) {
    return 'Verification requires at least one required check';
  }
  return null;
}

function validateExistingAssessment(
  existing: EvidenceAssessmentRecord,
  request: RequestVerificationRequest,
): string | null {
  if (AssessmentState.create(existing.state).value?.isTerminal()) {
    return `Assessment '${existing.id}' is in terminal state '${existing.state}'`;
  }
  if (existing.candidateHeadSha !== request.candidateHeadSha) {
    return `Assessment candidate head '${existing.candidateHeadSha}' does not match requested head '${request.candidateHeadSha}'`;
  }
  if (existing.policyRevision !== request.policyRevision) {
    return `Assessment policy revision '${existing.policyRevision}' does not match requested policy revision '${request.policyRevision}'`;
  }
  if (existing.attemptId !== request.attemptId) {
    return `Assessment attempt ID '${existing.attemptId}' does not match requested attempt ID '${request.attemptId}'`;
  }
  if (existing.projectId !== request.projectId) {
    return `Assessment project ID '${existing.projectId}' does not match requested project ID '${request.projectId}'`;
  }
  if (existing.implementerModel !== request.implementerModel) {
    return `Assessment records implementer seat '${existing.implementerModel}', which does not match the attempt's recorded seat '${request.implementerModel}'`;
  }
  return null;
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

    const validationError = validateRequestFields(request);
    if (validationError !== null) {
      return { outcome: 'rejected', reason: validationError };
    }

    const nowIso = isNonEmptyTrimmedString(request.nowIso) ? request.nowIso : new Date().toISOString();
    const existing = await deps.repo.findAssessmentById(request.assessmentId);
    if (existing !== null) {
      const existingError = validateExistingAssessment(existing, request);
      if (existingError !== null) {
        return { outcome: 'rejected', reason: existingError };
      }
    }
    const base: EvidenceAssessmentRecord = existing ?? {
      id: request.assessmentId,
      projectId: request.projectId,
      attemptId: request.attemptId,
      candidateHeadSha: request.candidateHeadSha,
      policyRevision: request.policyRevision,
      implementerModel: request.implementerModel,
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

    // Checks run one at a time on the verification host, as before. Every
    // execution is validated before anything is archived, so malformed
    // coverage from any check leaves no archived evidence and no receipt.
    const executions: { procedureName: string; execution: ExecuteVerificationCheckReceipt }[] = [];
    for (const procedureName of request.requiredChecks) {
      if (isBudgetExhausted(request.deadlineIso)) {
        return {
          outcome: 'not-started',
          reason: `Verification budget exhausted before starting check '${procedureName}'`,
        };
      }
      const execution = await deps.executor.executeVerificationCheck({
        hostId: request.hostId,
        candidateHeadSha: request.candidateHeadSha,
        procedureName,
        ...(request.deadlineIso !== undefined ? { deadlineIso: request.deadlineIso } : {}),
      });
      if (execution.outcome === 'not-started') {
        return {
          outcome: 'not-started',
          reason: execution.reason,
        };
      }
      executions.push({ procedureName, execution });
    }
    const malformed = executions.find(
      ({ execution }) => execution.coverage !== undefined && !isCheckCoverage(execution.coverage),
    );
    if (malformed !== undefined) {
      return {
        outcome: 'rejected',
        reason: `Verification executor returned malformed coverage for '${malformed.procedureName}'; nothing was archived or recorded`,
      };
    }

    const receipts: VerificationReceiptRecord[] = await Promise.all(
      executions.map(async ({ procedureName, execution }) => {
        const archived = await deps.archive.archiveEvidence({
          artifactId: `verification-${request.assessmentId}-${procedureName}-${request.candidateHeadSha}`,
          candidateHeadSha: request.candidateHeadSha,
          content: execution.outputSummary,
        });
        return {
          id: `vr-${request.assessmentId}-${procedureName}`,
          assessmentId: request.assessmentId,
          projectId: base.projectId,
          attemptId: base.attemptId,
          candidateHeadSha: request.candidateHeadSha,
          hostId: request.hostId,
          procedureName,
          result: execution.result,
          exitCode: execution.exitCode,
          ...(execution.coverage !== undefined ? { coverage: execution.coverage } : {}),
          evidenceRef: archived.evidenceRef,
          policyRevision: base.policyRevision,
          completedAtIso: execution.completedAtIso,
        };
      }),
    );

    // Archive-generated references never match; this guards a misbehaving archive adapter.
    const placeholderReceipt = receipts.find((receipt) => placeholderVerificationReceiptField(receipt) !== null);
    if (placeholderReceipt !== undefined) {
      return {
        outcome: 'rejected',
        reason: placeholderEvidenceRefusal('Verification receipt', 'evidenceRef') + '; nothing was recorded',
      };
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