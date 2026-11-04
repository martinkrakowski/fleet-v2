// @generated inbound contract scaffold — refined for lane E4 part 1.
/**
 * OwnerNotificationPort: raise one owner notification for a trigger and an
 * id. The text is rendered from a fixed template per trigger, names only ids
 * and kinds, is rate limited by (trigger, id), and honours the notification
 * switch; it never carries lane output, brief text or a path.
 */

import type { OwnerNotificationTrigger } from '../../../domain/owner-notification.js';

/**
 * The request carries a trigger and an id and nothing else — no free text,
 * no path, no lane output, ever. The text is rendered inside the use case.
 */
export interface OwnerNotificationRequest {
  readonly trigger: OwnerNotificationTrigger;
  readonly id: string;
}

export type OwnerNotificationOutcome =
  | {
      readonly outcome: 'notified';
      readonly text: string;
    }
  | {
      readonly outcome: 'suppressed';
      readonly reason: 'rate-limited' | 'delivery-unavailable' | 'notifications-disabled';
    }
  | {
      readonly outcome: 'refused';
      readonly reason: string;
    };

export interface OwnerNotificationPort {
  notifyOwner(request: OwnerNotificationRequest): Promise<OwnerNotificationOutcome>;
}
