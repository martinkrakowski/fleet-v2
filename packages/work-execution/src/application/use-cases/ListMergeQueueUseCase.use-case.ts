// @generated use-case scaffold — refined for lane DT4.
import type { MergeQueueRepositoryPort, MergeQueueListQuery } from '../ports/out/MergeQueueRepositoryPort.out-port.js';
import type { MergeQueueView, ListMergeQueuePort } from '../ports/in/ListMergeQueuePort.in-port.js';
import {
  findMergeQueueHead,
  orderMergeQueue,
} from '../../domain/merge-queue-records.js';
import type { MergeQueueRepositoryRef } from '../../domain/merge-queue-records.js';

/** List merge-queue entries live-first in queue order with a head per repository. */
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
    const ordered = orderMergeQueue(filtered);
    const heads: { readonly repository: MergeQueueRepositoryRef; readonly headEntryId: string | null }[] = [];
    const seen = new Set<string>();
    for (const entry of ordered) {
      const key = `${entry.repository.owner}\u0000${entry.repository.repo}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const group = ordered.filter(
        (candidate) =>
          candidate.repository.owner === entry.repository.owner &&
          candidate.repository.repo === entry.repository.repo,
      );
      const head = findMergeQueueHead(group);
      heads.push({
        repository: { owner: entry.repository.owner, repo: entry.repository.repo },
        headEntryId: head === null ? null : head.entryId,
      });
    }
    return { entries: ordered, heads };
  }
}
