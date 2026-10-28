// In-port — the conductor's gate step evaluates the frozen gate alone.

/**
 * Evaluate the frozen acceptance spec of a collected attempt at its exact
 * collected head, or read the stored outcome when the gate already ran at
 * that head.
 */
export interface EvaluateAttemptGateRequest {
  readonly attemptId: string;
  /** The exact collected head; any other head is `unknown`. */
  readonly candidateHeadSha: string;
}

/** `reason` is display text only; callers decide on `verdict`. */
export type EvaluateAttemptGateResult =
  | { readonly verdict: 'passed' }
  | { readonly verdict: 'failed'; readonly reason: string }
  | { readonly verdict: 'unknown'; readonly reason: string };

export interface EvaluateAttemptGatePort {
  /** Run (or read the stored outcome of) the frozen gate at one collected head; never requests a review. */
  evaluateAttemptGate(request: EvaluateAttemptGateRequest): Promise<EvaluateAttemptGateResult>;
}
