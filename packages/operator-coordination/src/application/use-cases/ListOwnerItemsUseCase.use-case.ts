/**
 * ListOwnerItemsUseCase implements ListOwnerItemsPort. It is a thin read over
 * the owner item repository, optionally narrowed by project, state and kind,
 * one entry per item id. Gating and gated blocks are derived from the record,
 * never stored. An invalid filter returns an empty list. Reading writes
 * nothing.
 */

import { isOwnerItemGating, ownerItemGatedBlocks } from '../../domain/entities/OwnerItem.js';
import { OWNER_ITEM_KINDS } from '../../domain/value-objects/OwnerItemKind.vo.js';
import { OWNER_ITEM_STATES } from '../../domain/owner-item-records.js';
import type { OwnerItemRepositoryPort } from '../ports/out/OwnerItemRepositoryPort.out-port.js';
import type {
  ListOwnerItemsEntry,
  ListOwnerItemsPort,
  ListOwnerItemsRequest,
  ListOwnerItemsResult,
} from '../ports/in/ListOwnerItemsPort.in-port.js';

export interface ListOwnerItemsDependencies {
  readonly itemRepo: OwnerItemRepositoryPort;
}

export class ListOwnerItemsUseCase implements ListOwnerItemsPort {
  constructor(private readonly deps?: ListOwnerItemsDependencies) {}

  async listOwnerItems(request?: ListOwnerItemsRequest): Promise<ListOwnerItemsResult> {
    return this.execute(request);
  }

  async execute(input?: unknown): Promise<ListOwnerItemsResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: ListOwnerItemsUseCase');
    }
    const request = typeof input === 'object' && input !== null ? (input as ListOwnerItemsRequest) : {};
    const projectId = request.projectId;
    const state = request.state;
    const kind = request.kind;
    if (
      (projectId !== undefined && (typeof projectId !== 'string' || projectId.length === 0)) ||
      (state !== undefined && !OWNER_ITEM_STATES.includes(state)) ||
      (kind !== undefined && !OWNER_ITEM_KINDS.includes(kind))
    ) {
      return { items: [] };
    }
    const stored = await this.deps.itemRepo.list({ projectId, state, kind });
    const seen = new Set<string>();
    const items: ListOwnerItemsEntry[] = [];
    for (const { item, revision } of stored) {
      if (seen.has(item.itemId)) {
        continue;
      }
      seen.add(item.itemId);
      items.push({
        item,
        revision,
        gating: isOwnerItemGating(item),
        gatedBlocks: ownerItemGatedBlocks(item),
      });
    }
    return { items };
  }
}
