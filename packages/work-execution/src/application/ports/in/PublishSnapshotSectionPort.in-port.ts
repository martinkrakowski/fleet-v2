// @generated inbound contract scaffold — refined for lane LB2-1.
import type {
  PublisherSection,
  SnapshotBuildFailureReason,
} from '../../../domain/snapshot-publishers.js';
import type { LaneServerSessionUnavailableReason } from '../out/LaneServerSessionReadPort.out-port.js';
import type {
  SnapshotPushRefusalReason,
  SnapshotPushUnavailableReason,
} from '../out/SnapshotPushPort.out-port.js';

export interface PublishSnapshotSectionRequest {
  readonly section: PublisherSection;
  /** A positive safe integer, increasing per publisher and section. */
  readonly revision: number;
  readonly pushedAtIso: string;
  /** The deadline for the merge-queue read; defaults to `pushedAtIso`. */
  readonly deadlineIso?: string;
}

export type PublishSnapshotRefusalReason = SnapshotBuildFailureReason | SnapshotPushRefusalReason;

export type PublishSnapshotUnavailableReason =
  | 'source-unreadable'
  | LaneServerSessionUnavailableReason
  | SnapshotPushUnavailableReason;

export type PublishSnapshotSectionResult =
  | {
      readonly outcome: 'published';
      readonly section: PublisherSection;
      readonly revision: number;
      readonly tokenCount: number;
    }
  | { readonly outcome: 'refused'; readonly reason: PublishSnapshotRefusalReason }
  | { readonly outcome: 'unavailable'; readonly reason: PublishSnapshotUnavailableReason };

/**
 * Publish one token-only snapshot section; reads owning state only and never
 * writes lane, run, queue or park state.
 */
export interface PublishSnapshotSectionPort {
  publish(request: PublishSnapshotSectionRequest): Promise<PublishSnapshotSectionResult>;
}
