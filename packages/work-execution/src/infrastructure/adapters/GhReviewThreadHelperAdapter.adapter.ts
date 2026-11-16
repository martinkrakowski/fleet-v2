// Lane OG-8a: operator helper for listing, replying to and resolving review threads.
/**
 * GhReviewThreadHelperAdapter implements ReviewThreadHelperPort through the
 * reviewed GitHub CLI subprocess: read-only listing pages plus one
 * ownership-check query and at most one mutation per call. Allow-listed argv,
 * mutation text always passed as a `-f` variable and never interpolated into
 * the query string, no credential and no forge stdout or stderr in any
 * result. Every call is raced against the budget rule (a call with under
 * 2 s left is not started) and the work is bounded in pages, stdout bytes
 * and body characters (at most MAX_PAGES pages are read once and walked in
 * one bounded loop; every comment body is capped at 2000 characters and a
 * reply body at 8000). A malformed answer, a repeated cursor or a short page
 * makes the whole answer `unreadable` instead of a guess. Details are fixed
 * phrases.
 */

import type {
  ListReviewThreadsRequest,
  ListReviewThreadsResult,
  ReplyToReviewThreadRequest,
  ReplyToReviewThreadResult,
  ResolveReviewThreadRequest,
  ResolveReviewThreadResult,
  ReviewThreadHelperPort,
  ReviewThreadRefusalCode,
  ReviewThreadSummary,
} from '../../application/ports/out/ReviewThreadHelperPort.out-port.js';
import type { GhInvocationResult } from './ForgeActionAdapter.adapter.js';

export interface GhReviewThreadHelperAdapterOptions {
  /** Host-side delegate; the composition root binds the reviewed subprocess. */
  readonly runGh?: (args: readonly string[], timeoutMs?: number) => Promise<GhInvocationResult>;
  /** Normal timeout for one graphql call; min(≤ this, deadlineIso − now) bounds each call. */
  readonly timeoutMs?: number; // default 30_000
  /** Test hook: wall clock (epoch ms) for the budget rule; default Date.now. */
  readonly now?: () => number;
}

const GRAPHQL_TIMEOUT_MS = 30_000;
const MIN_REMAINING_TO_START_MS = 2_000;
const GRAPHQL_TIMED_OUT = 'gh api graphql timed out';
const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const MAX_STDOUT_BYTES = 1_048_576;
const MAX_SUMMARY_BODY_CHARS = 2_000;
const MAX_REPLY_BODY_CHARS = 8_000;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+$/;
// The control characters are the point: a reply body carrying them is
// refused, so the no-control-regex lint rule is disabled on purpose.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\x00-\x09\x0b-\x1f\x7f]/;

const LIST_QUERY = `
  query ReviewThreadList($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: ${PAGE_SIZE}, after: $after) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            isResolved
            path
            line
            comments(first: 1) {
              nodes { body author { login } }
            }
          }
        }
      }
    }
  }
`;

const THREAD_CHECK_QUERY = `
  query ReviewThreadCheck($threadId: ID!) {
    node(id: $threadId) {
      __typename
      ... on PullRequestReviewThread {
        id
        pullRequest { number repository { name owner { login } } }
      }
    }
  }
`;

const REPLY_MUTATION = `
  mutation ReviewThreadReply($threadId: ID!, $body: String!) {
    addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
      comment { id }
    }
  }
`;

const RESOLVE_MUTATION = `
  mutation ReviewThreadResolve($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread { id isResolved }
    }
  }
`;

type Unavailable = { readonly outcome: 'unavailable'; readonly reason: string };
type Refused = { readonly outcome: 'refused'; readonly code: ReviewThreadRefusalCode; readonly reason: string };

function unavailable(reason: string): Unavailable {
  return { outcome: 'unavailable', reason };
}

function refused(code: ReviewThreadRefusalCode, reason: string): Refused {
  return { outcome: 'refused', code, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** One own data property, read without running a getter; undefined for anything else. */
function ownData(source: unknown, key: string): unknown {
  try {
    if (typeof source !== 'object' || source === null) {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    return descriptor === undefined ? undefined : descriptor.value;
  } catch {
    return undefined;
  }
}

interface ValidRequest {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly deadlineMs: number;
  readonly threadId: string | null;
  readonly body: string | null;
}

const INVALID = refused('invalid-input', 'request is not valid');

function validateRequest(request: unknown, mode: 'list' | 'reply' | 'resolve'): ValidRequest | Refused {
  const owner = ownData(ownData(request, 'repository'), 'owner');
  const repo = ownData(ownData(request, 'repository'), 'repo');
  if (
    typeof owner !== 'string' ||
    typeof repo !== 'string' ||
    !REPOSITORY_PATTERN.test(owner) ||
    !REPOSITORY_PATTERN.test(repo)
  ) {
    return INVALID;
  }
  const number = ownData(request, 'pullRequestNumber');
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) {
    return INVALID;
  }
  const deadline = ownData(request, 'deadlineIso');
  if (typeof deadline !== 'string' || deadline.length === 0 || !Number.isFinite(Date.parse(deadline))) {
    return INVALID;
  }
  let threadId: string | null = null;
  if (mode !== 'list') {
    const raw = ownData(request, 'threadId');
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      return INVALID;
    }
    threadId = raw;
  }
  let body: string | null = null;
  if (mode === 'reply') {
    const rawBody = ownData(request, 'body');
    if (
      typeof rawBody !== 'string' ||
      rawBody.trim().length === 0 ||
      rawBody.length > MAX_REPLY_BODY_CHARS ||
      CONTROL_CHARACTERS.test(rawBody)
    ) {
      return INVALID;
    }
    body = rawBody;
  }
  return { owner, repo, number, deadlineMs: Date.parse(deadline), threadId, body };
}

/** One parsed listing page: count, cursor and thread nodes; null when malformed. */
interface ListPage {
  readonly totalCount: number;
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
  readonly nodes: readonly unknown[];
}

function parseListPage(stdout: string): ListPage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
    return null;
  }
  if (!isRecord(parsed.data)) {
    return null;
  }
  const repository = parsed.data.repository;
  if (!isRecord(repository)) {
    return null;
  }
  const pullRequest = repository.pullRequest;
  if (!isRecord(pullRequest)) {
    return null;
  }
  const reviewThreads = pullRequest.reviewThreads;
  if (!isRecord(reviewThreads)) {
    return null;
  }
  const totalCount = reviewThreads.totalCount;
  if (typeof totalCount !== 'number' || !Number.isSafeInteger(totalCount) || totalCount < 0) {
    return null;
  }
  const pageInfo = reviewThreads.pageInfo;
  if (!isRecord(pageInfo) || typeof pageInfo.hasNextPage !== 'boolean') {
    return null;
  }
  const rawCursor = pageInfo.endCursor;
  if (rawCursor !== null && rawCursor !== undefined && typeof rawCursor !== 'string') {
    return null;
  }
  if (!Array.isArray(reviewThreads.nodes)) {
    return null;
  }
  return {
    totalCount,
    hasNextPage: pageInfo.hasNextPage,
    endCursor: typeof rawCursor === 'string' && rawCursor.trim().length > 0 ? rawCursor : null,
    nodes: reviewThreads.nodes,
  };
}

function parseThreadNode(node: unknown): ReviewThreadSummary | null {
  if (!isRecord(node)) {
    return null;
  }
  const id = node.id;
  const isResolved = node.isResolved;
  const path = node.path;
  if (typeof id !== 'string' || id.length === 0 || typeof isResolved !== 'boolean' || typeof path !== 'string') {
    return null;
  }
  const line = node.line;
  if (line !== null && (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 0)) {
    return null;
  }
  const comments = node.comments;
  if (!isRecord(comments) || !Array.isArray(comments.nodes)) {
    return null;
  }
  const first = comments.nodes[0];
  if (first === undefined) {
    return { threadId: id, isResolved, path, line: line ?? null, author: null, body: '' };
  }
  if (!isRecord(first) || typeof first.body !== 'string') {
    return null;
  }
  const author = ownData(ownData(first, 'author'), 'login');
  return {
    threadId: id,
    isResolved,
    path,
    line: line ?? null,
    author: typeof author === 'string' ? author : null,
    body: first.body.slice(0, MAX_SUMMARY_BODY_CHARS),
  };
}

/**
 * A mutation response carrying non-empty GraphQL errors is errored/uncertain
 * even when partial data looks usable, so it must not be treated as success.
 */
function mutationResponseHasErrors(parsed: unknown): boolean {
  if (!isRecord(parsed)) {
    return true;
  }
  return Array.isArray(parsed.errors) && parsed.errors.length > 0;
}

/** The parsed ownership-check answer: the thread's own pull request; null when malformed. */
interface ThreadLocation {
  readonly number: number;
  readonly owner: string;
  readonly repo: string;
}

function parseThreadLocation(stdout: string, requestedThreadId: string): ThreadLocation | null | 'absent' {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
    return null;
  }
  if (!isRecord(parsed.data)) {
    return null;
  }
  const node = parsed.data.node;
  if (node === null) {
    return 'absent';
  }
  if (!isRecord(node) || node.__typename !== 'PullRequestReviewThread') {
    return 'absent';
  }
  // The answer must be the requested thread itself: a malformed response that
  // names another node must never pass the ownership check.
  if (node.id !== requestedThreadId) {
    return 'absent';
  }
  const pullRequest = node.pullRequest;
  if (!isRecord(pullRequest)) {
    return null;
  }
  const number = pullRequest.number;
  const repository = pullRequest.repository;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || !isRecord(repository)) {
    return null;
  }
  const owner = ownData(ownData(repository, 'owner'), 'login');
  if (typeof owner !== 'string' || typeof repository.name !== 'string') {
    return null;
  }
  return { number, owner, repo: repository.name };
}

/** The thread is on the requested pull request; owner and repo compare in lower case. */
function sameRepositoryPullRequest(location: ThreadLocation, valid: ValidRequest): boolean {
  if (!REPOSITORY_PATTERN.test(location.owner) || !REPOSITORY_PATTERN.test(location.repo)) {
    return false;
  }
  return (
    location.number === valid.number &&
    location.owner.toLowerCase() === valid.owner.toLowerCase() &&
    location.repo.toLowerCase() === valid.repo.toLowerCase()
  );
}

export class GhReviewThreadHelperAdapter implements ReviewThreadHelperPort {
  private readonly runGh: ((args: readonly string[], timeoutMs?: number) => Promise<GhInvocationResult>) | undefined;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(options: GhReviewThreadHelperAdapterOptions = {}) {
    this.runGh = options.runGh;
    this.timeoutMs = options.timeoutMs ?? GRAPHQL_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
  }

  isConfigured(): boolean {
    return this.runGh !== undefined;
  }

  async listReviewThreads(request: ListReviewThreadsRequest): Promise<ListReviewThreadsResult> {
    if (this.runGh === undefined) {
      return unavailable('unconfigured');
    }
    const valid = validateRequest(request, 'list');
    if ('outcome' in valid) {
      return valid;
    }
    const threads: ReviewThreadSummary[] = [];
    const seenCursors = new Set<string>();
    const seenThreadIds = new Set<string>();
    let firstTotal: number | null = null;
    let cursor: string | null = null;
    for (let pageNumber = 1; ; pageNumber += 1) {
      if (pageNumber > MAX_PAGES) {
        return unavailable('unreadable');
      }
      const args: string[] = [
        'api',
        'graphql',
        '-f',
        `query=${LIST_QUERY}`,
        '-f',
        `owner=${valid.owner}`,
        '-f',
        `name=${valid.repo}`,
        '-F',
        `number=${valid.number}`,
      ];
      if (cursor !== null) {
        args.push('-f', `after=${cursor}`);
      }
      const gh = await this.invoke(args, valid.deadlineMs);
      if ('outcome' in gh) {
        return gh;
      }
      const page = parseListPage(gh.stdout);
      if (page === null) {
        return unavailable('unreadable');
      }
      if (firstTotal === null) {
        firstTotal = page.totalCount;
      } else if (page.totalCount !== firstTotal) {
        return unavailable('unreadable');
      }
      for (const node of page.nodes) {
        const thread = parseThreadNode(node);
        if (thread === null) {
          return unavailable('unreadable');
        }
        // A thread id seen twice across pages means the server is repeating
        // nodes, so the list is not a faithful complete answer.
        if (seenThreadIds.has(thread.threadId)) {
          return unavailable('unreadable');
        }
        seenThreadIds.add(thread.threadId);
        threads.push(thread);
      }
      if (!page.hasNextPage) {
        break;
      }
      if (page.endCursor === null || seenCursors.has(page.endCursor) || page.nodes.length === 0) {
        return unavailable('unreadable');
      }
      seenCursors.add(page.endCursor);
      cursor = page.endCursor;
    }
    if (firstTotal === null || threads.length !== firstTotal) {
      return unavailable('unreadable');
    }
    return { outcome: 'ok', threads };
  }

  async replyToReviewThread(request: ReplyToReviewThreadRequest): Promise<ReplyToReviewThreadResult> {
    if (this.runGh === undefined) {
      return unavailable('unconfigured');
    }
    const valid = validateRequest(request, 'reply');
    if ('outcome' in valid || valid.threadId === null || valid.body === null) {
      return INVALID;
    }
    const location = await this.threadLocation(valid.threadId, valid.deadlineMs);
    if ('outcome' in location) {
      return location;
    }
    if (!sameRepositoryPullRequest(location, valid)) {
      return refused('thread-not-on-pull-request', 'review thread belongs to another pull request');
    }
    const gh = await this.invoke(
      [
        'api',
        'graphql',
        '-f',
        `query=${REPLY_MUTATION}`,
        '-f',
        `threadId=${valid.threadId}`,
        '-f',
        `body=${valid.body}`,
      ],
      valid.deadlineMs,
    );
    if ('outcome' in gh) {
      return gh;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(gh.stdout);
    } catch {
      return unavailable('unreadable');
    }
    if (mutationResponseHasErrors(parsed)) {
      return unavailable('unreadable');
    }
    const commentId = ownData(ownData(ownData(ownData(parsed, 'data'), 'addPullRequestReviewThreadReply'), 'comment'), 'id');
    if (typeof commentId !== 'string' || commentId.length === 0) {
      return unavailable('unreadable');
    }
    return { outcome: 'ok', commentId };
  }

  async resolveReviewThread(request: ResolveReviewThreadRequest): Promise<ResolveReviewThreadResult> {
    if (this.runGh === undefined) {
      return unavailable('unconfigured');
    }
    const valid = validateRequest(request, 'resolve');
    if ('outcome' in valid || valid.threadId === null) {
      return INVALID;
    }
    const location = await this.threadLocation(valid.threadId, valid.deadlineMs);
    if ('outcome' in location) {
      return location;
    }
    if (!sameRepositoryPullRequest(location, valid)) {
      return refused('thread-not-on-pull-request', 'review thread belongs to another pull request');
    }
    const gh = await this.invoke(
      ['api', 'graphql', '-f', `query=${RESOLVE_MUTATION}`, '-f', `threadId=${valid.threadId}`],
      valid.deadlineMs,
    );
    if ('outcome' in gh) {
      return gh;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(gh.stdout);
    } catch {
      return unavailable('unreadable');
    }
    if (mutationResponseHasErrors(parsed)) {
      return unavailable('unreadable');
    }
    const thread = ownData(ownData(ownData(parsed, 'data'), 'resolveReviewThread'), 'thread');
    if (!isRecord(thread) || thread.isResolved !== true) {
      return unavailable('unreadable');
    }
    return { outcome: 'ok', isResolved: true };
  }

  /** The one ownership-check query before any mutation. */
  private async threadLocation(
    threadId: string,
    deadlineMs: number,
  ): Promise<ThreadLocation | Unavailable | Refused> {
    const gh = await this.invoke(
      ['api', 'graphql', '-f', `query=${THREAD_CHECK_QUERY}`, '-f', `threadId=${threadId}`],
      deadlineMs,
    );
    if ('outcome' in gh) {
      return gh;
    }
    const location = parseThreadLocation(gh.stdout, threadId);
    if (location === null) {
      return unavailable('unreadable');
    }
    if (location === 'absent') {
      return refused('thread-not-found', 'review thread not found');
    }
    return location;
  }

  /**
   * Budget rule: a call is started only while at least 2 s remain to the
   * deadline, and is raced against min(timeoutMs, time to the deadline).
   */
  private async invoke(
    args: readonly string[],
    deadlineMs: number,
  ): Promise<Extract<ListReviewThreadsResult, { outcome: 'unavailable' }> | { stdout: string }> {
    const remaining = Math.max(0, deadlineMs - this.now());
    if (remaining < MIN_REMAINING_TO_START_MS) {
      return unavailable('budget-exhausted');
    }
    const callTimeoutMs = Math.min(this.timeoutMs, remaining);
    const runGh = this.runGh;
    if (runGh === undefined) {
      return unavailable('unconfigured');
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stdout: string;
    try {
      const pending = runGh(args, callTimeoutMs);
      pending.catch(() => undefined);
      const gh = await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(GRAPHQL_TIMED_OUT)), callTimeoutMs);
        }),
      ]);
      if (
        !isRecord(gh) ||
        typeof (gh as Record<string, unknown>).exitCode !== 'number' ||
        typeof (gh as Record<string, unknown>).stdout !== 'string'
      ) {
        return unavailable('unreadable');
      }
      const result = gh as GhInvocationResult;
      if (result.exitCode !== 0) {
        return unavailable('forge-error');
      }
      if (result.stdout.trim() === '') {
        return unavailable('forge-error');
      }
      if (Buffer.byteLength(result.stdout, 'utf8') > MAX_STDOUT_BYTES) {
        return unavailable('unreadable');
      }
      stdout = result.stdout;
    } catch (error) {
      if (error instanceof Error && error.message === GRAPHQL_TIMED_OUT) {
        return unavailable('timeout');
      }
      return unavailable('forge-error');
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
    return { stdout };
  }
}
