// @generated adapter stub — edit freely
/**
 * MergeNotificationAdapter implements MergeNotificationPort
 *
 * DT9c declares the contract; lane DT12 implements delivery over operator
 * coordination. Until then the adapter fails closed: it delivers nothing and
 * refuses, so the merge pass never records a transition it could not announce.
 */

import type {
  MergeNotificationOutcome,
  MergeNotificationPort,
  MergeNotificationRequest,
} from '../../application/ports/out/MergeNotificationPort.out-port.js';

export class MergeNotificationAdapter implements MergeNotificationPort {
  async notifyMergeEvent(_request: MergeNotificationRequest): Promise<MergeNotificationOutcome> {
    return { outcome: 'refused', reason: 'not-implemented' };
  }
}
