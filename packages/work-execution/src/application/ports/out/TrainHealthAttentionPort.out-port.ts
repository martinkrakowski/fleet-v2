// @generated outbound contract scaffold — refined for lane CO-WD2.
/**
 * TrainHealthAttentionPort: raise, clear or list the seven train-health item
 * codes keyed by project, repository, rule and pull request, through operator
 * coordination's attention store. Every request carries the pass deadline and
 * the caller bounds each await with the remaining call budget. A repeat raise
 * refreshes the open item; a failed raise is reported, never retried blindly.
 * A successful raise returns `previousRaisedAtIso`: the item's `lastRaisedAtIso`
 * immediately before this raise. It is null when `outcome` is `'raised'`, which
 * means there was no prior open or closed record. Callers decide whether to
 * speak from that previous time, because the refresh replaces the stored
 * timestamp and a later read can no longer see it. Ids and codes only.
 */

export const TRAIN_HEALTH_ATTENTION_RULES = [
  'tick-stale',
  'stale-queue-entry',
  'stalled-head',
  'repeated-park',
  'watchdog-blind',
  'findings-truncated',
  'queue-too-large',
] as const;

export type TrainHealthAttentionRule = (typeof TRAIN_HEALTH_ATTENTION_RULES)[number];

export interface TrainHealthAttentionCommand {
  readonly projectId: string;
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly rule: TrainHealthAttentionRule;
  readonly pullRequest: number | null;
  readonly deadlineIso: string;
}

export type RaiseTrainHealthAttentionResult =
  | {
      readonly outcome: 'raised' | 'refreshed' | 'reopened';
      readonly reasonCode: null;
      /** `lastRaisedAtIso` immediately before this raise; null when `outcome` is `'raised'`. */
      readonly previousRaisedAtIso: string | null;
    }
  | { readonly outcome: 'refused'; readonly reasonCode: string };

export type ClearTrainHealthAttentionResult =
  | { readonly outcome: 'cleared' | 'unchanged' | 'not-found'; readonly reasonCode: null }
  | { readonly outcome: 'refused'; readonly reasonCode: string };

/** One open attention item, read back with the time of its last raise. */
export interface OpenTrainHealthAttentionItem {
  readonly rule: TrainHealthAttentionRule;
  readonly pullRequest: number | null;
  readonly lastRaisedAtIso: string;
}

export type ListOpenTrainHealthAttentionResult =
  | { readonly outcome: 'found'; readonly items: readonly OpenTrainHealthAttentionItem[] }
  | { readonly outcome: 'unavailable' };

export interface TrainHealthAttentionPort {
  raiseTrainHealthAttention(command: TrainHealthAttentionCommand): Promise<RaiseTrainHealthAttentionResult>;
  clearTrainHealthAttention(command: TrainHealthAttentionCommand): Promise<ClearTrainHealthAttentionResult>;
  listOpenTrainHealthAttention(query: {
    readonly projectId: string;
    readonly repository: { readonly owner: string; readonly repo: string };
    readonly deadlineIso: string;
  }): Promise<ListOpenTrainHealthAttentionResult>;
}
