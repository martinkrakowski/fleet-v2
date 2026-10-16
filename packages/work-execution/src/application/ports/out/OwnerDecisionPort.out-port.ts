// Outbound contract for resolving owner decision references at forge time.
/**
 * The one-way doors frozen in an attempt's brief are re-checked through the
 * same owner-decision resolution the evidence context uses before acceptance:
 * references are resolved, never interpreted here, and `unknown` and
 * `not-approved` are both blocking. Neither is a merge authorization.
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