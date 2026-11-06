// @generated outbound contract scaffold — refined for lane CO8.
/**
 * ChainAttentionPort: raise or clear one chain attention item (chain-refresh-conflict,
 * link-not-landed or branch-moved), keyed by project, chain name, kind and link pull
 * request, through operator coordination's attention store. A repeat refreshes the open
 * item. The item grants and blocks nothing (the chain record's own mark is what blocks
 * landing), and a failed raise is reported, never retried blindly. Ids and codes only.
 */

export type ChainAttentionKind = 'chain-refresh-conflict' | 'link-not-landed' | 'branch-moved';

export interface ChainAttentionCommand {
  readonly projectId: string;
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly chainName: string;
  readonly kind: ChainAttentionKind;
  readonly linkPullRequest?: { readonly owner: string; readonly repo: string; readonly number: number };
}

export type RaiseChainAttentionResult =
  | { readonly outcome: 'raised' | 'refreshed' | 'reopened'; readonly reasonCode: null }
  | { readonly outcome: 'refused'; readonly reasonCode: string };

export type ClearChainAttentionResult =
  | { readonly outcome: 'cleared' | 'unchanged' | 'not-found'; readonly reasonCode: null }
  | { readonly outcome: 'refused'; readonly reasonCode: string };

export interface ChainAttentionPort {
  raiseChainAttention(command: ChainAttentionCommand): Promise<RaiseChainAttentionResult>;
  clearChainAttention(command: ChainAttentionCommand): Promise<ClearChainAttentionResult>;
}
