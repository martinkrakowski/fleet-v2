// @generated adapter stub — placeholders refuse; no external operation is implemented.
/**
 * AttemptArtifactAdapter implements AttemptArtifactPort
 *
 * Intended integration (manifest adapter_bindings): bounded filesystem and
 * approved remote artifact access. Not implemented in migration step 1.
 */

import type {
  AttemptArtifactPort,
  CollectCompletedAttemptArtifactsRequest,
  CollectCompletedAttemptArtifactsResult,
  PlaceFrozenBriefRequest,
  PlaceFrozenBriefResult,
  VerifyIgnoredPathsRequest,
  VerifyIgnoredPathsResult,
} from '../../application/ports/out/AttemptArtifactPort.out-port.js';

export class AttemptArtifactAdapter implements AttemptArtifactPort {
  verifyIgnoredPaths(_request: VerifyIgnoredPathsRequest): Promise<VerifyIgnoredPathsResult> {
    return Promise.reject(new Error('Not implemented: AttemptArtifactAdapter.verifyIgnoredPaths'));
  }

  placeFrozenBrief(_request: PlaceFrozenBriefRequest): Promise<PlaceFrozenBriefResult> {
    return Promise.reject(new Error('Not implemented: AttemptArtifactAdapter.placeFrozenBrief'));
  }

  collectCompletedAttemptArtifacts(
    _request: CollectCompletedAttemptArtifactsRequest,
  ): Promise<CollectCompletedAttemptArtifactsResult> {
    return Promise.reject(new Error('Not implemented: AttemptArtifactAdapter.collectCompletedAttemptArtifacts'));
  }
}
