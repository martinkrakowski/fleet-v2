// Implemented use case — acceptance & forge station (cross-context step).
/**
 * RequestAttemptAcceptanceUseCase implements RequestAttemptAcceptancePort.
 *
 * It requests verification and independent review of one exact candidate
 * head: the attempt must have ended and been collected, the candidate head
 * must match the collected artifacts exactly, and the reviewer's model must
 * differ from the implementer's (a provider prefix alone is insufficient).
 * The implementer is the attempt's own recorded seat — the runner model
 * dispatch wrote, or failing that the frozen brief manifest's model
 * assignment read through the artifact port. There is no default seat and no
 * worktree-file fallback: an attempt whose seat is unknown is refused, never
 * compared against an assumed model, and a model is never read from a file
 * inside the worker's worktree.
 * The evidence context's exact-head assessment is consumed through
 * AcceptanceAssessmentPort; a receipt for any other head is never propagated
 * as an acceptance of the requested one.
 *
 * `resolveImplementerSeat` is the single binding of an attempt to the seat
 * that implemented it. Composition roots read it through the same function so
 * no boundary (CLI, API) can state an implementer model of its own.
 */

import type {
  RequestAttemptAcceptancePort,
  RequestAttemptAcceptanceRequest,
  RequestAttemptAcceptanceResult,
} from '../ports/in/RequestAttemptAcceptancePort.in-port.js';
import type { AcceptanceAssessmentPort } from '../ports/out/AcceptanceAssessmentPort.out-port.js';
import type { AttemptArtifactPort } from '../ports/out/AttemptArtifactPort.out-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../ports/out/WorkOrderRepositoryPort.out-port.js';
import type { AttemptRecord, WorkOrderRecord } from '../../domain/execution-records.js';
import { WorkOrder } from '../../domain/entities/WorkOrder.js';

/**
 * Strip one `<provider>/` prefix so `a/model` and `b/model` compare as the
 * same underlying model; a provider change alone is never independence.
 */
function baseModelName(model: string): string {
  const separator = model.indexOf('/');
  return separator === -1 ? model : model.slice(separator + 1);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Ports that can read the frozen brief manifest; the artifact port reads the
 * product's frozen brief package, and is not assumed present.
 */
export interface ImplementerSeatPorts {
  readonly artifactPort?: Pick<AttemptArtifactPort, 'readBriefManifest'>;
}

/** The seat an attempt was implemented on, and the record that established it. */
export type ImplementerSeatResolution =
  | {
      readonly outcome: 'resolved';
      readonly model: string;
      readonly source: 'attempt-runner' | 'frozen-manifest';
    }
  | { readonly outcome: 'unknown'; readonly reason: string };

/**
 * Read `modelAssignment.model` from the attempt's frozen brief manifest. The
 * candidate paths are derived from the dispatch-recorded brief package path
 * only, and the manifest is read only through the artifact port, which reads
 * the product's frozen brief package: a worker-writable worktree file is
 * never a seat authority, so an attempt without a recorded runner model and
 * without a wired artifact port stays `unknown` and is refused. An unreadable
 * or non-JSON candidate is absence, not an error.
 */
async function readFrozenManifestModel(
  attempt: AttemptRecord,
  ports: ImplementerSeatPorts,
): Promise<string | null> {
  const briefPackagePath = attempt.briefPackagePath;
  const candidates = [
    briefPackagePath,
    isNonEmptyString(briefPackagePath)
      ? briefPackagePath.replace(/\.md$/, '-manifest.json')
      : null,
  ].filter(isNonEmptyString);

  for (const candidate of candidates) {
    let raw: string | null = null;
    try {
      raw = ports.artifactPort?.readBriefManifest
        ? await ports.artifactPort.readBriefManifest(attempt.worktreePath, candidate)
        : null;
    } catch {
      continue;
    }
    if (!isNonEmptyString(raw)) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object') {
        continue;
      }
      const model = (parsed as { readonly modelAssignment?: { readonly model?: unknown } })
        .modelAssignment?.model;
      if (isNonEmptyString(model)) {
        return model.trim();
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Bind an attempt to the seat that implemented it: the runner model dispatch
 * recorded on the attempt, otherwise the frozen brief manifest's model
 * assignment read through the artifact port. Neither known is `unknown`,
 * never an assumed default seat, and an attempt with no recorded runner model
 * and no wired artifact port is refused.
 */
export async function resolveImplementerSeat(
  attempt: AttemptRecord,
  ports: ImplementerSeatPorts = {},
): Promise<ImplementerSeatResolution> {
  const recorded = attempt.runner?.model;
  if (isNonEmptyString(recorded)) {
    return { outcome: 'resolved', model: recorded.trim(), source: 'attempt-runner' };
  }
  const manifestModel = await readFrozenManifestModel(attempt, ports);
  if (manifestModel !== null) {
    return { outcome: 'resolved', model: manifestModel, source: 'frozen-manifest' };
  }
  return {
    outcome: 'unknown',
    reason: `Attempt ${attempt.id} records no implementer seat: neither the dispatched runner model nor the frozen brief manifest's model assignment is known`,
  };
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
  /** Reads the frozen brief manifest when the attempt records no runner seat. */
  readonly artifactPort?: Pick<AttemptArtifactPort, 'readBriefManifest'>;
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

    // The implementer is the attempt's own seat; an unknown seat is refused
    // rather than compared against an assumed default.
    const implementerSeat = await resolveImplementerSeat(attempt, {
      artifactPort: deps.artifactPort,
    });
    if (implementerSeat.outcome === 'unknown') {
      return { outcome: 'rejected', reason: implementerSeat.reason };
    }
    const implementerModel = implementerSeat.model;
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
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: RequestAttemptAcceptanceUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body, and an
    // empty object body flows into the validation below as a rejection.
    if (!input || typeof input !== 'object') {
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
