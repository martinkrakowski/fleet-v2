// @generated inbound contract scaffold — refined for lane WB3a-3-2.
/**
 * ResolveOwnerItemPort: apply one typed resolution to an owner item and save
 * it at the revision read. The actor (the done/withdraw `by`) comes from the
 * composition root, never the body; a repeated resolution writes nothing.
 */

import type { OwnerItemRecord, OwnerItemDoneVia, OwnerItemWithdrawReason } from '../../../domain/owner-item-records.js';
import type { OwnerItemRefusalCode } from '../../../domain/entities/OwnerItem.js';

export type ResolveOwnerItemRequest =
  | { readonly action: 'observe-pr'; readonly projectId: string; readonly repository: string; readonly number: number;
      readonly state: 'merged' | 'closed' | 'open'; readonly source: 'merge-record' | 'forge-observation';
      readonly observedAtIso: string }
  | { readonly action: 'answer'; readonly questionId: string }
  | { readonly action: 'plan-decision'; readonly projectId: string; readonly planId: string; readonly decisionId: string;
      readonly outcome: 'decided' | 'removed'; readonly planRevision: number }
  | { readonly action: 'done'; readonly itemId: string; readonly via: OwnerItemDoneVia }
  | { readonly action: 'withdraw'; readonly itemId: string; readonly reason: OwnerItemWithdrawReason };

export type ResolveOwnerItemRefusalCode = 'request' | 'clock-read' | 'conflict' | OwnerItemRefusalCode;

export type ResolveOwnerItemResult =
  | { readonly outcome: 'resolved'; readonly item: OwnerItemRecord; readonly revision: number }
  | { readonly outcome: 'unchanged'; readonly item: OwnerItemRecord; readonly revision: number }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'refused'; readonly code: ResolveOwnerItemRefusalCode; readonly reason: string };

export interface ResolveOwnerItemPort {
  /** `request` is untrusted. `actor` (the done/withdraw `by`) comes from the composition root, never the body. */
  resolveOwnerItem(request: unknown, actor: string): Promise<ResolveOwnerItemResult>;
}
