/**
 * NotifyOwnerUseCase implements OwnerNotificationPort. It renders the fixed
 * text for the trigger and id, applies the (trigger, id) rate limit, honours
 * the notification switch, and hands the message to the delivery port.
 *
 * A notification names only ids and kinds: the request carries a trigger and
 * an id and nothing else, and the text is rendered here, never taken from a
 * caller. The rate-limit memory is an in-memory set on the instance, capped
 * and dropped oldest first; nothing is persisted. An unavailable delivery
 * remembers nothing.
 */

import {
  isOwnerNotificationId,
  isOwnerNotificationTrigger,
  ownerNotificationRateLimitKey,
  ownerNotificationText,
} from '../../domain/owner-notification.js';
import type {
  OwnerNotificationOutcome,
  OwnerNotificationPort,
  OwnerNotificationRequest,
} from '../ports/in/OwnerNotificationPort.in-port.js';
import type { OwnerNotificationDeliveryPort } from '../ports/out/OwnerNotificationDeliveryPort.out-port.js';

/** The fixed title every owner notification carries. */
const OWNER_NOTIFICATION_TITLE = 'Fleet';

/** The rate-limit set never grows past this many keys; the oldest drops first. */
const RATE_LIMIT_CAPACITY = 500;

export interface NotifyOwnerDependencies {
  readonly delivery: OwnerNotificationDeliveryPort;
  readonly notificationsEnabled: boolean;
}

export class NotifyOwnerUseCase implements OwnerNotificationPort {
  /** In-memory rate-limit keys in insertion order; the oldest drops first. */
  private readonly notifiedKeys = new Set<string>();

  constructor(private readonly deps?: NotifyOwnerDependencies) {}

  async notifyOwner(request: OwnerNotificationRequest): Promise<OwnerNotificationOutcome> {
    return this.execute(request);
  }

  async execute(input: unknown): Promise<OwnerNotificationOutcome> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: NotifyOwnerUseCase');
    }
    if (typeof input !== 'object' || input === null) {
      return { outcome: 'refused', reason: 'a notification request must be an object' };
    }
    const request = input as OwnerNotificationRequest;
    // The trigger and the id are validated alone; any other field the caller
    // adds is ignored — the request never carries free text.
    if (!isOwnerNotificationTrigger(request.trigger)) {
      return {
        outcome: 'refused',
        reason: 'the notification trigger is not one of the known triggers',
      };
    }
    if (!isOwnerNotificationId(request.id)) {
      return { outcome: 'refused', reason: 'the notification id is not an id slug' };
    }
    if (!this.deps.notificationsEnabled) {
      return { outcome: 'suppressed', reason: 'notifications-disabled' };
    }
    const key = ownerNotificationRateLimitKey(request.trigger, request.id);
    if (this.notifiedKeys.has(key)) {
      return { outcome: 'suppressed', reason: 'rate-limited' };
    }
    // The text is rendered from the fixed template; nothing from the caller
    // reaches the message.
    const text = ownerNotificationText(request.trigger, request.id);
    try {
      const receipt = await this.deps.delivery.deliverOwnerNotification({
        title: OWNER_NOTIFICATION_TITLE,
        body: text,
      });
      if (receipt.outcome !== 'delivered') {
        // An unavailable delivery is remembered by nothing.
        return { outcome: 'suppressed', reason: 'delivery-unavailable' };
      }
    } catch {
      return { outcome: 'suppressed', reason: 'delivery-unavailable' };
    }
    this.remember(key);
    return { outcome: 'notified', text };
  }

  /** Record the key, dropping the oldest first once the set is at capacity. */
  private remember(key: string): void {
    if (this.notifiedKeys.has(key)) {
      return;
    }
    while (this.notifiedKeys.size >= RATE_LIMIT_CAPACITY) {
      const oldest = this.notifiedKeys.values().next();
      if (oldest.done) {
        break;
      }
      this.notifiedKeys.delete(oldest.value);
    }
    this.notifiedKeys.add(key);
  }
}
