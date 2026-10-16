// Outbound contract for resolving owner decision references through operator coordination.

export interface ResolveOwnerDecisionRequest {
  readonly decisionReference: string;
  readonly candidateHeadSha: string;
}

export interface OwnerDecisionRecordSnapshot {
  readonly id: string;
  readonly state: string;
  readonly expectedHeadSha: string | null;
}

export type OwnerDecisionResult =
  | { readonly outcome: 'resolved'; readonly decision: OwnerDecisionRecordSnapshot }
  | { readonly outcome: 'unresolvable'; readonly reason: string }
  | { readonly outcome: 'unknown'; readonly reason: string };

export interface OwnerDecisionPort {
  /** Resolve one owner decision reference. */
  resolveOwnerDecision(request: ResolveOwnerDecisionRequest): Promise<OwnerDecisionResult>;
}
