// @generated outbound contract scaffold — refined for lane DT4.
import type { MergeQueueEntryRecord } from '../../../domain/merge-queue-records.js';
import type {
  MergeEnqueueDecision,
  MergeDropDecision,
  MergeRetryDecision,
} from '../../../domain/merge-queue-operations.js';

export interface MergeQueueEnqueueCommand {
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly pullRequest: number;
  readonly headOid: string;
  readonly tier: number;
  readonly enqueuedBy: 'conductor' | 'cli';
  readonly runId: string | null;
  readonly entryId: string;
  readonly successorEntryId: string;
  readonly enqueuedAtIso: string;
  readonly deadlineIso: string;
}

export interface MergeQueueDropCommand {
  readonly entryId: string;
  readonly deadlineIso: string;
}

export interface MergeQueueRetryCommand {
  readonly entryId: string;
  readonly retryEntryId: string;
  readonly enqueuedAtIso: string;
  readonly deadlineIso: string;
}

export interface MergeQueueListQuery {
  readonly repository?: { readonly owner: string; readonly repo: string };
  readonly deadlineIso: string;
}

/** Persist merge-queue entries v1 by identity; known absence is an empty list. */
export interface MergeQueueRepositoryPort {
  enqueueMergeEntry(command: MergeQueueEnqueueCommand): Promise<MergeEnqueueDecision>;
  dropMergeEntry(command: MergeQueueDropCommand): Promise<MergeDropDecision>;
  retryMergeEntry(command: MergeQueueRetryCommand): Promise<MergeRetryDecision>;
  listMergeEntries(query: MergeQueueListQuery): Promise<readonly MergeQueueEntryRecord[]>;
}
