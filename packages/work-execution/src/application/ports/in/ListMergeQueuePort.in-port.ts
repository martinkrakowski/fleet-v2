// @generated inbound contract scaffold — refined for lane DT4.
import type { MergeQueueListQuery } from '../out/MergeQueueRepositoryPort.out-port.js';
import type {
  MergeQueueEntryRecord,
  MergeQueueRepositoryRef,
} from '../../../domain/merge-queue-records.js';

/** The read-only merge-queue view: ordered live entries and a head per repository. */
export interface MergeQueueView {
  readonly entries: readonly MergeQueueEntryRecord[];
  readonly heads: readonly {
    readonly repository: MergeQueueRepositoryRef;
    readonly headEntryId: string | null;
  }[];
}

/** List merge-queue entries live-first in queue order with the head per repository named. */
export interface ListMergeQueuePort {
  list(query: MergeQueueListQuery): Promise<MergeQueueView>;
}
