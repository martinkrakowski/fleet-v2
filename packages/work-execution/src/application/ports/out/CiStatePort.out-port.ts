// CiStatePort: CI state of one exact head, read from the forge through the evidence context (plan §3.3, CI row). Unknown is never a pass.

export type CiState = 'pending' | 'passed' | 'failed' | 'unknown';
export type CiStateReason = 'read' | 'not-configured' | 'invalid-head' | 'unreadable' | 'head-moved';

export interface ReadHeadCiStateRequest {
  /** 40 lowercase hex. */
  readonly headSha: string;
}

export interface HeadCiStateRead {
  readonly headSha: string;
  readonly state: CiState;
  readonly reason: CiStateReason;
}

export interface CiStatePort {
  readHeadCiState(request: ReadHeadCiStateRequest): Promise<HeadCiStateRead>;
}
