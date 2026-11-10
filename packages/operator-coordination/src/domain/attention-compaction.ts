/**
 * U7a: the pure decision half of stale-attention cleaning. Given stored
 * attention items and the set of run refs whose run reached a terminal state,
 * names the items that should be cleared as stale. Pure domain code: no clock,
 * no filesystem, no I/O, no mutation of the input. It only decides; wiring it
 * into a use case and into the compaction path is a later unit.
 */
import type { AttentionItemRecord } from './attention-item-records.js';

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

export function planAttentionCompaction(input: AttentionCompactionInput): AttentionCompactionPlan {
  const terminalRunRefSet = new Set<string>(input.terminalRunRefs);
  const seenItemIds = new Set<string>();
  const staleItemIds: string[] = [];

  for (const item of input.items) {
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

  return Object.freeze({ staleItemIds: Object.freeze(staleItemIds) });
}
