// @generated inbound contract scaffold — refined for step 5.
/**
 * PublishProjectObservationPort: publish the owning project's explicit events
 * and derived facts while preserving disagreements and delivery failures. A
 * publication gap is reported as a gap, not silently dropped or retried as a
 * different fact.
 */

export interface PublishProjectObservationRequest {
  readonly observationId: string;
  readonly projectId: string;
  readonly eventKind: string;
  readonly sourceAttemptId: string | null;
  readonly payloadSummary: string;
  readonly nowIso?: string;
}

export type PublishProjectObservationResult =
  | {
      readonly outcome: 'published';
      readonly observationId: string;
    }
  | {
      readonly outcome: 'delivery-gap';
      readonly observationId: string;
      readonly reason: string;
    };

export interface PublishProjectObservationPort {
  publishProjectObservation(
    request: PublishProjectObservationRequest,
  ): Promise<PublishProjectObservationResult>;
}
