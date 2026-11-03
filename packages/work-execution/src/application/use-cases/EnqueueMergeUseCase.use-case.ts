// @generated use-case scaffold — refined for lane DT4.
import type { MergeQueueEnqueueCommand, MergeQueueRepositoryPort } from '../ports/out/MergeQueueRepositoryPort.out-port.js';
import type { MergeEnqueueDecision } from '../../domain/merge-queue-operations.js';
import type { EnqueueMergePort } from '../ports/in/EnqueueMergePort.in-port.js';
import type { ForgeReadPort } from '../ports/out/ForgeReadPort.out-port.js';
import { parseBaseBranch } from '../../domain/base-branch.js';
import type { BaseBranchValue } from '../../domain/base-branch.js';

const REPOSITORY_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

/** Enqueue one pull request head; validates the request envelope before delegating. */
export class EnqueueMergeUseCase implements EnqueueMergePort {
  constructor(private readonly deps: { readonly queue: MergeQueueRepositoryPort; readonly forge: ForgeReadPort }) {}

  async enqueue(request: MergeQueueEnqueueCommand): Promise<MergeEnqueueDecision> {
    if (!this.isValidRequest(request)) {
      return { outcome: 'refused', reason: 'invalid-repository' };
    }
    if (Object.hasOwn(request, 'baseBranch')) {
      return this.deps.queue.enqueueMergeEntry(request);
    }
    const base = await this.readBaseFromForge(request);
    if (base === null) {
      return { outcome: 'refused', reason: 'base-unavailable' };
    }
    return this.deps.queue.enqueueMergeEntry({ ...request, baseBranch: base });
  }

  /** Reads the PR base from the forge; null for missing/unconfigured/unknown bases. */
  private async readBaseFromForge(request: MergeQueueEnqueueCommand): Promise<BaseBranchValue | null> {
    const forge = this.deps.forge;
    if (!forge.isConfigured()) {
      return null;
    }
    const result = await forge.readPullRequest({
      ref: { kind: 'number', number: request.pullRequest },
      repository: { owner: request.repository.owner, repo: request.repository.repo },
    });
    if (result.outcome !== 'found') {
      return null;
    }
    const parsed = parseBaseBranch(result.pullRequest.baseRef);
    return parsed === undefined ? null : parsed;
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
