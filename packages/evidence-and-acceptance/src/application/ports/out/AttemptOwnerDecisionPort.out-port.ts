// Outbound contract for the owner decision references frozen in an attempt's brief.
/**
 * The one-way doors an attempt must clear are named by the product in the
 * frozen brief package and recorded on the attempt record at dispatch. This
 * port is the only way acceptance learns them: a request body, a worktree file
 * and a caller-supplied list are never a source of authority. An attempt record
 * written before the field existed reads as `unknown` and blocks.
 */

export interface ReadAttemptOwnerDecisionRequest {
  readonly attemptId: string;
}

export type AttemptOwnerDecisionResult =
  | { readonly outcome: 'recorded'; readonly ownerDecisionReferences: readonly string[] }
  | { readonly outcome: 'unknown'; readonly reason: string };

export interface AttemptOwnerDecisionPort {
  /** Read the owner decision references recorded for one attempt. */
  readAttemptOwnerDecisionReferences(
    request: ReadAttemptOwnerDecisionRequest,
  ): Promise<AttemptOwnerDecisionResult>;
}