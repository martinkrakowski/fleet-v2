// @generated use-case scaffold — refined for lane DT4.
import type { MergeQueueEnqueueCommand, MergeQueueRepositoryPort } from '../ports/out/MergeQueueRepositoryPort.out-port.js';
import type { MergeEnqueueDecision } from '../../domain/merge-queue-operations.js';
import type { EnqueueMergePort } from '../ports/in/EnqueueMergePort.in-port.js';

const REPOSITORY_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

/** Enqueue one pull request head; validates the request envelope before delegating. */
export class EnqueueMergeUseCase implements EnqueueMergePort {
  constructor(private readonly deps: { readonly queue: MergeQueueRepositoryPort }) {}

  async enqueue(request: MergeQueueEnqueueCommand): Promise<MergeEnqueueDecision> {
    if (!this.isValidRequest(request)) {
      return { outcome: 'refused', reason: 'invalid-repository' };
    }
    return this.deps.queue.enqueueMergeEntry(request);
  }

  private isValidRequest(request: MergeQueueEnqueueCommand): boolean {
    const { owner, repo } = request.repository;
    if (!REPOSITORY_SEGMENT_PATTERN.test(owner) || !REPOSITORY_SEGMENT_PATTERN.test(repo)) {
      return false;
    }
    if (owner === '.' || owner === '..' || repo === '.' || repo === '..') {
      return false;
    }
    return Number.isSafeInteger(request.pullRequest) && request.pullRequest >= 1;
  }
}
