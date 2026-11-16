// @generated outbound contract scaffold — refined for lane CO-WD2.
/**
 * TrainHealthAttentionPort: raise, clear or list the seven train-health item
 * codes keyed by project, repository, rule and pull request, through operator
 * coordination's attention store. A repeat raise refreshes the open item; a
 * failed raise is reported, never retried blindly. Ids and codes only.
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
}

export type RaiseTrainHealthAttentionResult =
  | { readonly outcome: 'raised' | 'refreshed' | 'reopened'; readonly reasonCode: null }
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
  }): Promise<ListOpenTrainHealthAttentionResult>;
}
