// @generated inbound contract scaffold — refined for lane DT4.
import type { MergeQueueEnqueueCommand } from '../out/MergeQueueRepositoryPort.out-port.js';
import type { MergeEnqueueDecision } from '../../../domain/merge-queue-operations.js';

/** Enqueue one pull request head for the merge pass by conductor or CLI. */
export interface EnqueueMergePort {
  enqueue(request: MergeQueueEnqueueCommand): Promise<MergeEnqueueDecision>;
}
