/**
 * Lane E4 part 1 unit tests for NotifyOwnerUseCase.
 *
 * The pinned rule: a notification names only ids and kinds. The delivered
 * body is always the fixed template with the id substituted — extra request
 * fields never reach it — and every refusal, suppression and rate-limit path
 * delivers nothing. The rate-limit memory is per use case instance.
 */

import { describe, expect, it } from 'vitest';

import {
  OWNER_NOTIFICATION_TRIGGERS,
  ownerNotificationText,
  type OwnerNotificationTrigger,
} from '../../../domain/owner-notification.js';
import type { OwnerNotificationDeliveryPort } from '../../ports/out/OwnerNotificationDeliveryPort.out-port.js';
import { NotifyOwnerUseCase } from '../NotifyOwnerUseCase.use-case.js';

/** A delivery fake that records every message it is asked to deliver. */
class FakeDelivery implements OwnerNotificationDeliveryPort {
  readonly messages: { title: string; body: string }[] = [];
  reportUnavailable: string | null = null;
  throwOnDeliver = false;
  deliverHook?: () => Promise<void>;

  async deliverOwnerNotification(
    message: { title: string; body: string },
  ): Promise<{ outcome: 'delivered' } | { outcome: 'unavailable'; reason: string }> {
    if (this.deliverHook) {
      await this.deliverHook();
    }
    if (this.throwOnDeliver) {
      throw new Error('the injected runner exploded');
    }
    if (this.reportUnavailable !== null) {
      return { outcome: 'unavailable', reason: this.reportUnavailable };
    }
    this.messages.push({ title: message.title, body: message.body });
    return { outcome: 'delivered' };
  }
}

function useCaseWith(
  delivery: FakeDelivery,
  notificationsEnabled = true,
): NotifyOwnerUseCase {
  return new NotifyOwnerUseCase({ delivery, notificationsEnabled });
}

describe('NotifyOwnerUseCase', () => {
  it('delivers one notification per trigger with the fixed title and the templated body', async () => {
    const delivery = new FakeDelivery();
    const useCase = useCaseWith(delivery);
    for (const trigger of OWNER_NOTIFICATION_TRIGGERS) {
      const outcome = await useCase.notifyOwner({ trigger, id: 'attempt-a1' });
      expect(outcome).toEqual({
        outcome: 'notified',
        text: ownerNotificationText(trigger, 'attempt-a1'),
      });
    }
    expect(delivery.messages).toHaveLength(OWNER_NOTIFICATION_TRIGGERS.length);
    for (const message of delivery.messages) {
      expect(message.title).toBe('Fleet');
      expect(message.body).not.toContain('/');
    }
    expect(delivery.messages.map((m) => m.body)).toEqual([
      'Attempt attempt-a1 ended: collect is available',
      'Attempt attempt-a1 blocked: owner attention is needed',
      'Owner question attempt-a1 asked: an answer is needed',
      'Acceptance attempt-a1 blocked: a blocker was recorded',
    ]);
  });

  it('never delivers text the caller smuggled in through an extra field', async () => {
    const delivery = new FakeDelivery();
    const useCase = useCaseWith(delivery);
    const smuggled = 'lane output /etc/passwd with brief text';
    const outcome = await useCase.execute({
      trigger: 'attempt-ended',
      id: 'attempt-smuggled',
      body: smuggled,
      text: smuggled,
      path: smuggled,
    } as unknown);
    expect(outcome).toEqual({
      outcome: 'notified',
      text: ownerNotificationText('attempt-ended', 'attempt-smuggled'),
    });
    expect(delivery.messages).toHaveLength(1);
    expect(delivery.messages[0].body).toBe(
      ownerNotificationText('attempt-ended', 'attempt-smuggled'),
    );
    expect(delivery.messages[0].body).not.toContain('lane output');
    expect(delivery.messages[0].title).toBe('Fleet');
  });

  it('refuses an id that is not an id slug and delivers nothing', async () => {
    const delivery = new FakeDelivery();
    const useCase = useCaseWith(delivery);
    for (const id of ['attempt/a1', 'has space', '../escape', '']) {
      const outcome = await useCase.notifyOwner({
        trigger: 'attempt-ended',
        id,
      } as { trigger: OwnerNotificationTrigger; id: string });
      expect(outcome).toEqual({
        outcome: 'refused',
        reason: 'the notification id is not an id slug',
      });
    }
    expect(delivery.messages).toHaveLength(0);
  });

  it('refuses an unknown trigger', async () => {
    const delivery = new FakeDelivery();
    const useCase = useCaseWith(delivery);
    const outcome = await useCase.execute({ trigger: 'attempt-blasted', id: 'attempt-a1' });
    expect(outcome).toEqual({
      outcome: 'refused',
      reason: 'the notification trigger is not one of the known triggers',
    });
    expect(delivery.messages).toHaveLength(0);
  });

  it('rate limits by (trigger, id) and still delivers a different trigger for the same id', async () => {
    const delivery = new FakeDelivery();
    const useCase = useCaseWith(delivery);
    const first = await useCase.notifyOwner({ trigger: 'attempt-blocked', id: 'attempt-a1' });
    expect(first).toEqual({
      outcome: 'notified',
      text: ownerNotificationText('attempt-blocked', 'attempt-a1'),
    });
    const second = await useCase.notifyOwner({ trigger: 'attempt-blocked', id: 'attempt-a1' });
    expect(second).toEqual({ outcome: 'suppressed', reason: 'rate-limited' });
    expect(delivery.messages).toHaveLength(1);
    const otherTrigger = await useCase.notifyOwner({ trigger: 'attempt-ended', id: 'attempt-a1' });
    expect(otherTrigger).toEqual({
      outcome: 'notified',
      text: ownerNotificationText('attempt-ended', 'attempt-a1'),
    });
    expect(delivery.messages).toHaveLength(2);
  });

  it('suppresses everything when notifications are disabled and delivers nothing', async () => {
    const delivery = new FakeDelivery();
    const useCase = useCaseWith(delivery, false);
    for (const trigger of OWNER_NOTIFICATION_TRIGGERS) {
      const outcome = await useCase.notifyOwner({ trigger, id: 'attempt-a1' });
      expect(outcome).toEqual({ outcome: 'suppressed', reason: 'notifications-disabled' });
    }
    expect(delivery.messages).toHaveLength(0);
  });

  it('reports delivery-unavailable for an unavailable or throwing channel and remembers nothing', async () => {
    const unavailable = new FakeDelivery();
    unavailable.reportUnavailable = 'the notification daemon is not running';
    const unavailableCase = useCaseWith(unavailable);
    const first = await unavailableCase.notifyOwner({
      trigger: 'attempt-ended',
      id: 'attempt-a1',
    });
    expect(first).toEqual({ outcome: 'suppressed', reason: 'delivery-unavailable' });
    expect(unavailable.messages).toHaveLength(0);
    // The same instance, with the channel now healthy: the key was not
    // remembered by the failed delivery, so this notifies.
    unavailable.reportUnavailable = null;
    const recoveredAfterUnavailable = await unavailableCase.notifyOwner({
      trigger: 'attempt-ended',
      id: 'attempt-a1',
    });
    expect(recoveredAfterUnavailable).toEqual({
      outcome: 'notified',
      text: ownerNotificationText('attempt-ended', 'attempt-a1'),
    });
    expect(unavailable.messages).toHaveLength(1);

    const throwing = new FakeDelivery();
    throwing.throwOnDeliver = true;
    const throwingCase = useCaseWith(throwing);
    const second = await throwingCase.notifyOwner({
      trigger: 'attempt-ended',
      id: 'attempt-a1',
    });
    expect(second).toEqual({ outcome: 'suppressed', reason: 'delivery-unavailable' });
    expect(throwing.messages).toHaveLength(0);
    // The same throwing instance, now healthy: the key was not remembered.
    throwing.throwOnDeliver = false;
    const recoveredAfterThrow = await throwingCase.notifyOwner({
      trigger: 'attempt-ended',
      id: 'attempt-a1',
    });
    expect(recoveredAfterThrow).toEqual({
      outcome: 'notified',
      text: ownerNotificationText('attempt-ended', 'attempt-a1'),
    });
    expect(throwing.messages).toHaveLength(1);

    // For contrast, a key that was delivered is remembered on that same
    // instance: the follow-up call is rate-limited.
    const rateLimitedFollowUp = await unavailableCase.notifyOwner({
      trigger: 'attempt-ended',
      id: 'attempt-a1',
    });
    expect(rateLimitedFollowUp).toEqual({ outcome: 'suppressed', reason: 'rate-limited' });
    expect(unavailable.messages).toHaveLength(1);
  });

  it('handles two concurrent calls with one key, where the delivery port resolves after a deferred promise: exactly one delivery, and the other call returns rate-limited', async () => {
    const delivery = new FakeDelivery();
    let resolveDeferred!: () => void;
    const deferred = new Promise<void>((resolve) => {
      resolveDeferred = resolve;
    });
    delivery.deliverHook = () => deferred;
    const useCase = useCaseWith(delivery);

    const call1 = useCase.notifyOwner({ trigger: 'attempt-ended', id: 'attempt-a1' });
    const call2 = useCase.notifyOwner({ trigger: 'attempt-ended', id: 'attempt-a1' });

    // The second call arrives while the first is in flight, so it is rate-limited.
    expect(await call2).toEqual({ outcome: 'suppressed', reason: 'rate-limited' });
    expect(delivery.messages).toHaveLength(0);

    // After the deferred promise resolves, the first call completes delivery.
    resolveDeferred();
    expect(await call1).toEqual({
      outcome: 'notified',
      text: ownerNotificationText('attempt-ended', 'attempt-a1'),
    });
    expect(delivery.messages).toHaveLength(1);
    expect(delivery.messages[0]).toEqual({
      title: 'Fleet',
      body: ownerNotificationText('attempt-ended', 'attempt-a1'),
    });
  });

  it('a failed delivery, then a retry on the same instance, delivers once', async () => {
    const delivery = new FakeDelivery();
    delivery.reportUnavailable = 'the notification daemon is not running';
    const useCase = useCaseWith(delivery);

    const failed = await useCase.notifyOwner({
      trigger: 'attempt-ended',
      id: 'attempt-a1',
    });
    expect(failed).toEqual({ outcome: 'suppressed', reason: 'delivery-unavailable' });
    expect(delivery.messages).toHaveLength(0);

    delivery.reportUnavailable = null;
    const retry = await useCase.notifyOwner({
      trigger: 'attempt-ended',
      id: 'attempt-a1',
    });
    expect(retry).toEqual({
      outcome: 'notified',
      text: ownerNotificationText('attempt-ended', 'attempt-a1'),
    });
    expect(delivery.messages).toHaveLength(1);
  });

  it('throws the fixed not-implemented error when unconfigured', async () => {
    const useCase = new NotifyOwnerUseCase();
    await expect(useCase.notifyOwner({ trigger: 'attempt-ended', id: 'attempt-a1' })).rejects.toThrow(
      'Not implemented: NotifyOwnerUseCase',
    );
  });
});
