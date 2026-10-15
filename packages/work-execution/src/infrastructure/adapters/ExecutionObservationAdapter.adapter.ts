// Implemented adapter — acceptance & forge station (cross-context step).
/**
 * ExecutionObservationAdapter implements ExecutionObservationPort by
 * in-process delegation to operator-coordination's publication contract.
 * A failed or throwing publish never fails the lane and never mutates the
 * attempt: the delivery gap is preserved and returned. Until a transport
 * is configured every call refuses.
 */

import type {
  ExecutionObservationPort,
  PublishExecutionObservationRequest,
  PublishExecutionObservationResult,
} from '../../application/ports/out/ExecutionObservationPort.out-port.js';

/** Supplier-side delegate plus an optional delivery-attempt log. */
export interface ExecutionObservationDelegate {
  readonly publish?: (
    request: PublishExecutionObservationRequest,
  ) => Promise<PublishExecutionObservationResult>;
  /** Receives every observation before delivery is attempted. */
  readonly recorded?: PublishExecutionObservationRequest[];
}

export class ExecutionObservationAdapter implements ExecutionObservationPort {
  private readonly delegate?: ExecutionObservationDelegate;

  constructor(delegate?: ExecutionObservationDelegate) {
    this.delegate = delegate;
  }

  async publishExecutionObservation(
    request: PublishExecutionObservationRequest,
  ): Promise<PublishExecutionObservationResult> {
    const delegate = this.delegate;
    if (!delegate?.publish && !delegate?.recorded) {
      throw new Error('Not implemented: ExecutionObservationAdapter.publishExecutionObservation');
    }
    // The delivery attempt stays visible even when the transport cannot.
    delegate.recorded?.push(request);
    if (!delegate.publish) {
      return {
        outcome: 'delivery-gap',
        reason: 'No observation transport configured',
      };
    }
    try {
      const result = await delegate.publish(request);
      if (result.outcome === 'published') {
        return { outcome: 'published' };
      }
      return result;
    } catch (error) {
      return {
        outcome: 'delivery-gap',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
