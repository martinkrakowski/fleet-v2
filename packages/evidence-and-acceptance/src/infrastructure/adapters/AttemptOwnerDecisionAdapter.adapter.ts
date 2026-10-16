// Implemented adapter — one-way-door station (cross-context step).
/**
 * AttemptOwnerDecisionAdapter implements AttemptOwnerDecisionPort by in-process
 * delegation to work-execution's InspectAttemptPort. The owner decision
 * references are read from the attempt record recorded at dispatch; a record
 * without the field is `unknown`, never an empty list, so an attempt dispatched
 * before the field existed blocks acceptance instead of silently clearing its
 * one-way doors.
 */

import type {
  AttemptOwnerDecisionPort,
  AttemptOwnerDecisionResult,
  ReadAttemptOwnerDecisionRequest,
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
    const read = this.delegate?.readAttemptOwnerDecisionReferences;
    if (!read) {
      throw new Error('Not implemented: AttemptOwnerDecisionAdapter.readAttemptOwnerDecisionReferences');
    }
    return read(request);
  }
}