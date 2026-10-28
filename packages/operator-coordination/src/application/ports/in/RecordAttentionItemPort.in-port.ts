// @generated inbound contract scaffold — refined for lane AM3b-3.
/**
 * RecordAttentionItemPort: raise a machine attention notice from a closed
 * body with the injected clock and id source; the raiser is the caller's
 * actor, never the body. One item per project, subject and kind: a repeat
 * refreshes the open item or reopens a cleared one, so notices replace rather
 * than pile up. An attention item grants and blocks nothing.
 */

import type { AttentionItemRecord } from '../../../domain/attention-item-records.js';
import type { AttentionItemRefusalCode } from '../../../domain/entities/AttentionItem.js';

/** The only source of "now" for the attention-item use cases; injected, never from a request. */
export interface AttentionClock { readonly nowIso: () => string; }

/** Mints new attention item ids; injected by the composition root. */
export interface AttentionItemIdSource { readonly newItemId: () => string; }

/** Exactly these keys; never an id, a time, an actor or a state. */
export interface RecordAttentionItemBody {
  readonly projectId: string;
  readonly kind: string;
  readonly subject: { readonly kind: string; readonly ref: string };
  readonly workOrderId: string | null;
  readonly summary: string;
}

export type RecordAttentionItemRefusalCode = 'request' | 'clock' | 'id-taken' | 'conflict' | AttentionItemRefusalCode;

export type RecordAttentionItemResult =
  | { readonly outcome: 'raised' | 'refreshed' | 'reopened'; readonly item: AttentionItemRecord; readonly revision: number }
  | { readonly outcome: 'refused'; readonly code: RecordAttentionItemRefusalCode; readonly reason: string };

export interface RecordAttentionItemPort {
  /** `body` is untrusted. `actor` is who raises it, supplied by the composition root, never the body. */
  recordAttentionItem(body: unknown, actor: string): Promise<RecordAttentionItemResult>;
}
