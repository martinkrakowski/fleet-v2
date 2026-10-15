/**
 * PublishProjectObservationUseCase implements PublishProjectObservationPort. It
 * turns one explicit event into an attributed observation envelope and hands
 * it to the publication port.
 *
 * A payload summary is a fact, never an instruction or authority. A failed
 * publication is preserved and returned as a delivery gap with its reason, so
 * the fact stays visible and undelivered instead of being silently dropped or
 * retried as something else.
 */

import { ObservationEnvelope } from '../../domain/value-objects/ObservationEnvelope.vo.js';
import type {
  PublishProjectObservationPort,
  PublishProjectObservationRequest,
  PublishProjectObservationResult,
} from '../ports/in/PublishProjectObservationPort.in-port.js';
import type { ObservationPublicationPort } from '../ports/out/ObservationPublicationPort.out-port.js';

export interface PublishProjectObservationDependencies {
  readonly publicationPort: ObservationPublicationPort;
}

function isFilled(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export class PublishProjectObservationUseCase implements PublishProjectObservationPort {
  constructor(private readonly deps?: PublishProjectObservationDependencies) {}

  async publishProjectObservation(
    request: PublishProjectObservationRequest,
  ): Promise<PublishProjectObservationResult> {
    return this.execute(request);
  }

  async execute(input: unknown): Promise<PublishProjectObservationResult> {
    if (typeof input !== 'object' || input === null || !this.deps) {
      throw new Error('Not implemented: PublishProjectObservationUseCase');
    }
    const request = input as PublishProjectObservationRequest;
    if (
      !isFilled(request.observationId) ||
      !isFilled(request.projectId) ||
      !isFilled(request.eventKind) ||
      !isFilled(request.payloadSummary) ||
      (request.sourceAttemptId !== null && !isFilled(request.sourceAttemptId))
    ) {
      throw new Error('Not implemented: PublishProjectObservationUseCase');
    }
    // The composition root supplies the clock; no authority depends on it here.
    const recordedAtIso = isFilled(request.nowIso) ? request.nowIso : new Date().toISOString();
    const created = ObservationEnvelope.create({
      observationId: request.observationId.trim(),
      projectId: request.projectId.trim(),
      eventKind: request.eventKind.trim(),
      sourceAttemptId:
        request.sourceAttemptId === null ? null : request.sourceAttemptId.trim(),
      payloadSummary: request.payloadSummary.trim(),
      recordedAtIso,
    });
    if (!created.success || created.value === undefined) {
      throw new Error('Not implemented: PublishProjectObservationUseCase');
    }
    const envelope = created.value.getProps();
    const outcome = await this.deps.publicationPort.publishObservationSnapshot(envelope);
    if (outcome.outcome === 'delivery-gap') {
      // The gap is preserved, not thrown away and not retried as another fact.
      return {
        outcome: 'delivery-gap',
        observationId: envelope.observationId,
        reason: outcome.reason,
      };
    }
    return { outcome: 'published', observationId: envelope.observationId };
  }
}
