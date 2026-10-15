// @generated outbound contract scaffold — refined for step 5.
/**
 * ObservationPublicationPort: publish a versioned Waves snapshot through its
 * client without exposing tokens to agents. A failed publication is returned as
 * a delivery gap with its reason so the fact stays visible and undelivered.
 */

import type { ObservationEnvelopeProps } from '../../../domain/value-objects/ObservationEnvelope.vo.js';

export type ObservationPublicationOutcome =
  | {
      readonly outcome: 'published';
    }
  | {
      readonly outcome: 'delivery-gap';
      readonly reason: string;
    };

export interface ObservationPublicationPort {
  publishObservationSnapshot(envelope: ObservationEnvelopeProps): Promise<ObservationPublicationOutcome>;

  /** Observations still undelivered, optionally narrowed to one project. */
  listUndeliveredObservations(projectId?: string): Promise<readonly ObservationEnvelopeProps[]>;
}
