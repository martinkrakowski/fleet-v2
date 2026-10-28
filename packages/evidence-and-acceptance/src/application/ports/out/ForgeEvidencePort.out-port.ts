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
  /**
   * The pull-request head observed AFTER the CI buckets were read; null when
   * the follow-up read failed. It equals the requested head only when the PR
   * did not move between the two reads.
   */
  readonly observedHeadSha: string | null;
}

export interface ForgeEvidencePort {
  readForgeCheckStatus(request: ReadForgeCheckStatusRequest): Promise<ForgeCheckStatus>;
}
