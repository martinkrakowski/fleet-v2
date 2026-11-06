/**
 * ListOwnerItemsUseCase implements ListOwnerItemsPort. It is a thin read over
 * the owner item repository, optionally narrowed by project, state and kind,
 * one entry per item id. Gating and gated blocks are derived from the record,
 * never stored. An invalid filter, a non-object filter or an unreadable filter
 * is refused; an unreadable store is reported as unknown. Reading writes
 * nothing.
 */

import { isOwnerItemGating, ownerItemGatedBlocks } from '../../domain/entities/OwnerItem.js';
import { OWNER_ITEM_KINDS, type OwnerItemKindValue } from '../../domain/value-objects/OwnerItemKind.vo.js';
import { OWNER_ITEM_STATES, type OwnerItemState } from '../../domain/owner-item-records.js';
import type { OwnerItemRepositoryPort, StoredOwnerItem } from '../ports/out/OwnerItemRepositoryPort.out-port.js';
import { LIST_OWNER_ITEMS_LIMIT } from '../ports/in/ListOwnerItemsPort.in-port.js';
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
    let request: ListOwnerItemsRequest;
    try {
      if (input === undefined) {
        input = {};
      }
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return {
          outcome: 'refused',
          code: 'request',
          reason: 'ListOwnerItems requires a filter object or no argument',
        };
      }
      request = input as ListOwnerItemsRequest;
    } catch {
      // A revoked proxy throws even on the shape checks above.
      return {
        outcome: 'refused',
        code: 'request',
        reason: 'ListOwnerItems requires a filter object or no argument',
      };
    }
    let projectId: unknown;
    let state: unknown;
    let kind: unknown;
    try {
      projectId = request.projectId;
      state = request.state;
      kind = request.kind;
    } catch {
      return {
        outcome: 'refused',
        code: 'request',
        reason: 'ListOwnerItems the filter could not be read',
      };
    }
    if (
      (projectId !== undefined && (typeof projectId !== 'string' || projectId.length === 0)) ||
      (state !== undefined && !OWNER_ITEM_STATES.includes(state as never)) ||
      (kind !== undefined && !OWNER_ITEM_KINDS.includes(kind as never))
    ) {
      return {
        outcome: 'refused',
        code: 'request',
        reason: 'ListOwnerItems a filter field is invalid',
      };
    }
    let stored: readonly StoredOwnerItem[];
    try {
      stored = await this.deps.itemRepo.list({
        projectId: projectId as string | undefined,
        state: state as OwnerItemState | undefined,
        kind: kind as OwnerItemKindValue | undefined,
      });
    } catch {
      return { outcome: 'unknown', reason: 'ListOwnerItems the owner item store could not be read' };
    }
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
    return {
      outcome: 'listed',
      items: items.slice(0, LIST_OWNER_ITEMS_LIMIT),
      truncated: items.length > LIST_OWNER_ITEMS_LIMIT,
    };
  }
}
