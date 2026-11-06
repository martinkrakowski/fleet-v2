// @generated outbound contract scaffold — refined for lane WB5a-store.
/**
 * MergeRecordRepositoryPort stores one merge record per (repository, pull
 * request number) under the store's lock. The first sighting is kept and a
 * later sighting never rewrites it. A conflicting sighting of the same key is
 * an integrity finding rather than an overwrite, and an unreadable or
 * unknown-version store is reported, never treated as empty.
 */

import type { MergeRecordRecord } from '../../../domain/entities/MergeRecord.js';

export type MergeRecordSaveOutcome =
  | { readonly outcome: 'created'; readonly record: MergeRecordRecord }
  | { readonly outcome: 'unchanged'; readonly record: MergeRecordRecord }
  | { readonly outcome: 'merger-upgraded'; readonly record: MergeRecordRecord }
  | { readonly outcome: 'integrity-conflict'; readonly record: MergeRecordRecord }
  | { readonly outcome: 'refused'; readonly code: 'invalid' };

export interface MergeRecordRepositoryPort {
  /** Create-if-absent under the store's lock. The first sighting is kept. */
  saveMergeRecord(record: MergeRecordRecord): Promise<MergeRecordSaveOutcome>;
  /** Known absence is null. An unreadable or unknown-version store is reported, never null. */
  findMergeRecord(repository: string, number: number): Promise<MergeRecordRecord | null>;
  /** Every stored record. An unreadable or unknown-version store is reported, never an empty list. */
  listMergeRecords(): Promise<readonly MergeRecordRecord[]>;
}
