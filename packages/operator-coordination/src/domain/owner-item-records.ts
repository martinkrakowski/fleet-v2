/**
 * Owner item records are the pure, serializable facts of the `OwnerItem`
 * aggregate (work-board plan §3.3): the owner's to-do on the work board —
 * ids, enums, times and one bounded plain-text subject, never a credential, a
 * secret value or client content. They carry no behaviour, are kept beside —
 * never inside — the owner questions and coordination records, and an owner
 * item grants nothing.
 */

import type { OwnerItemKindValue } from './value-objects/OwnerItemKind.vo.js';
import type { OwnerQuestionBlockRecord } from './owner-question-records.js';

export const OWNER_ITEM_RECORD_VERSION = 1 as const;

export const OWNER_ITEM_STATES = ['open', 'closed', 'withdrawn'] as const;
export type OwnerItemState = (typeof OWNER_ITEM_STATES)[number];

export const OWNER_ITEM_RESOLUTION_KINDS = [
  'merged', 'pr-closed', 'answered', 'plan-decided', 'decision-removed', 'done',
] as const;
export type OwnerItemResolutionKind = (typeof OWNER_ITEM_RESOLUTION_KINDS)[number];

/** The only resolutions each kind may carry (plan §3.3 table). */
export const OWNER_ITEM_RESOLUTIONS_BY_KIND = {
  merge: ['merged', 'pr-closed'],
  decision: ['answered', 'plan-decided', 'decision-removed'],
  secret: ['done'],
  backup: ['done'],
  other: ['done'],
} as const satisfies Record<OwnerItemKindValue, readonly OwnerItemResolutionKind[]>;

export const OWNER_ITEM_WITHDRAW_REASONS = ['no-longer-needed', 'duplicate', 'superseded'] as const;
export type OwnerItemWithdrawReason = (typeof OWNER_ITEM_WITHDRAW_REASONS)[number];

export const OWNER_ITEM_DONE_VIAS = ['cli', 'web'] as const;
export type OwnerItemDoneVia = (typeof OWNER_ITEM_DONE_VIAS)[number];

export const OWNER_ITEM_HISTORY_EVENTS = ['opened', 'closed', 'reopened', 'withdrawn'] as const;
export type OwnerItemHistoryEvent = (typeof OWNER_ITEM_HISTORY_EVENTS)[number];

export const OWNER_ITEM_REF_KINDS = ['pr', 'lane', 'work-order', 'question', 'plan-decision', 'run'] as const;
export type OwnerItemRefKind = (typeof OWNER_ITEM_REF_KINDS)[number];

export const OWNER_ITEM_LIMITS = Object.freeze({
  subjectChars: 120,   // code points, plan §3.3
  idBytes: 256,        // itemId, createdBy, done.by, withdrawal.by, work-order/question/run ids, block refs
  repositoryBytes: 200,
  refs: 16,
  blocks: 16,
  history: 64,
  recordJsonChars: 32768,
});

/** Same values as work-execution's lane-plan-records.ts (WB1a); this context may not import it. */
export const OWNER_ITEM_PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const OWNER_ITEM_PLAN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const OWNER_ITEM_LANE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const OWNER_ITEM_DECISION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

export type OwnerItemRefRecord =
  | { readonly kind: 'pr'; readonly repository: string; readonly number: number }
  | { readonly kind: 'lane'; readonly planId: string; readonly laneId: string }
  | { readonly kind: 'work-order'; readonly id: string }
  | { readonly kind: 'question'; readonly id: string }
  | { readonly kind: 'plan-decision'; readonly planId: string; readonly decisionId: string }
  | { readonly kind: 'run'; readonly id: string };

/** The OwnerQuestion.blocks shape (plan §3.3); lane and pr refs are checked more strictly here. */
export type OwnerItemBlockRecord = OwnerQuestionBlockRecord;

export type OwnerItemResolutionRecord =
  | { readonly kind: 'merged'; readonly observedAtIso: string }
  | { readonly kind: 'pr-closed'; readonly observedAtIso: string }
  | { readonly kind: 'answered'; readonly questionId: string; readonly answeredAtIso: string }
  | { readonly kind: 'plan-decided'; readonly planRevision: number; readonly atIso: string }
  | { readonly kind: 'decision-removed'; readonly planRevision: number; readonly atIso: string }
  | { readonly kind: 'done'; readonly via: OwnerItemDoneVia; readonly by: string; readonly atIso: string };

export interface OwnerItemWithdrawalRecord {
  readonly reason: OwnerItemWithdrawReason;
  readonly by: string;
  readonly atIso: string;
}

/** `reason` is the resolution kind for `closed`, the withdraw reason for `withdrawn`, else null. */
export interface OwnerItemHistoryEntryRecord {
  readonly event: OwnerItemHistoryEvent;
  readonly atIso: string;
  readonly reason: OwnerItemResolutionKind | OwnerItemWithdrawReason | null;
}

/** Serializable snapshot of the OwnerItem aggregate (version 1). The store keeps its revision beside it. */
export interface OwnerItemRecord {
  readonly version: typeof OWNER_ITEM_RECORD_VERSION;
  readonly itemId: string;
  readonly projectId: string;
  readonly kind: OwnerItemKindValue;
  /** Plain text naming what is owed; required for `other`. For a secret, its purpose, never a value. */
  readonly subject: string | null;
  readonly refs: readonly OwnerItemRefRecord[];
  readonly blocks: readonly OwnerItemBlockRecord[];
  readonly createdAtIso: string;
  readonly createdBy: string;
  readonly state: OwnerItemState;
  readonly resolution: OwnerItemResolutionRecord | null;
  readonly withdrawal: OwnerItemWithdrawalRecord | null;
  /** Oldest first; the first entry is `opened` at createdAtIso. */
  readonly history: readonly OwnerItemHistoryEntryRecord[];
}
