// Implemented adapter — acceptance & forge station (cross-context step).
/**
 * AttemptOwnerDecisionAdapter implements AttemptOwnerDecisionPort by
 * in-process delegation to the supplier context's attempt inspection, so the
 * frozen one-way doors are read from the attempt record, never from a
 * request body or worktree file.
 */

import type {
  AttemptOwnerDecisionPort,
  ReadAttemptOwnerDecisionRequest,
  AttemptOwnerDecisionResult,
} from '../../application/ports/out/AttemptOwnerDecisionPort.out-port.js';

export interface AttemptOwnerDecisionDelegate {
  readonly readAttemptOwnerDecisionReferences?: (
    request: ReadAttemptOwnerDecisionRequest,
  ) => Promise<AttemptOwnerDecisionResult>;
}

export class AttemptOwnerDecisionAdapter implements AttemptOwnerDecisionPort {
  constructor(private readonly delegate?: AttemptOwnerDecisionDelegate) {}

  async readAttemptOwnerDecisionReferences(
    request: ReadAttemptOwnerDecisionRequest,
  ): Promise<AttemptOwnerDecisionResult> {
    if (!this.delegate?.readAttemptOwnerDecisionReferences) {
      throw new Error(
        'Not implemented: AttemptOwnerDecisionAdapter.readAttemptOwnerDecisionReferences',
      );
    }
    return this.delegate.readAttemptOwnerDecisionReferences(request);
  }
}