/**
 * RecordRelayAcknowledgementUseCase implements RecordRelayAcknowledgementPort.
 * It records an actual recipient response together with the provenance of that
 * response and closes the relay it belongs to.
 *
 * Silence, a transport delivery receipt and a read receipt are not responses.
 * A response without a recipient, a summary or provenance is refused, a
 * response against something that is not a relay is refused, and the same
 * acknowledgement is never recorded twice. A delivery gap stays recorded on the
 * request: a claimed response is information, not a reason to erase a real
 * disagreement.
 */

import type {
  CoordinationRequestRecord,
  RelayAcknowledgementRecord,
} from '../../domain/coordination-records.js';
import { CoordinationRequest } from '../../domain/entities/CoordinationRequest.js';
import { RelayAcknowledgement } from '../../domain/entities/RelayAcknowledgement.js';
import type {
  RecordRelayAcknowledgementPort,
  RecordRelayAcknowledgementRequest,
  RecordRelayAcknowledgementResult,
} from '../ports/in/RecordRelayAcknowledgementPort.in-port.js';
import type { CoordinationRequestRepositoryPort } from '../ports/out/CoordinationRequestRepositoryPort.out-port.js';

export interface RecordRelayAcknowledgementDependencies {
  readonly requestRepo: CoordinationRequestRepositoryPort;
}

const REQUIRED_TEXT_FIELDS = [
  'acknowledgementId',
  'requestId',
  'recipientId',
  'responseSummary',
  'provenance',
] as const;

const REFUSING_STATES = ['declined', 'expired', 'cancelled'] as const;

function rejected(reason: string): RecordRelayAcknowledgementResult {
  return { outcome: 'rejected', reason };
}

export class RecordRelayAcknowledgementUseCase implements RecordRelayAcknowledgementPort {
  constructor(private readonly deps?: RecordRelayAcknowledgementDependencies) {}

  async recordRelayAcknowledgement(
    request: RecordRelayAcknowledgementRequest,
  ): Promise<RecordRelayAcknowledgementResult> {
    return this.execute(request);
  }

  async execute(input: unknown): Promise<RecordRelayAcknowledgementResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: RecordRelayAcknowledgementUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body, and an
    // empty object body is rejected by the field validation below.
    if (typeof input !== 'object' || input === null) {
      throw new Error('Not implemented: RecordRelayAcknowledgementUseCase');
    }
    const request = input as RecordRelayAcknowledgementRequest;
    for (const field of REQUIRED_TEXT_FIELDS) {
      if (typeof request[field] !== 'string' || request[field].trim().length === 0) {
        return rejected(`a relay acknowledgement requires a non-empty ${field}`);
      }
    }
    const requestId = request.requestId.trim();
    const acknowledgementId = request.acknowledgementId.trim();
    const recorded = await this.deps.requestRepo.findRequestById(requestId);
    if (recorded === null) {
      return rejected(`no recorded request ${requestId} to acknowledge`);
    }
    if (recorded.kind !== 'relay') {
      return rejected(`recorded request ${requestId} is not a relay notice`);
    }
    const recipientId = request.recipientId.trim();
    const expectedRecipient = recorded.actionScope.startsWith('relay:')
      ? recorded.actionScope.slice('relay:'.length)
      : recorded.actionScope;
    if (recipientId !== expectedRecipient) {
      return rejected(
        `recipient ${recipientId} does not match relay recipient ${expectedRecipient}`,
      );
    }
    if (
      recorded.acknowledgements.some(
        (acknowledgement) => acknowledgement.acknowledgementId === acknowledgementId,
      )
    ) {
      return rejected(`acknowledgement ${acknowledgementId} is already recorded on ${requestId}`);
    }
    if (
      (REFUSING_STATES as readonly string[]).includes(recorded.state)
    ) {
      return rejected(`relay ${requestId} is ${recorded.state} and accepts no response`);
    }
    // The composition root supplies the clock; no authority depends on it here.
    const nowIso =
      typeof request.nowIso === 'string' && request.nowIso.trim().length > 0
        ? request.nowIso
        : new Date().toISOString();
    const aggregate = CoordinationRequest.fromRecord(recorded);
    const acknowledgement: RelayAcknowledgementRecord = RelayAcknowledgement.fromRecord({
      acknowledgementId,
      requestId,
      recipientId: request.recipientId.trim(),
      responseSummary: request.responseSummary.trim(),
      provenance: request.provenance.trim(),
      acknowledgedAtIso: nowIso,
    }).toRecord();
    const answered: CoordinationRequestRecord = CoordinationRequest.fromRecord({
      ...recorded,
      acknowledgements: [...aggregate.getAcknowledgements(), acknowledgement],
      state: 'completed',
      revision: aggregate.nextRevision(),
      updatedAtIso: nowIso,
    }).toRecord();
    await this.deps.requestRepo.saveRequest(answered);
    return { outcome: 'acknowledged', request: answered, acknowledgement };
  }
}
