// @generated inbound contract scaffold — refined for step 5.
/**
 * InspectOutstandingCoordinationPort: list undecided proposals, unknown
 * actions, undelivered observations and unacknowledged notices. Omitting
 * projectId lists fleet-wide outstanding coordination; known absence is an
 * empty list, never an invented item.
 */

import type { CoordinationRequestRecord } from '../../../domain/coordination-records.js';
import type { ObservationEnvelopeProps } from '../../../domain/value-objects/ObservationEnvelope.vo.js';

export interface InspectOutstandingCoordinationRequest {
  readonly projectId?: string;
}

export interface InspectOutstandingCoordinationResult {
  readonly undecidedProposals: readonly CoordinationRequestRecord[];
  readonly unknownActions: readonly CoordinationRequestRecord[];
  readonly undeliveredObservations: readonly ObservationEnvelopeProps[];
  readonly unacknowledgedRelays: readonly CoordinationRequestRecord[];
}

export interface InspectOutstandingCoordinationPort {
  inspectOutstandingCoordination(
    request: InspectOutstandingCoordinationRequest,
  ): Promise<InspectOutstandingCoordinationResult>;
}
