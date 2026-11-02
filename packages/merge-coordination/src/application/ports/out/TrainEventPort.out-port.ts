// @generated outbound contract scaffold — refined for lane MC5.
/**
 * Append keyed, ordered train events to one train's journal, only under the
 * current, unexpired lease holder's fence. A repeated key with the same
 * event is a duplicate that writes nothing; the same key with another event
 * is refused. Listing answers in append order, and an unreadable journal is
 * reported, never repaired or guessed.
 */
import type { TrainLeaseRefusal } from '../../use-cases/train-lease.js';
import type { TrainEventValue } from '../../../domain/value-objects/TrainEvent.vo.js';

/** One event to append: its idempotency key, the event, and when it happened. */
export interface TrainJournalEntryInput {
  readonly key: string;
  readonly event: TrainEventValue;
  readonly atIso: string;
}

/** One journal entry as stored: the input fields plus the record's shape. */
export interface TrainJournalEntry extends TrainJournalEntryInput {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly fence: number;
}

export interface TrainJournalAppendRequest {
  readonly trainId: string;
  readonly holderId: string;
  readonly fence: number;
  readonly nowIso: string;
  readonly entry: TrainJournalEntryInput;
}

export type TrainJournalAppendResult =
  | { readonly outcome: 'appended'; readonly entry: TrainJournalEntry }
  | { readonly outcome: 'duplicate'; readonly entry: TrainJournalEntry }
  | {
      readonly outcome: 'refused';
      readonly reason: TrainLeaseRefusal | 'lease-unreadable' | 'invalid-entry' | 'key-conflict' | 'journal-unreadable';
    };

export type TrainJournalRead =
  | { readonly outcome: 'ok'; readonly entries: readonly TrainJournalEntry[] }
  | { readonly outcome: 'unreadable' };

export interface TrainEventPort {
  append(request: TrainJournalAppendRequest): Promise<TrainJournalAppendResult>;
  list(trainId: string): Promise<TrainJournalRead>;
}
