// @generated use-case scaffold — refined for lane AM3b-3.
/**
 * ClearAttentionItemUseCase implements ClearAttentionItemPort. It applies one
 * typed clear: the owner dismisses one item by id at the revision read; the
 * raiser resolves one by key as resolved or stale; a merged work order clears
 * every open item whose workOrderId matches in the project. Clearing a
 * cleared item writes nothing (`unchanged`). Nothing is ever deleted.
 */

import { AttentionItem, attentionItemKey } from '../../domain/entities/AttentionItem.js';
import { readPlainObject } from '../../domain/record-input.js';
import {
  ATTENTION_ITEM_CLEAR_VIAS,
  type AttentionItemClearVia,
  type AttentionItemSubjectRecord,
} from '../../domain/attention-item-records.js';
import {
  AttentionItemRevisionConflictError,
  type AttentionItemRepositoryPort,
  type StoredAttentionItem,
} from '../ports/out/AttentionItemRepositoryPort.out-port.js';
import type {
  ClearAttentionItemPort,
  ClearAttentionItemResult,
} from '../ports/in/ClearAttentionItemPort.in-port.js';
import type { AttentionClock } from '../ports/in/RecordAttentionItemPort.in-port.js';

export interface ClearAttentionItemDependencies {
  readonly itemRepo: AttentionItemRepositoryPort;
  readonly clock: AttentionClock;
}

function isCanonicalIso(value: string): boolean {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return false;
  }
  return new Date(parsed).toISOString() === value;
}

/** A plain `{kind, ref}` object with string values; anything else is null. */
function readSubjectInput(value: unknown): { readonly kind: string; readonly ref: string } | null {
  const parsed = (() => {
    try {
      return readPlainObject(value, ['kind', 'ref']);
    } catch {
      return null;
    }
  })();
  if (parsed === null || typeof parsed.kind !== 'string' || typeof parsed.ref !== 'string') {
    return null;
  }
  return { kind: parsed.kind, ref: parsed.ref };
}

/** resolve accepts exactly these two clearance reasons; anything else is refused. */
const RESOLVE_REASONS: readonly string[] = ['resolved', 'stale'];

/** Fixed refusal message for any unreadable repository failure; never echoes the error or the input. */
const STORE_UNREADABLE_REASON = 'ClearAttentionItem the attention item store could not be read';

/** One item's clear-then-save; `unchanged` cannot happen for a state-open item. */
type ClearOutcome =
  | { readonly outcome: 'cleared'; readonly items: readonly StoredAttentionItem[] }
  | { readonly outcome: 'unchanged'; readonly items: readonly StoredAttentionItem[] }
  | { readonly outcome: 'refused'; readonly code: 'request' | 'clock' | 'stale-revision' | 'conflict' | 'store-unreadable' | 'invalid' | 'state' | 'key'; readonly reason: string };

export class ClearAttentionItemUseCase implements ClearAttentionItemPort {
  constructor(private readonly deps?: ClearAttentionItemDependencies) {}

  async clearAttentionItem(request: unknown, via: AttentionItemClearVia, actor: string): Promise<ClearAttentionItemResult> {
    return this.execute(request, via, actor);
  }

  async execute(request: unknown, via: unknown, actor: unknown): Promise<ClearAttentionItemResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: ClearAttentionItemUseCase');
    }

    // 1. The request is a closed plain object with exactly the action's keys.
    const parsed = this.readRequest(request);
    if (parsed === null) {
      return {
        outcome: 'refused',
        code: 'request',
        reason: 'ClearAttentionItem requires a known action with exactly its fields',
      };
    }

    // 2. The via and actor are who cleared it; the composition root supplies them.
    if (typeof via !== 'string' || !(ATTENTION_ITEM_CLEAR_VIAS as readonly string[]).includes(via)) {
      return {
        outcome: 'refused',
        code: 'request',
        reason: 'ClearAttentionItem the via could not be identified',
      };
    }
    if (typeof actor !== 'string') {
      return {
        outcome: 'refused',
        code: 'request',
        reason: 'ClearAttentionItem the actor could not be identified',
      };
    }

    // 3. The clock alone supplies the moment, in canonical form.
    const nowIso = this.deps.clock.nowIso();
    if (!isCanonicalIso(nowIso)) {
      return {
        outcome: 'refused',
        code: 'clock',
        reason: 'ClearAttentionItem the clock could not be read',
      };
    }

    const clearVia = via as AttentionItemClearVia;
    if (parsed.action === 'dismiss') {
      return this.dismiss(parsed, clearVia, actor, nowIso);
    }
    if (parsed.action === 'resolve') {
      return this.resolve(parsed, clearVia, actor, nowIso);
    }
    return this.clearWorkOrder(parsed, clearVia, actor, nowIso);
  }

  /** Read the request against each action's exact key set; unknown action or extra keys → null. */
  private readRequest(request: unknown): { readonly action: 'dismiss'; readonly itemId: unknown; readonly expectedRevision: unknown } | { readonly action: 'resolve'; readonly projectId: unknown; readonly kind: unknown; readonly subject: unknown; readonly reason: unknown } | { readonly action: 'work-order-merged'; readonly projectId: unknown; readonly workOrderId: unknown } | null {
    const dismiss: Record<string, unknown> | null = (() => {
      try {
        return readPlainObject(request, ['action', 'itemId', 'expectedRevision']);
      } catch {
        return null;
      }
    })();
    if (dismiss !== null && dismiss.action === 'dismiss') {
      return { action: 'dismiss', itemId: dismiss.itemId, expectedRevision: dismiss.expectedRevision };
    }
    const resolve: Record<string, unknown> | null = (() => {
      try {
        return readPlainObject(request, ['action', 'projectId', 'kind', 'subject', 'reason']);
      } catch {
        return null;
      }
    })();
    if (resolve !== null && resolve.action === 'resolve') {
      return { action: 'resolve', projectId: resolve.projectId, kind: resolve.kind, subject: resolve.subject, reason: resolve.reason };
    }
    const workOrder: Record<string, unknown> | null = (() => {
      try {
        return readPlainObject(request, ['action', 'projectId', 'workOrderId']);
      } catch {
        return null;
      }
    })();
    if (workOrder !== null && workOrder.action === 'work-order-merged') {
      return { action: 'work-order-merged', projectId: workOrder.projectId, workOrderId: workOrder.workOrderId };
    }
    return null;
  }

  /** dismiss: the owner clears one item by id at the revision read. */
  private async dismiss(
    parsed: { readonly action: 'dismiss'; readonly itemId: unknown; readonly expectedRevision: unknown },
    via: AttentionItemClearVia,
    actor: string,
    nowIso: string,
  ): Promise<ClearAttentionItemResult> {
    if (typeof parsed.itemId !== 'string' || typeof parsed.expectedRevision !== 'number' || !Number.isSafeInteger(parsed.expectedRevision)) {
      return {
        outcome: 'refused',
        code: 'request',
        reason: 'ClearAttentionItem dismiss requires a string itemId and an integer expectedRevision',
      };
    }
    let stored: StoredAttentionItem | null = null;
    try {
      stored = await this.deps!.itemRepo.get(parsed.itemId);
    } catch {
      return {
        outcome: 'refused',
        code: 'store-unreadable',
        reason: STORE_UNREADABLE_REASON,
      };
    }
    if (stored === null) {
      return { outcome: 'not-found' };
    }
    if (stored.revision !== parsed.expectedRevision) {
      return {
        outcome: 'refused',
        code: 'stale-revision',
        reason: 'ClearAttentionItem the item moved since the revision read',
      };
    }
    return this.clearAndSave(stored, { reason: 'dismissed', via, by: actor }, nowIso);
  }

  /** resolve: the raiser clears one item by key as resolved or stale. */
  private async resolve(
    parsed: { readonly action: 'resolve'; readonly projectId: unknown; readonly kind: unknown; readonly subject: unknown; readonly reason: unknown },
    via: AttentionItemClearVia,
    actor: string,
    nowIso: string,
  ): Promise<ClearAttentionItemResult> {
    const subject = readSubjectInput(parsed.subject);
    if (
      typeof parsed.projectId !== 'string' ||
      typeof parsed.kind !== 'string' ||
      subject === null ||
      typeof parsed.reason !== 'string' ||
      !RESOLVE_REASONS.includes(parsed.reason)
    ) {
      return {
        outcome: 'refused',
        code: 'request',
        reason: 'ClearAttentionItem resolve requires a string projectId, kind, {kind, ref} subject and reason resolved or stale',
      };
    }
    let stored: StoredAttentionItem | null = null;
    try {
      stored = await this.deps!.itemRepo.findByKey(attentionItemKey(parsed.projectId, subject as AttentionItemSubjectRecord, parsed.kind));
    } catch {
      return {
        outcome: 'refused',
        code: 'store-unreadable',
        reason: STORE_UNREADABLE_REASON,
      };
    }
    if (stored === null) {
      return { outcome: 'not-found' };
    }
    return this.clearAndSave(stored, { reason: parsed.reason, via, by: actor }, nowIso);
  }

  /** work-order-merged: every open item whose workOrderId matches in the project. */
  private async clearWorkOrder(
    parsed: { readonly action: 'work-order-merged'; readonly projectId: unknown; readonly workOrderId: unknown },
    via: AttentionItemClearVia,
    actor: string,
    nowIso: string,
  ): Promise<ClearAttentionItemResult> {
    if (typeof parsed.projectId !== 'string' || typeof parsed.workOrderId !== 'string') {
      return {
        outcome: 'refused',
        code: 'request',
        reason: 'ClearAttentionItem work-order-merged requires a string projectId and workOrderId',
      };
    }
    let open: readonly StoredAttentionItem[] = [];
    try {
      open = await this.deps!.itemRepo.list({ projectId: parsed.projectId, workOrderId: parsed.workOrderId, state: 'open' });
    } catch {
      return {
        outcome: 'refused',
        code: 'store-unreadable',
        reason: STORE_UNREADABLE_REASON,
      };
    }
    if (open.length === 0) {
      return { outcome: 'unchanged', items: [] };
    }
    const settled = await Promise.allSettled(open.map((stored) => this.clearAndSave(stored, { reason: 'merged', via, by: actor }, nowIso)));
    const cleared: StoredAttentionItem[] = [];
    let refusal: ClearAttentionItemResult | null = null;
    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value.outcome === 'cleared') {
        cleared.push(result.value.items[0]);
        continue;
      }
      if (refusal === null) {
        refusal = result.status === 'rejected'
          ? { outcome: 'refused', code: 'conflict', reason: 'ClearAttentionItem another writer moved this item first' }
          : result.value;
      }
    }
    if (refusal !== null) {
      return refusal;
    }
    return { outcome: 'cleared', items: cleared };
  }

  /** Clear one stored item unless it is already cleared, then save at the revision read. */
  private async clearAndSave(
    stored: StoredAttentionItem,
    clearance: { readonly reason: string; readonly via: AttentionItemClearVia; readonly by: string },
    nowIso: string,
  ): Promise<ClearOutcome> {
    if (stored.item.state === 'cleared') {
      return { outcome: 'unchanged', items: [stored] };
    }
    const loaded = AttentionItem.create(stored.item);
    if (!loaded.success) {
      return {
        outcome: 'refused',
        code: 'conflict',
        reason: 'ClearAttentionItem the stored item could not be read',
      };
    }
    const cleared = loaded.value.clear(clearance, nowIso);
    if (!cleared.success) {
      return { outcome: 'refused', code: cleared.code, reason: cleared.error.message };
    }
    try {
      const saved = await this.deps!.itemRepo.save(cleared.value.toRecord(), stored.revision);
      return { outcome: 'cleared', items: [saved] };
    } catch (error) {
      if (error instanceof AttentionItemRevisionConflictError) {
        return {
          outcome: 'refused',
          code: 'conflict',
          reason: 'ClearAttentionItem another writer moved this item first',
        };
      }
      return {
        outcome: 'refused',
        code: 'store-unreadable',
        reason: STORE_UNREADABLE_REASON,
      };
    }
  }
}
