// @generated adapter stub — refined for step 5 (no behaviour).
/**
 * RelayTransportAdapter implements RelayTransportPort
 * (harness-notice-channel-or-local-outbox). Implementation lands in a later
 * step; it refuses rather than fabricating a delivery receipt.
 */

import type {
  RelayDeliveryOutcome,
  RelayNoticeRequest,
  RelayTransportPort,
} from '../../application/ports/out/RelayTransportPort.out-port.js';

export class RelayTransportAdapter implements RelayTransportPort {
  async deliverRelayNotice(_request: RelayNoticeRequest): Promise<RelayDeliveryOutcome> {
    throw new Error('Not implemented: RelayTransportAdapter.deliverRelayNotice');
  }
}
