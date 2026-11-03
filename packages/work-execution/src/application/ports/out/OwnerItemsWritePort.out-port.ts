// @generated outbound contract scaffold — refined for lane WB4c.
/**
 * OwnerItemsWritePort is the consumer-side port of plan §3.9: work-execution
 * opens one owner item per `open` plan decision, keyed
 * (projectId, planId, decisionId), and resolves it `plan-decided` or
 * `decision-removed`. The supplier lives in operator-coordination; an
 * unbound delegation refuses `not-configured`, a thrown one `unreadable`.
 */

export interface DecisionLaneBlock {
  readonly kind: 'lane';
  /** `<planId>/<laneId>` — the two-part lane block ref the board parses. */
  readonly ref: string;
}

export interface OpenDecisionItemRequest {
  readonly projectId: string;
  readonly planId: string;
  readonly decisionId: string;
  readonly subject: string;
  readonly blocks: readonly DecisionLaneBlock[];
}

export interface ResolvePlanDecisionRequest {
  readonly projectId: string;
  readonly planId: string;
  readonly decisionId: string;
  readonly outcome: 'decided' | 'removed';
  readonly planRevision: number;
}

export type OwnerItemsWriteRefusalCode = 'not-configured' | 'unreadable' | 'refused';

export type OpenDecisionItemResult =
  | { readonly outcome: 'opened' }
  | { readonly outcome: 'exists' }
  | { readonly outcome: 'refused'; readonly code: OwnerItemsWriteRefusalCode; readonly reason: string };

export type ResolvePlanDecisionResult =
  | { readonly outcome: 'resolved' }
  | { readonly outcome: 'unchanged' }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'refused'; readonly code: OwnerItemsWriteRefusalCode; readonly reason: string };

export interface OwnerItemsWritePort {
  /** Find-or-create the decision's owner item; `exists` is the repeat-import update. */
  openDecisionItem(request: OpenDecisionItemRequest): Promise<OpenDecisionItemResult>;
  /** Resolve the decision's owner item; `not-found` means there was never an item. */
  resolvePlanDecision(request: ResolvePlanDecisionRequest): Promise<ResolvePlanDecisionResult>;
}
