// @generated outbound contract scaffold — refined for lane E4 part 1.
/**
 * OwnerNotificationDeliveryPort: deliver one owner notification message to a
 * local channel. A channel that cannot deliver is a value, never a throw —
 * the use case decides what an unavailable channel means.
 */

export interface OwnerNotificationMessage {
  readonly title: string;
  readonly body: string;
}

export type OwnerNotificationDeliveryOutcome =
  | {
      readonly outcome: 'delivered';
    }
  | {
      readonly outcome: 'unavailable';
      readonly reason: string;
    };

export interface OwnerNotificationDeliveryPort {
  deliverOwnerNotification(message: OwnerNotificationMessage): Promise<OwnerNotificationDeliveryOutcome>;
}
