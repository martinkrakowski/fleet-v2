/**
 * ListAttentionItemsUseCase implements ListAttentionItemsPort. It is a thin
 * read over the attention item repository, optionally narrowed by project,
 * state, kind and work order, one entry per item id. An invalid filter
 * returns an empty list. Reading writes nothing.
 */

import { ATTENTION_ITEM_KIND_PATTERN, ATTENTION_ITEM_STATES } from '../../domain/attention-item-records.js';
import type { AttentionItemRepositoryPort } from '../ports/out/AttentionItemRepositoryPort.out-port.js';
import type {
  ListAttentionItemsEntry,
  ListAttentionItemsPort,
  ListAttentionItemsRequest,
  ListAttentionItemsResult,
} from '../ports/in/ListAttentionItemsPort.in-port.js';

export interface ListAttentionItemsDependencies {
  readonly itemRepo: AttentionItemRepositoryPort;
}

export class ListAttentionItemsUseCase implements ListAttentionItemsPort {
  constructor(private readonly deps?: ListAttentionItemsDependencies) {}

  async listAttentionItems(request?: ListAttentionItemsRequest): Promise<ListAttentionItemsResult> {
    return this.execute(request);
  }

  async execute(input?: unknown): Promise<ListAttentionItemsResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: ListAttentionItemsUseCase');
    }
    const request = typeof input === 'object' && input !== null ? (input as ListAttentionItemsRequest) : {};
    const projectId = request.projectId;
    const state = request.state;
    const kind = request.kind;
    const workOrderId = request.workOrderId;
    if (
      (projectId !== undefined && (typeof projectId !== 'string' || projectId.length === 0)) ||
      (state !== undefined && !ATTENTION_ITEM_STATES.includes(state)) ||
      (kind !== undefined && (typeof kind !== 'string' || !ATTENTION_ITEM_KIND_PATTERN.test(kind))) ||
      (workOrderId !== undefined && (typeof workOrderId !== 'string' || workOrderId.length === 0))
    ) {
      return { items: [] };
    }
    const stored = await this.deps.itemRepo.list({ projectId, state, kind, workOrderId });
    const seen = new Set<string>();
    const items: ListAttentionItemsEntry[] = [];
    for (const entry of stored) {
      if (seen.has(entry.item.itemId)) {
        continue;
      }
      seen.add(entry.item.itemId);
      items.push({ item: entry.item, revision: entry.revision });
    }
    return { items };
  }
}
