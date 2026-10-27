// @generated inbound contract scaffold — refined for lane A-J.
/**
 * ListAttemptJournalPort: return one attempt's action journal entries in
 * recorded order, read-only; never contacts the runner and carries no legality
 * or next-action block.
 */

import type { ActionJournalEntryRecord } from '../../../domain/execution-records.js';

export interface ListAttemptJournalRequest {
  readonly attemptId: string;
}

export type ListAttemptJournalResult =
  | {
      readonly outcome: 'listed';
      readonly attemptId: string;
      /** Recorded order, as the journal holds them; no legality or next-action block. */
      readonly entries: readonly ActionJournalEntryRecord[];
    }
  | { readonly outcome: 'not-found'; readonly attemptId: string };

export interface ListAttemptJournalPort {
  /** List one attempt's journal entries without modifying state or invoking the runner. */
  listAttemptJournal(request: ListAttemptJournalRequest): Promise<ListAttemptJournalResult>;
}
