// @generated outbound contract scaffold — refined for lane LB2-1.
/**
 * SnapshotPushPort pushes one token-only section snapshot to the snapshot
 * receiver (lanes-board plan §5.3). Pushed, refused and unavailable are named
 * results, never guesses; no credential or endpoint crosses the port.
 */

import type { SectionSnapshotPush } from '../../../domain/snapshot-sections.js';

export type SnapshotPushRefusalReason = 'non-increasing-revision' | 'invalid' | 'unauthorized';

export type SnapshotPushUnavailableReason = 'transport-error' | 'timeout' | 'not-configured';

export type SnapshotPushOutcome =
  | { readonly outcome: 'pushed' }
  | { readonly outcome: 'refused'; readonly reason: SnapshotPushRefusalReason }
  | { readonly outcome: 'unavailable'; readonly reason: SnapshotPushUnavailableReason };

export interface SnapshotPushPort {
  /** Push one section snapshot; the receiver replaces only that section's key. */
  push(snapshot: SectionSnapshotPush): Promise<SnapshotPushOutcome>;
}
