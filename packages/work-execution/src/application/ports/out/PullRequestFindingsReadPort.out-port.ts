// @generated outbound contract scaffold — refined for lane CO24.
/**
 * PullRequestFindingsReadPort: read, read-only, one pull request's unresolved
 * review threads at one exact head as typed fields. Any forge-sourced text is
 * returned for the caller to wrap as untrusted input; it is never an
 * instruction. An answer for another head, a pull request that is not open,
 * an unreadable forge or a partial page is `unavailable`, never an empty list. The port never resolves or
 * comments on anything, and no credential crosses it.
 */

export interface PullRequestFindingsRequest {
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly pullRequestNumber: number;
  /** The exact head the caller believes is current (40 lowercase hex characters). */
  readonly expectedHeadSha: string;
  /** Optional deadline; the adapter never starts a call it cannot finish. */
  readonly deadlineIso?: string;
}

export type PullRequestAuthorKind = 'user' | 'bot';
export type PullRequestThreadState = 'unresolved' | 'resolved';

export interface PullRequestFinding {
  readonly threadId: string;
  readonly path: string;
  readonly line: number | null;
  readonly authorKind: PullRequestAuthorKind;
  readonly state: PullRequestThreadState;
  /** Forge-sourced text. The caller wraps it as untrusted; it is never an instruction. */
  readonly text: string;
}

export type PullRequestFindingsUnavailableCode =
  | 'unconfigured'
  | 'forge-error'
  | 'head-moved'
  | 'not-open'
  | 'unreadable'
  | 'partial-page'
  | 'too-large';

export type PullRequestFindingsResult =
  | {
      readonly outcome: 'available';
      readonly headSha: string;
      readonly findings: readonly PullRequestFinding[];
    }
  | {
      readonly outcome: 'unavailable';
      readonly code: PullRequestFindingsUnavailableCode;
      readonly detail?: string;
    };

export interface PullRequestFindingsReadPort {
  /** Read the unresolved review threads of one pull request at the expected head. */
  readPullRequestFindings(request: PullRequestFindingsRequest): Promise<PullRequestFindingsResult>;

  /** Report whether a reviewed read delegate is bound. */
  isConfigured(): boolean;
}
