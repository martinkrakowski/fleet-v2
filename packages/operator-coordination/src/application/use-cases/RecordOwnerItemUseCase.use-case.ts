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
        reason: 'RecordOwnerItem requires exactly projectId, kind, subject, refs and blocks',
      };
    }

    // 2. The actor is who records it; the domain validates createdBy further.
    if (typeof actor !== 'string') {
      return {
        outcome: 'refused',
        code: 'request',
        reason: 'RecordOwnerItem the actor could not be identified',
      };
    }

    // 3. The clock alone supplies the moment.
    let nowIso: string;
    try {
      nowIso = this.deps.clock.nowIso();
    } catch {
      return {
        outcome: 'refused',
        code: 'clock',
        reason: 'RecordOwnerItem the clock could not be read',
      };
    }
    if (!Number.isFinite(Date.parse(nowIso))) {
      return {
        outcome: 'refused',
        code: 'clock',
        reason: 'RecordOwnerItem the clock could not be read',
      };
    }

    // 4. The aggregate validates the full open record. The id is minted
    //    before opening so an unreadable id source is a refusal, not a throw.
    let itemId: string;
    try {
      const minted = this.deps.ids.newItemId();
      if (typeof minted !== 'string') {
        return {
          outcome: 'refused',
          code: 'store',
          reason: 'RecordOwnerItem the id source could not be read',
        };
      }
      itemId = minted;
    } catch {
      return {
        outcome: 'refused',
        code: 'store',
        reason: 'RecordOwnerItem the id source could not be read',
      };
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
    let existing: RecordOwnerItemResult | null;
    try {
      existing = await this.holderOutcome(record);
    } catch {
      return {
        outcome: 'refused',
        code: 'store',
        reason: 'RecordOwnerItem the item store could not be read',
      };
    }
    if (existing !== null) {
      return existing;
    }

    // 6. Save at revision 0. A held key means another writer took it between
    //    steps 5 and 6, so the holder is re-read. A revision conflict means the
    //    minted item id is already taken.
    try {
      const stored = await this.deps.itemRepo.save(record, 0);
      return { outcome: 'recorded', item: stored.item, revision: stored.revision };
    } catch (error) {
      if (error instanceof OwnerItemKeyConflictError) {
        let holder: RecordOwnerItemResult | null;
        try {
          holder = await this.holderOutcome(record);
        } catch {
          return {
            outcome: 'refused',
            code: 'store',
            reason: 'RecordOwnerItem the item store could not be read',
          };
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
      if (error instanceof OwnerItemRevisionConflictError) {
        return {
          outcome: 'refused',
          code: 'id-taken',
          reason: 'RecordOwnerItem the minted item id is already taken',
        };
      }
      return {
        outcome: 'refused',
        code: 'store',
        reason: 'RecordOwnerItem the item store could not be written',
      };
    }
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
