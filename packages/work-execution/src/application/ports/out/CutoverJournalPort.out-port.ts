// @generated outbound contract scaffold — refined for lane CO27.
/**
 * CutoverJournalPort: append keyed cutover and relaunch journal entries
 * (`cutover/<move>@<revision>` and `relaunch/<planDigest>/<lane>/<step>`)
 * under the store's guard. An intent is durable before its action, a second
 * intent with the same key is refused, a result pairs with its intent and only
 * ambiguous results may precede the one final result. Listing is by key prefix
 * in append order; an unreadable journal is reported, never empty. Entries
 * hold ids, codes and digests only.
 */

export type CutoverJournalEntryKind = 'intent' | 'result';
export type CutoverJournalOutcome = 'completed' | 'refused' | 'ambiguous';

export interface CutoverJournalEntry {
  /** `cutover/<move>@<revision>` or `relaunch/<planDigest>/<lane>/<step>`. */
  readonly key: string;
  readonly kind: CutoverJournalEntryKind;
  /** A ULID minted by the caller. */
  readonly entryId: string;
  readonly recordedAtIso: string;
  /** Results only. */
  readonly outcome?: CutoverJournalOutcome;
  /** A fixed token such as `saved` or `already-saved` (results only). */
  readonly reasonCode?: string | null;
  /** The tree digest of the save (results only). */
  readonly digest?: string | null;
  /** The saved commit id (results only). */
  readonly commitId?: string | null;
  /** The save ref (results only). */
  readonly saveRef?: string | null;
}

export type CutoverJournalRefusalCode =
  | 'invalid-entry'
  | 'invalid-key'
  | 'duplicate-intent'
  | 'result-without-intent'
  | 'result-after-final-result'
  | 'intent-after-result'
  | 'store-unreadable'
  | 'store-read-only';

export type CutoverJournalAppendResult =
  | { readonly outcome: 'appended'; readonly entry: CutoverJournalEntry }
  | { readonly outcome: 'refused'; readonly reason: CutoverJournalRefusalCode };

export type CutoverJournalListResult =
  | { readonly outcome: 'listed'; readonly entries: readonly CutoverJournalEntry[] }
  | { readonly outcome: 'unreadable' };

export interface CutoverJournalPort {
  /** Validate and append one entry under the store's guard; a refusal writes nothing. */
  append(entry: CutoverJournalEntry): Promise<CutoverJournalAppendResult>;
  /** Every entry whose key starts with `prefix`, in append order. */
  listByKeyPrefix(prefix: string): Promise<CutoverJournalListResult>;
}
