// @generated inbound contract scaffold — refined for lane AM3b-3.
/**
 * ClearAttentionItemPort: clear attention items by one typed action: the
 * owner dismisses one item at the revision read, the raiser resolves one by
 * key as resolved or stale, or every open item of a merged work order is
 * cleared; a cleared item is left unchanged. Nothing is ever deleted.
 */

import type { AttentionItemClearVia } from '../../../domain/attention-item-records.js';
import type { AttentionItemRefusalCode } from '../../../domain/entities/AttentionItem.js';
import type { StoredAttentionItem } from '../out/AttentionItemRepositoryPort.out-port.js';

export type { AttentionItemClearVia };

export type ClearAttentionItemRequest =
  | { readonly action: 'dismiss'; readonly itemId: string; readonly expectedRevision: number }
  | { readonly action: 'resolve'; readonly projectId: string; readonly kind: string;
      readonly subject: { readonly kind: string; readonly ref: string }; readonly reason: 'resolved' | 'stale' }
  | { readonly action: 'work-order-merged'; readonly projectId: string; readonly workOrderId: string };

export type ClearAttentionItemResult =
  | { readonly outcome: 'cleared'; readonly items: readonly StoredAttentionItem[] }
  | { readonly outcome: 'unchanged'; readonly items: readonly StoredAttentionItem[] }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'refused'; readonly code: 'request' | 'clock' | 'stale-revision' | 'conflict' | 'store-unreadable' | AttentionItemRefusalCode; readonly reason: string };

export interface ClearAttentionItemPort {
  /** `request` is untrusted. `via` and `actor` come from the composition root (CLI: 'cli'; web: 'web'; a machine caller: 'machine'). */
  clearAttentionItem(request: unknown, via: AttentionItemClearVia, actor: string): Promise<ClearAttentionItemResult>;
}
