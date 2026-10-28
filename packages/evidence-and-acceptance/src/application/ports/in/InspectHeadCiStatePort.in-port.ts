/**
 * Read the CI state of one exact head through the forge, read-only (conductor plan §3.3, CI row).
 * Unknown is never a pass: an unreadable forge, no checks, or an answer for another head is `unknown`.
 */
export const HEAD_CI_STATES = ['pending', 'passed', 'failed', 'unknown'] as const;
export type HeadCiState = (typeof HEAD_CI_STATES)[number];

export const HEAD_CI_REASONS = ['read', 'not-configured', 'invalid-head', 'unreadable'] as const;
export type HeadCiReason = (typeof HEAD_CI_REASONS)[number];

export interface InspectHeadCiStateRequest {
  /** 40 lowercase hex. */
  readonly candidateHeadSha: string;
}

export interface InspectHeadCiStateResult {
  readonly candidateHeadSha: string;
  readonly state: HeadCiState;
  /** `read` exactly when `state` is `pending`, `passed` or `failed`. */
  readonly reason: HeadCiReason;
}

export interface InspectHeadCiStatePort {
  inspectHeadCiState(request: InspectHeadCiStateRequest): Promise<InspectHeadCiStateResult>;
}
