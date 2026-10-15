// @generated adapter stub — refined for step 5 (no behaviour).
/**
 * ObservationPublicationAdapter implements ObservationPublicationPort
 * (existing-waves-client). Implementation lands in a later step; it refuses
 * rather than publishing an observation it cannot attribute.
 */

import type { ObservationEnvelopeProps } from '../../domain/value-objects/ObservationEnvelope.vo.js';
import type {
  ObservationPublicationOutcome,
  ObservationPublicationPort,
} from '../../application/ports/out/ObservationPublicationPort.out-port.js';

export class ObservationPublicationAdapter implements ObservationPublicationPort {
  async publishObservationSnapshot(
    _envelope: ObservationEnvelopeProps,
  ): Promise<ObservationPublicationOutcome> {
    throw new Error('Not implemented: ObservationPublicationAdapter.publishObservationSnapshot');
  }

  async listUndeliveredObservations(
    _projectId?: string,
  ): Promise<readonly ObservationEnvelopeProps[]> {
    throw new Error('Not implemented: ObservationPublicationAdapter.listUndeliveredObservations');
  }
}
