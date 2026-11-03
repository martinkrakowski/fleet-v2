// @generated outbound contract scaffold — refined for lane WB4c.
/**
 * BriefReadRepositoryPort stores one latest brief read per lane (work-board
 * plan §3.6): the guard reads the latest read, so `put` replaces that lane's
 * read under a compare-and-swap on the whole list under the store's
 * exclusive lock.
 */
import type { BriefReadRecord } from '../../../domain/lane-activity-records.js';
import type { LaneRef } from '../../../domain/work-board-facts.js';

export type PutBriefReadResult =
  | { readonly outcome: 'saved'; readonly revision: number }
  | { readonly outcome: 'refused'; readonly reason: string };

export interface BriefReadRepositoryPort {
  /** The lane's latest read, or null when the lane has none. */
  latest(lane: LaneRef): Promise<BriefReadRecord | null>;
  /** Replace the lane's latest read with this already-valid record. */
  put(record: BriefReadRecord): Promise<PutBriefReadResult>;
}
