// @generated use-case scaffold — refined for step 4.
/**
 * InspectAcceptanceEvidenceUseCase returns the stored assessment, its revision
 * and its receipt provenance by identity or by exact head. Missing, unknown
 * and stale evidence are reported as not-found rather than as an implicit pass.
 */

import type { EvidenceAssessmentRepositoryPort } from '../ports/out/EvidenceAssessmentRepositoryPort.out-port.js';
import type {
  InspectAcceptanceEvidencePort,
  InspectAcceptanceEvidenceRequest,
  InspectAcceptanceEvidenceResult,
} from '../ports/in/InspectAcceptanceEvidencePort.in-port.js';

export interface InspectAcceptanceEvidenceDependencies {
  readonly repo: EvidenceAssessmentRepositoryPort;
}

const NOT_IMPLEMENTED = 'Not implemented: InspectAcceptanceEvidenceUseCase';

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export class InspectAcceptanceEvidenceUseCase implements InspectAcceptanceEvidencePort {
  constructor(private readonly deps?: InspectAcceptanceEvidenceDependencies) {}

  /** Generic entry point kept for callers that hold an untyped use case. */
  async execute(input: unknown): Promise<InspectAcceptanceEvidenceResult> {
    return this.run(input as InspectAcceptanceEvidenceRequest | undefined);
  }

  async inspectAcceptanceEvidence(
    request: InspectAcceptanceEvidenceRequest,
  ): Promise<InspectAcceptanceEvidenceResult> {
    return this.run(request);
  }

  private async run(request?: InspectAcceptanceEvidenceRequest): Promise<InspectAcceptanceEvidenceResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error(NOT_IMPLEMENTED);
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body, and an
    // empty object body flows into the validation below as a not-found.
    if (typeof request !== 'object' || request === null) {
      throw new Error(NOT_IMPLEMENTED);
    }
    const deps = this.deps;

    if (isNonEmptyTrimmedString(request.assessmentId)) {
      const byId = await deps.repo.findAssessmentById(request.assessmentId);
      return byId === null
        ? { outcome: 'not-found', query: request.assessmentId }
        : { outcome: 'found', assessment: byId };
    }
    if (isNonEmptyTrimmedString(request.candidateHeadSha)) {
      const byHead = await deps.repo.findAssessmentByHead(request.candidateHeadSha);
      return byHead === null
        ? { outcome: 'not-found', query: request.candidateHeadSha }
        : { outcome: 'found', assessment: byHead };
    }
    return { outcome: 'not-found', query: '' };
  }
}