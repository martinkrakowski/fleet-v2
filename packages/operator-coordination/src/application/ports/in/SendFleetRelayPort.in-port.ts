// @generated inbound contract scaffold — refined for step 5.
/**
 * SendFleetRelayPort: send an attributed, authorized notice and keep delivery
 * distinct from recipient acknowledgement. A transport receipt proves delivery
 * only; it is never recorded as a response.
 */

import type { CoordinationRequestRecord } from '../../../domain/coordination-records.js';

export interface SendFleetRelayRequest {
  readonly requestId: string;
  readonly projectId: string;
  readonly recipientId: string;
  readonly summary: string;
  readonly policyRevision: string;
  readonly nowIso?: string;
}

export type SendFleetRelayResult =
  | {
      readonly outcome: 'delivered';
      readonly request: CoordinationRequestRecord;
    }
  | {
      readonly outcome: 'delivery-gap';
      readonly request: CoordinationRequestRecord;
      readonly reason: string;
    }
  | {
      readonly outcome: 'rejected';
      readonly reason: string;
    };

export interface SendFleetRelayPort {
  sendFleetRelay(request: SendFleetRelayRequest): Promise<SendFleetRelayResult>;
}
