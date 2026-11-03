// @generated use-case scaffold — refined for lane DT4.
import type { MergeQueueRepositoryPort, MergeQueueListQuery } from '../ports/out/MergeQueueRepositoryPort.out-port.js';
import type { MergeQueueView, ListMergeQueuePort } from '../ports/in/ListMergeQueuePort.in-port.js';
import {
  findMergeQueueHead,
  isMergeQueueEntryLive,
  orderMergeQueue,
  resolveMergeQueueEntryBase,
} from '../../domain/merge-queue-records.js';
import type { MergeQueueRepositoryRef } from '../../domain/merge-queue-records.js';
import type { BaseBranchValue } from '../../domain/base-branch.js';

/** List merge-queue entries live-first in queue order with a head per (repository, base). */
export class ListMergeQueueUseCase implements ListMergeQueuePort {
  constructor(private readonly deps: { readonly queue: MergeQueueRepositoryPort }) {}

  async list(query: MergeQueueListQuery): Promise<MergeQueueView> {
    const all = await this.deps.queue.listMergeEntries(query);
    const filtered =
      query.repository === undefined
        ? [...all]
        : all.filter(
            (entry) =>
              entry.repository.owner === query.repository!.owner &&
              entry.repository.repo === query.repository!.repo,
          );
    const live = filtered.filter(isMergeQueueEntryLive);
    const ordered = orderMergeQueue(live);
    const heads: {
      readonly repository: MergeQueueRepositoryRef;
      readonly baseBranch: BaseBranchValue;
      readonly headEntryId: string | null;
    }[] = [];
    const seen = new Set<string>();
    for (const entry of ordered) {
      const base = resolveMergeQueueEntryBase(entry);
      const key = `${entry.repository.owner}\u0000${entry.repository.repo}\u0000${base}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const group = ordered.filter(
        (candidate) =>
          candidate.repository.owner === entry.repository.owner &&
          candidate.repository.repo === entry.repository.repo &&
          resolveMergeQueueEntryBase(candidate) === base,
      );
      const head = findMergeQueueHead(group, undefined, base);
      heads.push({
        repository: { owner: entry.repository.owner, repo: entry.repository.repo },
        baseBranch: base,
        headEntryId: head === null ? null : head.entryId,
      });
    }
    if (query.repository !== undefined) {
      const repoKey = `${query.repository.owner}\u0000${query.repository.repo}`;
      const matched = [...seen].some((key) => key.startsWith(`${repoKey}\u0000`));
      if (!matched) {
        heads.push({
          repository: { owner: query.repository.owner, repo: query.repository.repo },
          baseBranch: 'main',
          headEntryId: null,
        });
      }
    }
    return { entries: ordered, heads };
  }
}
