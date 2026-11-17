// @generated outbound contract scaffold — refined for lane K1b-3.
/**
 * LaneRunJournalPort: the keyed run journal of plan §3.2. Append-only; one
 * store per state directory. The uniqueness and stop checks run under the
 * store's guard, so a refused append wrote nothing.
 */

import type {
  LaneRunJournalEntryRecord,
  LaneRunJournalRefusal,
} from '../../../domain/lane-run-journal.js';

export type LaneRunJournalAppendResult =
  | { readonly outcome: 'appended'; readonly entry: LaneRunJournalEntryRecord }
  | { readonly outcome: 'refused'; readonly reason: LaneRunJournalRefusal; readonly detail: string | null };

export interface LaneRunJournalPort {
  /** Validate and append one entry under the store's guard; a refusal writes nothing. */
  append(entry: LaneRunJournalEntryRecord): Promise<LaneRunJournalAppendResult>;
  /** Every entry whose runId is `runId`, in append order; [] for an unknown or malformed run id. */
  listForRun(runId: string): Promise<readonly LaneRunJournalEntryRecord[]>;
  /**
   * Optional grouped read: every requested run id's entries in one read of the
   * store. Every requested id is present in the returned map (`[]` when it has
   * no entries), and each list is in append order, exactly as `listForRun`
   * returns it. Non-string ids are ignored, as in `listForRun`.
   */
  listForRuns?(runIds: readonly string[]): Promise<ReadonlyMap<string, readonly LaneRunJournalEntryRecord[]>>;
  /** The intent and results of one key, in append order (request and reaper keys have no run); [] when none. */
  listForKey(key: string): Promise<readonly LaneRunJournalEntryRecord[]>;
  /**
   * Optional prefix read: every entry whose `key` starts with `prefix`, in
   * append order, from a single underlying read of the store. An invalid
   * prefix (per the adapter's validation) returns [] rather than throwing or
   * refusing.
   */
  listForKeyPrefix?(prefix: string): Promise<readonly LaneRunJournalEntryRecord[]>;
}
