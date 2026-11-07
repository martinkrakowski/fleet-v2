// Refined outbound contract for lane K11a2.
/**
 * ReaperFindingRepositoryPort: the versioned, CAS-on-revision store of reaper
 * findings. The store keeps one finding per open `(subject, kind)` pair; an
 * upsert is an atomic find-or-create under the store's lock, so a driver pass
 * and a standalone pass share one `findingId` and therefore one repair key.
 * An unreadable or unknown-version store is reported, never treated as empty.
 */

import type { ReaperFinding } from '../../../domain/reaper-findings.js';

/** One stored finding with the revision its callers compare-and-set on. */
export interface ReaperFindingStoreRecord {
  readonly findingId: string;
  readonly revision: number;
  readonly state: 'open' | 'closed';
  readonly finding: ReaperFinding;
}

export type UpsertReaperFindingResult =
  | { readonly outcome: 'stored'; readonly record: ReaperFindingStoreRecord }
  | { readonly outcome: 'refused'; readonly reason: string };

export type CloseReaperFindingResult =
  | { readonly outcome: 'stored'; readonly record: ReaperFindingStoreRecord }
  | { readonly outcome: 'conflict'; readonly record: ReaperFindingStoreRecord }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'refused'; readonly reason: string };

export interface ReaperFindingRepositoryPort {
  /**
   * Atomic find-or-create under the store's lock: an open record for the
   * finding's `(kind, subject)` keeps its `findingId` and moves the revision;
   * otherwise the supplied `findingId` creates the record open at revision 1.
   * A refused write stores nothing.
   */
  upsertFinding(finding: ReaperFinding, findingId: string): Promise<UpsertReaperFindingResult>;

  /** Every open record, sorted by `kind` then `subject`. */
  listOpenFindings(): Promise<readonly ReaperFindingStoreRecord[]>;

  /**
   * Close by CAS on the revision: a revision mismatch writes nothing and
   * answers `conflict`; an unknown `findingId` answers `not-found`.
   */
  closeFinding(findingId: string, expectedRevision: number): Promise<CloseReaperFindingResult>;
}
