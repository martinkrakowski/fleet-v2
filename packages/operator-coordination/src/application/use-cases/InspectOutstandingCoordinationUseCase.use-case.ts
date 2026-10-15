/**
 * InspectOutstandingCoordinationUseCase implements
 * InspectOutstandingCoordinationPort. It lists what is still outstanding:
 * undecided proposals, unknown actions, undelivered observations and relays no
 * recipient has answered.
 *
 * Omitting projectId lists fleet-wide outstanding coordination. Known absence is
 * an empty list, never an invented item, and a delivery gap stays visible until
 * the fact actually reaches its destination.
 */

import type { CoordinationRequestRecord } from '../../domain/coordination-records.js';
import type { ObservationEnvelopeProps } from '../../domain/value-objects/ObservationEnvelope.vo.js';
import type {
  InspectOutstandingCoordinationPort,
  InspectOutstandingCoordinationRequest,
  InspectOutstandingCoordinationResult,
} from '../ports/in/InspectOutstandingCoordinationPort.in-port.js';
import type { CoordinationRequestRepositoryPort } from '../ports/out/CoordinationRequestRepositoryPort.out-port.js';
import type { ObservationPublicationPort } from '../ports/out/ObservationPublicationPort.out-port.js';

export interface InspectOutstandingCoordinationDependencies {
  readonly requestRepo: CoordinationRequestRepositoryPort;
  readonly publicationPort: ObservationPublicationPort;
}

export class InspectOutstandingCoordinationUseCase implements InspectOutstandingCoordinationPort {
  constructor(private readonly deps?: InspectOutstandingCoordinationDependencies) {}

  async inspectOutstandingCoordination(
    request: InspectOutstandingCoordinationRequest,
  ): Promise<InspectOutstandingCoordinationResult> {
    return this.execute(request);
  }

  async execute(input: unknown): Promise<InspectOutstandingCoordinationResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: InspectOutstandingCoordinationUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body, and an
    // empty object body lists fleet-wide outstanding coordination below.
    if (typeof input !== 'object' || input === null) {
      throw new Error('Not implemented: InspectOutstandingCoordinationUseCase');
    }
    const request = input as InspectOutstandingCoordinationRequest;
    const projectId =
      typeof request.projectId === 'string' && request.projectId.trim().length > 0
        ? request.projectId.trim()
        : undefined;
    const recorded: readonly CoordinationRequestRecord[] = await this.deps.requestRepo.listRequests(
      projectId,
    );
    const undecidedProposals = recorded.filter(
      (candidate) => candidate.state === 'proposed' || candidate.state === 'awaiting-decision',
    );
    const unknownActions = recorded.filter((candidate) => candidate.state === 'unknown');
    // Delivery is not acknowledgement: an unanswered relay stays outstanding.
    const unacknowledgedRelays = recorded.filter(
      (candidate) => candidate.kind === 'relay' && candidate.acknowledgements.length === 0,
    );
    const undeliveredObservations: readonly ObservationEnvelopeProps[] =
      await this.deps.publicationPort.listUndeliveredObservations(projectId);
    return {
      undecidedProposals,
      unknownActions,
      undeliveredObservations,
      unacknowledgedRelays,
    };
  }
}
