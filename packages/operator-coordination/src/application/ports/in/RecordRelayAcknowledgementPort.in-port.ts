// @generated inbound contract scaffold — refined for step 5.
/**
 * RecordRelayAcknowledgementPort: record an actual recipient response and its
 * provenance. Silence, a read receipt or a transport acknowledgement is not a
 * response and is refused here.
 */

import type {
  CoordinationRequestRecord,
  RelayAcknowledgementRecord,
} from '../../../domain/coordination-records.js';

export interface RecordRelayAcknowledgementRequest {
  readonly acknowledgementId: string;
  readonly requestId: string;
  readonly recipientId: string;
  readonly responseSummary: string;
  readonly provenance: string;
  readonly nowIso?: string;
}

export type RecordRelayAcknowledgementResult =
  | {
      readonly outcome: 'acknowledged';
      readonly request: CoordinationRequestRecord;
      readonly acknowledgement: RelayAcknowledgementRecord;
    }
  | {
      readonly outcome: 'rejected';
      readonly reason: string;
    };

export interface RecordRelayAcknowledgementPort {
  recordRelayAcknowledgement(
    request: RecordRelayAcknowledgementRequest,
  ): Promise<RecordRelayAcknowledgementResult>;
}
