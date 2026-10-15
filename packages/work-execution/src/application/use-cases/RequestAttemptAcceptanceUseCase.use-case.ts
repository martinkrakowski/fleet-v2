// Implemented use case — acceptance & forge station (cross-context step).
/**
 * RequestAttemptAcceptanceUseCase implements RequestAttemptAcceptancePort.
 *
 * It requests verification and independent review of one exact candidate
 * head: the attempt must have ended and been collected, the candidate head
 * must match the collected artifacts exactly, and the reviewer's model must
 * differ from the implementer's (a provider prefix alone is insufficient).
 * The evidence context's exact-head assessment is consumed through
 * AcceptanceAssessmentPort; a receipt for any other head is never propagated
 * as an acceptance of the requested one.
 */

import type {
  RequestAttemptAcceptancePort,
  RequestAttemptAcceptanceRequest,
  RequestAttemptAcceptanceResult,
} from '../ports/in/RequestAttemptAcceptancePort.in-port.js';
import type { AcceptanceAssessmentPort } from '../ports/out/AcceptanceAssessmentPort.out-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../ports/out/WorkOrderRepositoryPort.out-port.js';
import type { WorkOrderRecord } from '../../domain/execution-records.js';
import { WorkOrder } from '../../domain/entities/WorkOrder.js';

/** Default implementer seat used when no per-attempt model is supplied. */
const DEFAULT_IMPLEMENTER_MODEL = 'nvidia/z-ai/glm-5.3';

/**
 * Strip one `<provider>/` prefix so `a/model` and `b/model` compare as the
 * same underlying model; a provider change alone is never independence.
 */
function baseModelName(model: string): string {
  const separator = model.indexOf('/');
  return separator === -1 ? model : model.slice(separator + 1);
}

export interface RequestAttemptAcceptanceDependencies {
  /** Attempt lookup is read-only; acceptance never mutates an attempt. */
  readonly attemptRepo: AttemptRepositoryPort;
  /**
   * The work order supplies the approved policy revision that scopes the
   * assessment, and receives the 'ready-to-merge' state on acceptance.
   * Without it no policy-scoped assessment can be requested.
   */
  readonly workOrderRepo?: WorkOrderRepositoryPort;
  /** Consumes the evidence context's exact-head assessment. */
  readonly acceptancePort: AcceptanceAssessmentPort;
  /** Implementer model per attempt; unlisted attempts use the default seat. */
  readonly implementerModelByAttempt?: Readonly<Record<string, string>>;
  /**
   * Composition-root clock for revision timestamps; the wall-clock default
   * is a scaffold convenience, not an authority source.
   */
  readonly now?: () => string;
}

export class RequestAttemptAcceptanceUseCase implements RequestAttemptAcceptancePort {
  constructor(private readonly deps?: RequestAttemptAcceptanceDependencies) {}

  async requestAttemptAcceptance(
    request: RequestAttemptAcceptanceRequest,
  ): Promise<RequestAttemptAcceptanceResult> {
    const deps = this.deps;
    if (!deps) {
      throw new Error('Not implemented: RequestAttemptAcceptanceUseCase');
    }

    const attempt = await deps.attemptRepo.findAttemptById(request.attemptId);
    if (attempt === null) {
      return { outcome: 'rejected', reason: 'Attempt not found' };
    }
    if (attempt.state !== 'collected' && attempt.state !== 'ended') {
      return {
        outcome: 'rejected',
        reason: `Attempt is not ready for acceptance: state is '${attempt.state}'`,
      };
    }
    if (attempt.artifacts === null) {
      return { outcome: 'rejected', reason: 'Attempt has no collected artifacts' };
    }

    // Only the exact collected head is ever assessed; a moved head is stale.
    if (attempt.artifacts.headCommit !== request.candidateHeadSha) {
      return {
        outcome: 'rejected',
        reason: `Candidate head mismatch: expected ${attempt.artifacts.headCommit}, got ${request.candidateHeadSha}`,
      };
    }

    const implementerModel =
      deps.implementerModelByAttempt?.[request.attemptId] ?? DEFAULT_IMPLEMENTER_MODEL;
    if (
      implementerModel === request.reviewerModel ||
      baseModelName(implementerModel) === baseModelName(request.reviewerModel)
    ) {
      return {
        outcome: 'rejected',
        reason: `Reviewer model ${request.reviewerModel} matches implementer model ${implementerModel}; an independent reviewer is required`,
      };
    }

    const workOrder = deps.workOrderRepo
      ? await deps.workOrderRepo.findWorkOrderById(attempt.workOrderId)
      : null;
    if (workOrder === null) {
      return {
        outcome: 'rejected',
        reason: 'Acceptance requires the work order policy revision; no work order is available',
      };
    }

    const verdict = await deps.acceptancePort.assessHeadAcceptance({
      attemptId: request.attemptId,
      workOrderId: attempt.workOrderId,
      candidateHeadSha: request.candidateHeadSha,
      policyRevision: workOrder.policyRevision,
    });

    if (verdict.outcome === 'accepted') {
      // A receipt for a different head is stale evidence, never a pass.
      if (verdict.assessedHeadSha !== request.candidateHeadSha) {
        return {
          outcome: 'rejected',
          reason: `Stale: assessed head ${verdict.assessedHeadSha} does not match candidate head ${request.candidateHeadSha}`,
        };
      }
      await this.markReadyToMerge(deps, workOrder);
      return {
        outcome: 'accepted',
        candidateHeadSha: verdict.assessedHeadSha,
        receiptId: verdict.receiptId,
      };
    }
    if (verdict.outcome === 'unknown') {
      return { outcome: 'rejected', reason: `Unknown: ${verdict.reason}` };
    }
    return { outcome: 'rejected', reason: verdict.reason };
  }

  async execute(input?: unknown): Promise<RequestAttemptAcceptanceResult> {
    if (!this.deps || !input || typeof input !== 'object') {
      throw new Error('Not implemented: RequestAttemptAcceptanceUseCase');
    }
    return this.requestAttemptAcceptance(input as RequestAttemptAcceptanceRequest);
  }

  /** Accepted heads may move a non-terminal work order to 'ready-to-merge'. */
  private async markReadyToMerge(
    deps: RequestAttemptAcceptanceDependencies,
    workOrderRecord: WorkOrderRecord,
  ): Promise<void> {
    if (deps.workOrderRepo === undefined) {
      return;
    }
    const workOrder = WorkOrder.fromRecord(workOrderRecord);
    if (workOrder.isTerminal()) {
      return;
    }
    await deps.workOrderRepo.saveWorkOrder({
      ...workOrderRecord,
      state: 'ready-to-merge',
      revision: workOrder.nextRevision(),
      updatedAtIso: deps.now?.() ?? new Date().toISOString(),
    });
  }
}
