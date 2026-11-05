// @generated outbound contract scaffold — refined for lane DT9c.
/**
 * MergeNotificationPort emits one notification per (event, id) for the merge
 * pass through operator coordination. The request carries an event, an id and
 * the idempotence key and nothing else: no path, no title, no free text. The
 * adapter renders a fixed text per event and answers `duplicate` for a key it
 * has already delivered, so a replayed pass never notifies twice.
 */
import type { MergeNotificationEvent } from '../../../domain/merge-pass-transitions.js';

export interface MergeNotificationRequest {
  readonly event: MergeNotificationEvent;
  /** A queue entry id (ULID); never a path, a title or free text. */
  readonly id: string;
  /** `<event>:<id>`; the adapter delivers at most once per key. */
  readonly key: string;
  readonly deadlineIso: string;
}

export type MergeNotificationOutcome =
  | { readonly outcome: 'notified' | 'duplicate' }
  | { readonly outcome: 'suppressed'; readonly reason: string }
  | { readonly outcome: 'refused'; readonly reason: string };

export interface MergeNotificationPort {
  notifyMergeEvent(request: MergeNotificationRequest): Promise<MergeNotificationOutcome>;
}
