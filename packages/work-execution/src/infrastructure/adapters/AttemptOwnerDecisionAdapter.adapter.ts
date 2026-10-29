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

import type { InspectAttemptPort } from '../../application/ports/in/InspectAttemptPort.in-port.js';

/**
 * The one reading of an attempt's frozen one-way doors that both composition roots (CLI and API) bind: the
 * attempt record dispatch wrote, never a request body or worktree file. An unwired lookup, a missing attempt or a
 * record written before the field existed reads as `unknown`.
 */
export async function readOwnerDecisionReferencesFromAttempt(
  lookup: { readonly inspectAttempt?: Pick<InspectAttemptPort, 'inspectAttempt'> },
  request: ReadAttemptOwnerDecisionRequest,
): Promise<AttemptOwnerDecisionResult> {
  const inspectAttempt = lookup.inspectAttempt;
  if (!inspectAttempt) {
    return { outcome: 'unknown', reason: 'The work context is not wired for attempt inspection' };
  }
  const inspection = await inspectAttempt.inspectAttempt({ attemptId: request.attemptId });
  if (inspection.outcome !== 'found') {
    return { outcome: 'unknown', reason: `No attempt is recorded for ${request.attemptId}` };
  }
  const recorded = inspection.attempt.ownerDecisionReferences;
  if (recorded === undefined) {
    return {
      outcome: 'unknown',
      reason: `attempt ${request.attemptId} was recorded before owner decision references were frozen`,
    };
  }
  return { outcome: 'recorded', ownerDecisionReferences: recorded };
}

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