// @generated outbound contract scaffold — refined for step 5.
/**
 * RelayTransportPort: deliver notices or write a local outbox and return
 * transport receipts without inferring acceptance. A receipt proves delivery
 * only; recipient acknowledgement is a separate, recorded fact.
 */

export interface RelayNoticeRequest {
  readonly requestId: string;
  readonly projectId: string;
  readonly recipientId: string;
  readonly summary: string;
}

export type RelayDeliveryOutcome =
  | {
      readonly outcome: 'delivered';
    }
  | {
      readonly outcome: 'delivery-gap';
      readonly reason: string;
    };

export interface RelayTransportPort {
  deliverRelayNotice(request: RelayNoticeRequest): Promise<RelayDeliveryOutcome>;
}
