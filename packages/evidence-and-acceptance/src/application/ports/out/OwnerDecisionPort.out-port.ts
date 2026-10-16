// Outbound contract for resolving owner decision references through operator coordination.
/**
 * Owner decision references are resolved, never interpreted here: the supplier
 * context applies the coordination request's own authorization rule and this
 * port only reports the verdict. `unknown` and `not-approved` are both
 * blocking; neither is an acceptance.
 */

export interface ResolveOwnerDecisionRequest {
  readonly decisionReference: string;
  readonly candidateHeadSha: string;
}

export type OwnerDecisionResult =
  | { readonly outcome: 'approved'; readonly decisionId: string }
  | { readonly outcome: 'not-approved'; readonly reason: string }
  | { readonly outcome: 'unknown'; readonly reason: string };

export interface OwnerDecisionPort {
  /** Resolve one owner decision reference against an exact candidate head. */
  resolveOwnerDecision(request: ResolveOwnerDecisionRequest): Promise<OwnerDecisionResult>;
}