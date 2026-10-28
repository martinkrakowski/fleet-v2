// @generated use-case scaffold — refined for lane AM3b-3.
/**
 * RecordAttentionItemUseCase implements RecordAttentionItemPort. It raises a
 * machine notice from a closed body with the injected clock and id source;
 * raisedBy is the caller's actor, never the body. It is find-or-create by the
 * (project, subject, kind) key: no holder → a new open item (`raised`), an
 * open holder → refreshed (`refreshed`), a cleared holder → reopened
 * (`reopened`). A repeat never creates a second item; a lost race is re-read
 * once, never piled up. A recorded attention item grants nothing.
 */

import { AttentionItem, attentionItemKey } from '../../domain/entities/AttentionItem.js';
import { readPlainObject } from '../../domain/record-input.js';
import {
  AttentionItemKeyConflictError,
  AttentionItemRevisionConflictError,
  type AttentionItemRepositoryPort,
  type StoredAttentionItem,
} from '../ports/out/AttentionItemRepositoryPort.out-port.js';
import type {
  AttentionClock,
  AttentionItemIdSource,
  RecordAttentionItemPort,
  RecordAttentionItemResult,
} from '../ports/in/RecordAttentionItemPort.in-port.js';

export interface RecordAttentionItemDependencies {
  readonly itemRepo: AttentionItemRepositoryPort;
  readonly clock: AttentionClock;
  readonly ids: AttentionItemIdSource;
}

const RECORD_BODY_KEYS: readonly string[] = ['projectId', 'kind', 'subject', 'workOrderId', 'summary'];

/** Fixed refusal message for any unreadable repository failure; never echoes the error or the input. */
const STORE_UNREADABLE_REASON = 'RecordAttentionItem the attention item store could not be read';

function isCanonicalIso(value: string): boolean {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return false;
  }
  return new Date(parsed).toISOString() === value;
}

export class RecordAttentionItemUseCase implements RecordAttentionItemPort {
  constructor(private readonly deps?: RecordAttentionItemDependencies) {}

  async recordAttentionItem(body: unknown, actor: string): Promise<RecordAttentionItemResult> {
    return this.execute(body, actor);
  }

  async execute(body: unknown, actor: unknown): Promise<RecordAttentionItemResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: RecordAttentionItemUseCase');
    }

    // 1. The body is a closed plain object with exactly the five record keys.
    let parsed: Record<string, unknown> | null;
    try {
      parsed = readPlainObject(body, RECORD_BODY_KEYS);
    } catch {
      parsed = null;
    }
    if (parsed === null) {
      return {
        outcome: 'refused',
        code: 'request',
        reason: 'RecordAttentionItem requires exactly projectId, kind, subject, workOrderId and summary',
      };
    }

    // 2. The actor is who raises it; the domain validates raisedBy further.
    if (typeof actor !== 'string') {
      return {
        outcome: 'refused',
        code: 'request',
        reason: 'RecordAttentionItem the actor could not be identified',
      };
    }

    // 3. The clock alone supplies the moment, in canonical form.
    const nowIso = this.deps.clock.nowIso();
    if (!isCanonicalIso(nowIso)) {
      return {
        outcome: 'refused',
        code: 'clock',
        reason: 'RecordAttentionItem the clock could not be read',
      };
    }

    // 4. The domain builds the candidate open item at the minted id.
    const raised = AttentionItem.raise(
      {
        itemId: this.deps.ids.newItemId(),
        projectId: parsed.projectId,
        kind: parsed.kind,
        subject: parsed.subject,
        workOrderId: parsed.workOrderId,
        summary: parsed.summary,
        raisedBy: actor,
      },
      nowIso,
    );
    if (!raised.success) {
      return { outcome: 'refused', code: raised.code, reason: raised.error.message };
    }
    const candidate = raised.value;

    // 5. Find-or-create by key: a holder is refreshed or reopened instead.
    const existing = await this.raiseOnHolder(candidate, nowIso);
    if (existing !== null) {
      return existing;
    }

    // 6. Save at revision 0. A held key means another writer took it between
    //    steps 5 and 6, so the holder is re-read once, never piled up. A
    //    revision conflict means the minted item id is already taken.
    try {
      const stored = await this.deps.itemRepo.save(candidate.toRecord(), 0);
      return { outcome: 'raised', item: stored.item, revision: stored.revision };
    } catch (error) {
      if (error instanceof AttentionItemKeyConflictError) {
        const holder = await this.raiseOnHolder(candidate, nowIso);
        if (holder !== null) {
          return holder;
        }
        return {
          outcome: 'refused',
          code: 'conflict',
          reason: 'RecordAttentionItem another writer raised this key first',
        };
      }
      if (error instanceof AttentionItemRevisionConflictError) {
        return {
          outcome: 'refused',
          code: 'id-taken',
          reason: 'RecordAttentionItem the minted item id is already taken',
        };
      }
      return {
        outcome: 'refused',
        code: 'store-unreadable',
        reason: STORE_UNREADABLE_REASON,
      };
    }
  }

  /**
   * The outcome for an item already holding `candidate`'s key, or null when
   * none does: an open holder is refreshed, a cleared one is reopened. A
   * revision conflict while saving is refused rather than retried.
   */
  private async raiseOnHolder(candidate: AttentionItem, nowIso: string): Promise<RecordAttentionItemResult | null> {
    const record = candidate.toRecord();
    const key = attentionItemKey(record.projectId, record.subject, record.kind);
    let holder: StoredAttentionItem | null = null;
    try {
      holder = await this.deps!.itemRepo.findByKey(key);
    } catch {
      return {
        outcome: 'refused',
        code: 'store-unreadable',
        reason: STORE_UNREADABLE_REASON,
      };
    }
    if (holder === null) {
      return null;
    }
    const reopened = holder.item.state === 'cleared';
    const loaded = AttentionItem.create(holder.item);
    if (!loaded.success) {
      return {
        outcome: 'refused',
        code: 'conflict',
        reason: 'RecordAttentionItem the stored item could not be read',
      };
    }
    const again = loaded.value.raiseAgain(
      {
        kind: record.kind,
        subject: record.subject,
        workOrderId: record.workOrderId,
        summary: record.summary,
        raisedBy: record.raisedBy,
      },
      nowIso,
    );
    if (!again.success) {
      return { outcome: 'refused', code: again.code, reason: again.error.message };
    }
    try {
      const stored = await this.deps!.itemRepo.save(again.value.toRecord(), holder.revision);
      return { outcome: reopened ? 'reopened' : 'refreshed', item: stored.item, revision: stored.revision };
    } catch (error) {
      if (error instanceof AttentionItemRevisionConflictError) {
        return {
          outcome: 'refused',
          code: 'conflict',
          reason: 'RecordAttentionItem another writer moved this item first',
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
