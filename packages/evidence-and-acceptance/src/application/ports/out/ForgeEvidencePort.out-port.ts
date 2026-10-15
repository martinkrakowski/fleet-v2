// @generated outbound contract scaffold — refined for step 4.
/**
 * Read current CI/check/thread status through the forge without opening,
 * merging or mutating PRs.
 */

import type { EvidenceResultValue } from '../../../domain/value-objects/EvidenceResult.vo.js';

export interface ReadForgeCheckStatusRequest {
  readonly candidateHeadSha: string;
}

export interface ForgeCheckStatus {
  readonly candidateHeadSha: string;
  readonly ciState: EvidenceResultValue;
  /** Unresolved review threads on the candidate head; null when they could not be read. */
  readonly unresolvedThreadCount: number | null;
}

export interface ForgeEvidencePort {
  readForgeCheckStatus(request: ReadForgeCheckStatusRequest): Promise<ForgeCheckStatus>;
}
