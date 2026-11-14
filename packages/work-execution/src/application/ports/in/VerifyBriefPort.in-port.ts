// Lane CO18: pre-dispatch verification of a frozen brief package.
/**
 * Verifies that the frozen brief package (`.lane/brief-manifest.json` plus
 * `.lane/brief.md`) in a worktree matches the `WorkOrderRecord` it claims to
 * implement. Every path returns a typed verdict: a refusal carries a fixed
 * reason code and a detail code (ids and codes only, never file content), an
 * incomplete verification is `unverified` and never `verified`.
 */

/** The default frozen prose location inside the worktree. */
export const VERIFY_BRIEF_DEFAULT_PROSE_PATH = '.lane/brief.md';
/** The default frozen manifest location inside the worktree. */
export const VERIFY_BRIEF_DEFAULT_MANIFEST_PATH = '.lane/brief-manifest.json';

export interface VerifyBriefRequest {
  readonly workOrderId: string;
  readonly attemptId: string;
  readonly worktreePath: string;
  /** The digest the frozen package claims; hex-64. */
  readonly expectedBriefDigest: string;
  /** Defaults to `.lane/brief.md`. */
  readonly prosePath?: string;
  /** Defaults to `.lane/brief-manifest.json`. */
  readonly manifestPath?: string;
  /** The recorded host of the worktree, when the artifacts are read remotely. */
  readonly recordedHost?: string;
}

export type VerifyBriefRefusalReason =
  | 'invalid-request'
  | 'work-order-terminal'
  | 'missing-package'
  | 'unreadable-package'
  | 'malformed-package'
  | 'owned-paths-mismatch'
  | 'path-escapes-allowed-prefixes'
  | 'review-failed';

export type VerifyBriefUnverifiedReason =
  | 'work-order-missing'
  | 'work-order-unreadable'
  | 'artifact-reader-unavailable'
  | 'digest-computation-failed'
  | 'review-unverified';

export type VerifyBriefResult =
  | {
      readonly outcome: 'verified';
      readonly workOrderId: string;
      readonly attemptId: string;
      readonly briefDigest: string;
      readonly verificationKey: string;
    }
  | { readonly outcome: 'refused'; readonly reason: VerifyBriefRefusalReason; readonly detail: string | null }
  | { readonly outcome: 'unverified'; readonly reason: VerifyBriefUnverifiedReason; readonly detail: string | null };

export interface VerifyBriefPort {
  verifyBrief(request: VerifyBriefRequest): Promise<VerifyBriefResult>;
}
