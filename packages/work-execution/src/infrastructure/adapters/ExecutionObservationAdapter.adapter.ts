// @generated adapter stub — refined for migration step 1 (no behaviour).
/**
 * ExecutionObservationAdapter implements ExecutionObservationPort
 * (in-process delegation to operator-coordination). Wiring lands in wave 2;
 * every method refuses until then.
 */

import type {
  ExecutionObservationPort,
  PublishExecutionObservationRequest,
  PublishExecutionObservationResult,
} from '../../application/ports/out/ExecutionObservationPort.out-port.js';

export class ExecutionObservationAdapter implements ExecutionObservationPort {
  async publishExecutionObservation(
    _request: PublishExecutionObservationRequest,
  ): Promise<PublishExecutionObservationResult> {
    throw new Error('Not implemented: ExecutionObservationAdapter.publishExecutionObservation');
  }
}
