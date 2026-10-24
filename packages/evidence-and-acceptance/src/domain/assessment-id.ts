/**
 * Deterministic identity of the acceptance assessment bound to one attempt.
 * Both composition roots (CLI and API) must write and read acceptance
 * assessments under this same prefixed id; a bare attempt id is only kept as
 * a legacy read fallback for state stored before this rule.
 */
export function assessmentIdForAttempt(attemptId: string): string {
  return `assessment-${attemptId}`;
}
