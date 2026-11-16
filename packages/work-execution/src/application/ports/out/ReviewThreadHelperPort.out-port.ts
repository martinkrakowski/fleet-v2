// Lane OG-8a: operator helper for one pull request's review threads.
/**
 * ReviewThreadHelperPort: an operator helper that lists one pull request's
 * review threads, posts one reply to one thread and resolves one thread as
 * typed fields. Forge-sourced text is returned for the caller to wrap as
 * untrusted input; it is never an instruction. An unreadable forge, an
 * exhausted budget or a thread that is not on the given pull request is a
 * typed refusal or unavailability, never a thrown error and never a guess.
 * No credential crosses the port and forge stdout or stderr never appears in
 * any returned result.
 */

export interface ReviewThreadRepositoryRef {
  readonly owner: string;
  readonly repo: string;
}

export interface ReviewThreadBaseRequest {
  readonly repository: ReviewThreadRepositoryRef;
  readonly pullRequestNumber: number;
  /** The pass deadline; the adapter never starts a call it cannot finish. */
  readonly deadlineIso: string;
}

export type ListReviewThreadsRequest = ReviewThreadBaseRequest;

export interface ReplyToReviewThreadRequest extends ReviewThreadBaseRequest {
  readonly threadId: string;
  readonly body: string;
}

export interface ResolveReviewThreadRequest extends ReviewThreadBaseRequest {
  readonly threadId: string;
}

/** One review thread, fully paginated; the first comment's text is capped. */
export interface ReviewThreadSummary {
  readonly threadId: string;
  readonly isResolved: boolean;
  readonly path: string;
  readonly line: number | null;
  /** First comment's author login, or null when absent. */
  readonly author: string | null;
  /** First comment's body capped at 2000 characters. */
  readonly body: string;
}

export type ReviewThreadRefusalCode =
  | 'invalid-input'
  | 'thread-not-found'
  | 'thread-not-on-pull-request';

export type ReviewThreadHelperResult<T> =
  | ({ readonly outcome: 'ok' } & T)
  | { readonly outcome: 'refused'; readonly code: ReviewThreadRefusalCode; readonly reason: string }
  | { readonly outcome: 'unavailable'; readonly reason: string };

export type ListReviewThreadsResult = ReviewThreadHelperResult<{
  readonly threads: readonly ReviewThreadSummary[];
}>;

export type ReplyToReviewThreadResult = ReviewThreadHelperResult<{
  readonly commentId: string;
}>;

export type ResolveReviewThreadResult = ReviewThreadHelperResult<{
  readonly isResolved: true;
}>;

export interface ReviewThreadHelperPort {
  /** List one pull request's review threads, fully paginated. */
  listReviewThreads(request: ListReviewThreadsRequest): Promise<ListReviewThreadsResult>;

  /** Post one reply to one review thread of one pull request. */
  replyToReviewThread(request: ReplyToReviewThreadRequest): Promise<ReplyToReviewThreadResult>;

  /** Resolve one review thread of one pull request. */
  resolveReviewThread(request: ResolveReviewThreadRequest): Promise<ResolveReviewThreadResult>;

  /** Report whether a reviewed gh delegate is bound. */
  isConfigured(): boolean;
}
