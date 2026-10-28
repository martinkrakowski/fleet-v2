/**
 * Attention item records are the pure, serializable facts of the
 * `AttentionItem` aggregate (auto-merge plan A12, conductor plan §3.6 and
 * §3.9.2): machine notices keyed by project, typed subject and kind — a
 * repeat raise refreshes or reopens an item, nothing is deleted. They carry
 * no behaviour, are never a credential, an owner item or a coordination
 * kind, and an attention item grants nothing.
 */

import { OWNER_ITEM_PROJECT_ID_PATTERN } from './owner-item-records.js';

export const ATTENTION_ITEM_STATES = ['open', 'cleared'] as const;
export type AttentionItemState = (typeof ATTENTION_ITEM_STATES)[number];

export const ATTENTION_ITEM_SUBJECT_KINDS = ['work-order', 'run', 'attempt', 'reservation', 'worktree', 'pr', 'project'] as const;
export type AttentionItemSubjectKind = (typeof ATTENTION_ITEM_SUBJECT_KINDS)[number];

/** dismissed: the owner; merged: its work order merged; resolved: the raiser saw the condition end; stale: the reaper closed it for a merged or stopped run. */
export const ATTENTION_ITEM_CLEAR_REASONS = ['dismissed', 'merged', 'resolved', 'stale'] as const;
export type AttentionItemClearReason = (typeof ATTENTION_ITEM_CLEAR_REASONS)[number];

export const ATTENTION_ITEM_CLEAR_VIAS = ['cli', 'web', 'machine'] as const;
export type AttentionItemClearVia = (typeof ATTENTION_ITEM_CLEAR_VIAS)[number];

export const ATTENTION_ITEM_PROJECT_ID_PATTERN = OWNER_ITEM_PROJECT_ID_PATTERN;
export const ATTENTION_ITEM_KIND_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
/** Printable ASCII without space, 1–256 characters: item ids, actors, work-order ids, non-pr non-worktree subject refs. */
export const ATTENTION_ITEM_ID_PATTERN = /^[\x21-\x7e]{1,256}$/;
export const ATTENTION_ITEM_WORKTREE_REF_PATTERN = /^wt-[0-9a-f]{12}$/;
/** `<owner>/<repo>#<number>`. */
export const ATTENTION_ITEM_PR_REF_PATTERN = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}#[1-9][0-9]{0,9}$/;

export const ATTENTION_ITEM_LIMITS = Object.freeze({ summaryChars: 1024, recordJsonChars: 16384 });

export interface AttentionItemSubjectRecord {
  readonly kind: AttentionItemSubjectKind;
  readonly ref: string;
}

export interface AttentionItemClearanceRecord {
  readonly reason: AttentionItemClearReason;
  readonly via: AttentionItemClearVia;
  /** The clearing actor, supplied by the composition root, never a request body. */
  readonly by: string;
  readonly atIso: string;
}

export interface AttentionItemRecord {
  readonly itemId: string;
  readonly projectId: string;
  readonly kind: string;
  readonly subject: AttentionItemSubjectRecord;
  /** Set when the notice belongs to a work order; clearing on that work order's merge reads it. */
  readonly workOrderId: string | null;
  /** Plain display text; never decides anything. */
  readonly summary: string;
  readonly state: AttentionItemState;
  readonly raisedBy: string;
  readonly firstRaisedAtIso: string;
  readonly lastRaisedAtIso: string;
  /** How many raises this item has absorbed (1 at first raise). */
  readonly raisedCount: number;
  /** Null while open; the latest clearance once cleared (a reopen sets it back to null). */
  readonly clearance: AttentionItemClearanceRecord | null;
}
