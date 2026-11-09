/**
 * RecordOwnerItemUseCase implements RecordOwnerItemPort. It records a new open
 * owner item from a closed body, using the injected clock for the moment and
 * the injected id source for the item id; createdBy is the caller's actor,
 * never the body. It is find-or-create by natural key: an item already holding
 * one of the keys with the same project and kind is returned unchanged, and a
 * key held by another kind or project is refused with the holder's id. A
 * recorded item grants nothing.
 */

import { OwnerItem, ownerItemKeys } from '../../domain/entities/OwnerItem.js';
import { readPlainObject } from '../../domain/record-input.js';
import type { OwnerItemRecord } from '../../domain/owner-item-records.js';
import {
  OwnerItemKeyConflictError,
  OwnerItemRevisionConflictError,
  type OwnerItemRepositoryPort,
} from '../ports/out/OwnerItemRepositoryPort.out-port.js';
import type {
  OwnerItemClock,
  OwnerItemIdSource,
  RecordOwnerItemPort,
  RecordOwnerItemRefusalCode,
  RecordOwnerItemResult,
} from '../ports/in/RecordOwnerItemPort.in-port.js';

export interface RecordOwnerItemDependencies {
  readonly itemRepo: OwnerItemRepositoryPort;
  readonly clock: OwnerItemClock;
  readonly ids: OwnerItemIdSource;
}

const RECORD_BODY_KEYS: readonly string[] = ['projectId', 'kind', 'subject', 'refs', 'blocks'];

export class RecordOwnerItemUseCase implements RecordOwnerItemPort {
  constructor(private readonly deps?: RecordOwnerItemDependencies) {}

  async recordOwnerItem(body: unknown, actor: string): Promise<RecordOwnerItemResult> {
    return this.execute(body, actor);
  }

  async execute(body: unknown, actor: unknown): Promise<RecordOwnerItemResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: RecordOwnerItemUseCase');
    }

    // 1. The body is a closed plain object with exactly the five record keys.
    const parsed = this.readBody(body);
    if (parsed === null) {
      return this.refuse('request', 'RecordOwnerItem requires exactly projectId, kind, subject, refs and blocks');
    }

    // 2. The actor is who records it; the domain validates createdBy further.
    if (typeof actor !== 'string') {
      return this.refuse('request', 'RecordOwnerItem the actor could not be identified');
    }

    // 3. The clock alone supplies the moment.
    const nowIso = this.readClock();
    if (nowIso === null) {
      return this.refuse('clock', 'RecordOwnerItem the clock could not be read');
    }

    // 4. The aggregate validates the full open record. The id is minted
    //    before opening so an unreadable id source is a refusal, not a throw.
    const itemId = this.mintItemId();
    if (itemId === null) {
      return this.refuse('store', 'RecordOwnerItem the id source could not be read');
    }
    const opened = OwnerItem.open(
      {
        itemId,
        projectId: parsed.projectId,
        kind: parsed.kind,
        subject: parsed.subject,
        refs: parsed.refs,
        blocks: parsed.blocks,
        createdBy: actor,
      },
      nowIso,
    );
    if (!opened.success) {
      return { outcome: 'refused', code: opened.code, reason: opened.error.message };
    }
    const record = opened.value.toRecord();

    // 5. Find-or-create by natural key: the holder wins, whatever its state.
    const existing = await this.holderOrStoreError(record);
    if (existing !== null) {
      return existing;
    }

    // 6. Save at revision 0. A held key means another writer took it between
    //    steps 5 and 6, so the holder is re-read. A revision conflict means the
    //    minted item id is already taken.
    return this.saveRecord(record);
  }

  private refuse(code: RecordOwnerItemRefusalCode, reason: string): RecordOwnerItemResult {
    return { outcome: 'refused', code, reason };
  }

  /** The closed record shape, or null when it is not exactly one or is unreadable. */
  private readBody(body: unknown): Record<string, unknown> | null {
    try {
      return readPlainObject(body, RECORD_BODY_KEYS);
    } catch {
      return null;
    }
  }

  /** The injected clock's ISO instant, or null when it is unreadable or invalid. */
  private readClock(): string | null {
    try {
      const now = this.deps!.clock.nowIso();
      if (typeof now !== 'string' || !Number.isFinite(Date.parse(now))) {
        return null;
      }
      return now;
    } catch {
      return null;
    }
  }

  /** A freshly minted item id, or null when the source is unreadable or invalid. */
  private mintItemId(): string | null {
    try {
      const minted = this.deps!.ids.newItemId();
      if (typeof minted !== 'string') {
        return null;
      }
      return minted;
    } catch {
      return null;
    }
  }

  /** The holder outcome, or an unreadable-store refusal when the read fails. */
  private async holderOrStoreError(record: OwnerItemRecord): Promise<RecordOwnerItemResult | null> {
    try {
      return await this.holderOutcome(record);
    } catch {
      return this.refuse('store', 'RecordOwnerItem the item store could not be read');
    }
  }

  /** Save at revision 0; a key conflict re-reads the holder, a revision conflict is an id-taken refusal. */
  private async saveRecord(record: OwnerItemRecord): Promise<RecordOwnerItemResult> {
    try {
      const stored = await this.deps!.itemRepo.save(record, 0);
      return { outcome: 'recorded', item: stored.item, revision: stored.revision };
    } catch (error) {
      if (error instanceof OwnerItemKeyConflictError) {
        return this.keyConflictOutcome(record, error);
      }
      if (error instanceof OwnerItemRevisionConflictError) {
        return this.refuse('id-taken', 'RecordOwnerItem the minted item id is already taken');
      }
      return this.refuse('store', 'RecordOwnerItem the item store could not be written');
    }
  }

  /** Re-read the holder after a key conflict; a still-free key is reported as key-held. */
  private async keyConflictOutcome(record: OwnerItemRecord, error: OwnerItemKeyConflictError): Promise<RecordOwnerItemResult> {
    let holder: RecordOwnerItemResult | null;
    try {
      holder = await this.holderOutcome(record);
    } catch {
      return this.refuse('store', 'RecordOwnerItem the item store could not be read');
    }
    if (holder !== null) {
      return holder;
    }
    return {
      outcome: 'key-held',
      heldByItemId: error.heldByItemId,
      reason: 'RecordOwnerItem another owner item holds this natural key',
    };
  }

  /** The outcome for an item already holding one of `record`'s natural keys, or null when none does. */
  private async holderOutcome(record: OwnerItemRecord): Promise<RecordOwnerItemResult | null> {
    const keys = ownerItemKeys(record);
    if (keys.length === 0) {
      return null;
    }
    const holders = await Promise.all(keys.map((key) => this.deps!.itemRepo.findByKey(key)));
    const holder = holders.find((entry) => entry !== null) ?? null;
    if (holder === null) {
      return null;
    }
    if (holder.item.projectId === record.projectId && holder.item.kind === record.kind) {
      return { outcome: 'exists', item: holder.item, revision: holder.revision };
    }
    return {
      outcome: 'key-held',
      heldByItemId: holder.item.itemId,
      reason: 'RecordOwnerItem another owner item holds this natural key',
    };
  }
}
