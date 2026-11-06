// @generated outbound contract scaffold — refined for migration step 1.
/**
 * BriefAuthoringPort: obtain a project orchestrator's brief or a hand-written
 * file without introducing provider inference into the control plane.
 */

export interface AuthoredBriefRequest {
  readonly workOrderId: string;
  readonly laneId: string;
  /** Path of a hand-written brief file, when one is used instead of the orchestrator. */
  readonly handWrittenBriefPath: string | null;
}

export interface AuthoredBrief {
  readonly proseMarkdown: string;
  readonly provenance: 'orchestrator' | 'hand-written-file';
}

export type AuthoredBriefResult =
  | { readonly outcome: 'authored'; readonly brief: AuthoredBrief }
  | { readonly outcome: 'unavailable'; readonly reason: string };

export interface BriefAuthorSessionRequest {
  /** brief-author/<workOrderId>/<laneId>@<base12> */
  readonly sessionKey: string;
  readonly workOrderId: string;
  readonly laneId: string;
  readonly baseCommit: string;
  readonly checkoutPath: string;
  readonly briefsDir: string;
  /** The rendered fact-pack prompt. */
  readonly prompt: string;
  readonly model: string;
  readonly variant?: string;
  readonly agent?: string;
  readonly timeoutMs?: number;
}

export const BRIEF_AUTHOR_SESSION_UNAVAILABLE = [
  'seat-command-not-configured', 'session-command-invalid', 'checkout-unavailable',
  'checkout-not-pinned', 'session-failed', 'session-empty', 'session-output-too-large',
  'session-timeout', 'session-not-supported',
] as const;
export type BriefAuthorSessionUnavailable = (typeof BRIEF_AUTHOR_SESSION_UNAVAILABLE)[number];

export type BriefAuthorSessionResult =
  | { readonly outcome: 'answered'; readonly answer: string }
  | { readonly outcome: 'unavailable'; readonly reason: BriefAuthorSessionUnavailable };

export interface BriefAuthoringPort {
  /** Obtain the reviewed prose brief for one lane. */
  authorBrief(request: AuthoredBriefRequest): Promise<AuthoredBriefResult>;
  /**
   * One read-only brief-author seat session per brief. The raw answer is
   * untrusted text. The method is optional so a port that cannot seat a
   * brief author still compiles; the use case refuses when it is absent.
   */
  authorBriefSession?(request: BriefAuthorSessionRequest): Promise<BriefAuthorSessionResult>;
}
