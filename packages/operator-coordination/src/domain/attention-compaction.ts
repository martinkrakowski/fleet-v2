/**
 * U7a: the pure decision half of stale-attention cleaning. Given stored
 * attention items and the set of run refs whose run reached a terminal state,
 * names the items that should be cleared as stale. Pure domain code: no clock,
 * no filesystem, no I/O, no mutation of the input. It only decides; wiring it
 * into a use case and into the compaction path is a later unit.
 */
import { readPlainRecord, type PlainRecordSchema } from '@fleet/shared';
import type { AttentionItemRecord } from './attention-item-records.js';
import {
  ATTENTION_ITEM_ID_PATTERN,
  ATTENTION_ITEM_STATES,
  ATTENTION_ITEM_SUBJECT_KINDS,
} from './attention-item-records.js';
import type { AttentionItemState, AttentionItemSubjectKind } from './attention-item-records.js';

export interface AttentionCompactionInput {
  /** Stored attention items, in store order. */
  readonly items: readonly AttentionItemRecord[];
  /** The `run` subject refs whose run has reached a terminal state. */
  readonly terminalRunRefs: readonly string[];
}

export interface AttentionCompactionPlan {
  /** Item ids to clear as stale, in the order the items appeared in `items`. */
  readonly staleItemIds: readonly string[];
}

export const ATTENTION_COMPACTION_MAX_ITEMS = 1024;
export const ATTENTION_COMPACTION_MAX_REFS = 1024;
export const ATTENTION_COMPACTION_MAX_STRING = 256;

export type AttentionCompactionRefusalCode = 'invalid';

export type AttentionCompactionResult =
  | { readonly success: true; readonly value: AttentionCompactionPlan }
  | { readonly success: false; readonly error: Error; readonly code: AttentionCompactionRefusalCode };

interface AttentionCompactionSnapshot {
  items: ReadonlyArray<{
    itemId: string;
    state: AttentionItemState;
    subject: { readonly kind: AttentionItemSubjectKind; readonly ref: string };
  }>;
  terminalRunRefs: readonly string[];
}

const ATTENTION_COMPACTION_SCHEMA = {
  items: {
    kind: 'array' as const,
    maxLength: ATTENTION_COMPACTION_MAX_ITEMS,
    items: {
      kind: 'record' as const,
      schema: {
        itemId: { kind: 'string' as const, maxLength: ATTENTION_COMPACTION_MAX_STRING },
        state: { kind: 'literal' as const, values: ATTENTION_ITEM_STATES },
        subject: {
          kind: 'record' as const,
          schema: {
            kind: { kind: 'literal' as const, values: ATTENTION_ITEM_SUBJECT_KINDS },
            ref: { kind: 'string' as const, maxLength: ATTENTION_COMPACTION_MAX_STRING },
          },
        },
      },
    },
  },
  terminalRunRefs: {
    kind: 'array' as const,
    maxLength: ATTENTION_COMPACTION_MAX_REFS,
    items: { kind: 'string' as const, maxLength: ATTENTION_COMPACTION_MAX_STRING },
  },
} satisfies PlainRecordSchema;

function refusal(): AttentionCompactionResult {
  return { success: false, error: new Error('AttentionCompaction input could not be read'), code: 'invalid' };
}

export function planAttentionCompaction(input: unknown): AttentionCompactionResult {
  try {
    const read = readPlainRecord(input, ATTENTION_COMPACTION_SCHEMA);
    if (!read.ok) {
      return refusal();
    }
    const snapshot = read.value as unknown as AttentionCompactionSnapshot;

    for (const item of snapshot.items) {
      if (!ATTENTION_ITEM_ID_PATTERN.test(item.itemId)) {
        return refusal();
      }
    }

    const terminalRunRefSet = new Set<string>(snapshot.terminalRunRefs);
    const seenItemIds = new Set<string>();
    const staleItemIds: string[] = [];

    for (const item of snapshot.items) {
      // Rule 2: a cleared item is never stale.
      if (item.state !== 'open') {
        continue;
      }
      // Rule 3: only `run` subjects are comparable; other kinds are never stale,
      // even when their ref string happens to equal a terminal run ref.
      if (item.subject.kind !== 'run') {
        continue;
      }
      // Rule 1 & 4: ref comparison is exact string equality against terminal run refs.
      if (!terminalRunRefSet.has(item.subject.ref)) {
        continue;
      }
      // Rule 5: each id appears at most once, preserving the order of `items`.
      if (seenItemIds.has(item.itemId)) {
        continue;
      }
      seenItemIds.add(item.itemId);
      staleItemIds.push(item.itemId);
    }

    return { success: true, value: Object.freeze({ staleItemIds: Object.freeze(staleItemIds) }) };
  } catch {
    return refusal();
  }
}
