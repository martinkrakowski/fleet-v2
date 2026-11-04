/**
 * Owner notification domain rules are pure: the fixed trigger names, the id
 * slug pattern, the fixed text template per trigger and the rate-limit key.
 * A notification names only ids and kinds — it never carries lane output,
 * brief text or a path — so the text is rendered here from a fixed template
 * and never taken from a caller. The module imports nothing.
 */

/** The four owner-notification triggers, fixed by the plan. */
export const OWNER_NOTIFICATION_TRIGGERS = [
  'attempt-ended',
  'attempt-blocked',
  'question-asked',
  'acceptance-blocker',
] as const;

export type OwnerNotificationTrigger = (typeof OWNER_NOTIFICATION_TRIGGERS)[number];

/**
 * An id slug: printable, never a path, a space or a control character
 * (§3.10.3 style).
 */
export const OWNER_NOTIFICATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isOwnerNotificationTrigger(value: unknown): value is OwnerNotificationTrigger {
  return (
    typeof value === 'string' &&
    (OWNER_NOTIFICATION_TRIGGERS as readonly string[]).includes(value)
  );
}

export function isOwnerNotificationId(value: unknown): value is string {
  return typeof value === 'string' && OWNER_NOTIFICATION_ID_PATTERN.test(value);
}

/** The fixed text template per trigger; the id is substituted, nothing else. */
const OWNER_NOTIFICATION_TEMPLATES: Record<OwnerNotificationTrigger, string> = {
  'attempt-ended': 'Attempt {id} ended: collect is available',
  'attempt-blocked': 'Attempt {id} blocked: owner attention is needed',
  'question-asked': 'Owner question {id} asked: an answer is needed',
  'acceptance-blocker': 'Acceptance {id} blocked: a blocker was recorded',
};

/** Render the fixed notification text for a trigger and an id. */
export function ownerNotificationText(trigger: OwnerNotificationTrigger, id: string): string {
  return OWNER_NOTIFICATION_TEMPLATES[trigger].replace('{id}', id);
}

/**
 * The rate-limit key: the trigger is part of the key, so an attempt that
 * blocks and later ends produces both notifications.
 */
export function ownerNotificationRateLimitKey(trigger: OwnerNotificationTrigger, id: string): string {
  return `${trigger}:${id}`;
}
