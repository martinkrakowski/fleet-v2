// @generated inbound contract scaffold — refined for lane DT4.
import type { MergeQueueListQuery } from '../out/MergeQueueRepositoryPort.out-port.js';
import type {
  MergeQueueEntryRecord,
  MergeQueueRepositoryRef,
} from '../../../domain/merge-queue-records.js';
import type { BaseBranchValue } from '../../../domain/base-branch.js';

/** The read-only merge-queue view: ordered live entries and a head per (repository, base). */
export interface MergeQueueView {
  readonly entries: readonly MergeQueueEntryRecord[];
  readonly heads: readonly {
    readonly repository: MergeQueueRepositoryRef;
    readonly baseBranch: BaseBranchValue;
    readonly headEntryId: string | null;
  }[];
}

/** List merge-queue entries live-first in queue order with the head per base named. */
export interface ListMergeQueuePort {
  list(query: MergeQueueListQuery): Promise<MergeQueueView>;
}
