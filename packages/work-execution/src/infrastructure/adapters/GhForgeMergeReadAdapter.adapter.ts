// @generated adapter scaffold — implemented for lane DT5.
/**
 * GhForgeMergeReadAdapter implements ForgeMergeReadPort through the reviewed
 * GitHub CLI subprocess: one read-only `gh api graphql` reader per page,
 * allow-listed argv, racing every call against the budget rule (plan
 * §3.1): each call takes `min(normal timeout, deadlineIso − now)`, a call
 * with under 2 s left is not started and returns `budget-exhausted`, and a
 * call that loses the race is a `forge-error`, never a guess. Contexts
 * (`statusCheckRollup.contexts`, a CheckRun/StatusContext union) and review
 * threads (`reviewThreads`) are both fully paginated with cursor variables;
 * green is `SUCCESS` only, `premerge` additionally needs the poster's login,
 * a required name absent from every fully read page is missing (never green),
 * and an unreadable page makes the whole fact unknown rather than a partial
 * answer.
 */

import type { GhInvocationResult } from './ForgeActionAdapter.adapter.js';
import { parseMergeStateStatus } from './ForgeReadAdapter.adapter.js';
import type {
  ForgeMergeReadPort,
  ForgeMergeState,
  ForgePrState,
  ReadForgeMergeRequest,
  ReadForgeMergeResult,
} from '../../application/ports/out/ForgeMergeReadPort.out-port.js';

export interface GhForgeMergeReadAdapterOptions {
  /** Host-side delegate; the composition root binds the reviewed subprocess. */
  readonly runGh?: (args: readonly string[]) => Promise<GhInvocationResult>;
  /** Normal timeout for one graphql call; min(≤ this, deadlineIso − now) bounds each call. */
  readonly timeoutMs?: number; // default 30_000, ForgeReadAdapter.adapter.ts:40 precedent
  /** Test hook: wall clock (epoch ms) for the budget rule; default Date.now. */
  readonly now?: () => number;
}

const GRAPHQL_TIMEOUT_MS = 30_000;
const GRAPHQL_MAX_STDOUT_BYTES = 1_048_576;
const BUDGET_MIN_REMAINING_MS = 2_000;
const GRAPHQL_TIMED_OUT = 'gh api graphql timed out';
const PAGE_SIZE = 100;
const HEX_40 = /^[0-9a-f]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+$/;

const MERGE_READ_QUERY = `
  query MergeRead(
    $owner: String!, $repo: String!, $number: Int!,
    $contextsAfter: String, $threadsAfter: String
  ) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        state
        headRefOid
        mergeStateStatus
        statusCheckRollup {
          contexts(first: ${PAGE_SIZE}, after: $contextsAfter) {
            pageInfo { hasNextPage endCursor }
            nodes {
              __typename
              ... on CheckRun {
                name
                status
                conclusion
                creator { login }
              }
              ... on StatusContext {
                context
                state
                creator { login }
              }
            }
          }
        }
        reviewThreads(first: ${PAGE_SIZE}, after: $threadsAfter) {
          pageInfo { hasNextPage endCursor }
          nodes { isResolved }
        }
      }
    }
  }
`;

/** One context node normalized from a rollup page. */
export interface MergeContextNode {
  readonly name: string;
  readonly state: string;
  readonly creatorLogin: string | null;
}

export type MergeContextsPageResult =
  | {
      readonly kind: 'page';
      readonly nodes: readonly MergeContextNode[];
      readonly hasNextPage: boolean;
      readonly endCursor: string | null;
    }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'unknown'; readonly reason: string };

export type MergeThreadsPageResult =
  | {
      readonly kind: 'page';
      readonly unresolved: number;
      readonly hasNextPage: boolean;
      readonly endCursor: string | null;
    }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'unknown'; readonly reason: string };

export type MergePrMetaResult =
  | { readonly kind: 'ok'; readonly prState: ForgePrState; readonly liveHeadSha: string; readonly mergeState: ForgeMergeState }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'unknown'; readonly reason: string };

interface MergePrMetaPayload {
  readonly prState: ForgePrState;
  readonly liveHeadSha: string;
  readonly mergeState: ForgeMergeState;
}

function isValidRepository(repository: { readonly owner?: unknown; readonly repo?: unknown }): boolean {
  return (
    typeof repository.owner === 'string' &&
    typeof repository.repo === 'string' &&
    REPOSITORY_PATTERN.test(repository.owner) &&
    REPOSITORY_PATTERN.test(repository.repo)
  );
}

function isPullRequestNotFound(gh: GhInvocationResult): boolean {
  const text = `${gh.stderr}\n${gh.stdout}`.toLowerCase();
  return text.includes('could not resolve to a pullrequest');
}

/** Navigate a GraphQL page answer to the pullRequest object, or `undefined` when unusable. */
function readPullRequest(stdout: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  const repository = (parsed as Record<string, unknown>).repository;
  if (repository === null || typeof repository !== 'object' || Array.isArray(repository)) {
    return undefined;
  }
  const pullRequest = (repository as Record<string, unknown>).pullRequest;
  if (pullRequest === null || typeof pullRequest !== 'object' || Array.isArray(pullRequest)) {
    return undefined;
  }
  return pullRequest as Record<string, unknown>;
}

interface PageInfo {
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

function parsePageInfo(value: unknown): PageInfo | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const hasNextPage = record.hasNextPage;
  if (typeof hasNextPage !== 'boolean') {
    return null;
  }
  const endCursor = record.endCursor;
  if (endCursor !== null && endCursor !== undefined && typeof endCursor !== 'string') {
    return null;
  }
  return { hasNextPage, endCursor: typeof endCursor === 'string' ? endCursor : null };
}

function normalizeContextNode(node: unknown): MergeContextNode | null {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    return null;
  }
  const record = node as Record<string, unknown>;
  const typename = record.__typename;
  let name: unknown;
  let state: unknown;
  let creator: unknown;
  if (typename === 'CheckRun') {
    name = record.name;
    state = typeof record.conclusion === 'string' ? record.conclusion : record.status;
    creator = record.creator;
  } else if (typename === 'StatusContext') {
    name = record.context;
    state = record.state;
    creator = record.creator;
  } else {
    return null;
  }
  if (typeof name !== 'string' || name.length === 0 || typeof state !== 'string' || state.length === 0) {
    return null;
  }
  let creatorLogin: string | null = null;
  if (creator !== null && creator !== undefined) {
    if (typeof creator !== 'object' || Array.isArray(creator)) {
      return null;
    }
    const login = (creator as Record<string, unknown>).login;
    if (login !== null && login !== undefined && typeof login !== 'string') {
      return null;
    }
    creatorLogin = typeof login === 'string' ? login : null;
  }
  return { name, state, creatorLogin };
}

/** Pure parse of one page's contexts connection (`statusCheckRollup.contexts`). */
export function parseMergeContextsPage(stdout: string): MergeContextsPageResult {
  const pullRequest = readPullRequest(stdout);
  if (pullRequest === undefined) {
    return { kind: 'unreadable' };
  }
  const rollup = pullRequest.statusCheckRollup;
  if (rollup !== null && (typeof rollup !== 'object' || Array.isArray(rollup))) {
    return { kind: 'unreadable' };
  }
  const contexts = rollup === null ? null : (rollup as Record<string, unknown>).contexts;
  if (contexts === null) {
    return { kind: 'page', nodes: [], hasNextPage: false, endCursor: null };
  }
  if (typeof contexts !== 'object' || Array.isArray(contexts)) {
    return { kind: 'unreadable' };
  }
  const pageInfo = parsePageInfo((contexts as Record<string, unknown>).pageInfo);
  if (pageInfo === null) {
    return { kind: 'unreadable' };
  }
  const rawNodes = (contexts as Record<string, unknown>).nodes;
  if (!Array.isArray(rawNodes)) {
    return { kind: 'unreadable' };
  }
  const nodes: MergeContextNode[] = [];
  for (const raw of rawNodes) {
    const node = normalizeContextNode(raw);
    if (node === null) {
      return { kind: 'unknown', reason: 'a context node is malformed' };
    }
    nodes.push(node);
  }
  return { kind: 'page', nodes, hasNextPage: pageInfo.hasNextPage, endCursor: pageInfo.endCursor };
}

/** Pure parse of one page's review threads connection (`reviewThreads`). */
export function parseReviewThreadsPage(stdout: string): MergeThreadsPageResult {
  const pullRequest = readPullRequest(stdout);
  if (pullRequest === undefined) {
    return { kind: 'unreadable' };
  }
  const threads = pullRequest.reviewThreads;
  if (threads === null) {
    return { kind: 'page', unresolved: 0, hasNextPage: false, endCursor: null };
  }
  if (typeof threads !== 'object' || Array.isArray(threads)) {
    return { kind: 'unreadable' };
  }
  const pageInfo = parsePageInfo((threads as Record<string, unknown>).pageInfo);
  if (pageInfo === null) {
    return { kind: 'unreadable' };
  }
  const rawNodes = (threads as Record<string, unknown>).nodes;
  if (!Array.isArray(rawNodes)) {
    return { kind: 'unreadable' };
  }
  let unresolved = 0;
  for (const raw of rawNodes) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { kind: 'unknown', reason: 'a review thread node is malformed' };
    }
    const isResolved = (raw as Record<string, unknown>).isResolved;
    if (typeof isResolved !== 'boolean') {
      return { kind: 'unknown', reason: 'a review thread node is malformed' };
    }
    if (!isResolved) {
      unresolved += 1;
    }
  }
  return { kind: 'page', unresolved, hasNextPage: pageInfo.hasNextPage, endCursor: pageInfo.endCursor };
}

/** Pure parse of the PR-level meta (`state`, `headRefOid`, `mergeStateStatus`). */
export function parseMergePrMeta(stdout: string): MergePrMetaResult {
  const pullRequest = readPullRequest(stdout);
  if (pullRequest === undefined) {
    return { kind: 'unreadable' };
  }
  const state = pullRequest.state;
  let prState: ForgePrState;
  if (state === 'OPEN') {
    prState = 'open';
  } else if (state === 'MERGED') {
    prState = 'merged';
  } else if (state === 'CLOSED') {
    prState = 'closed';
  } else {
    return { kind: 'unreadable' };
  }
  const headRefOid = pullRequest.headRefOid;
  if (typeof headRefOid !== 'string' || !HEX_40.test(headRefOid)) {
    return { kind: 'unknown', reason: 'the head oid is not 40 hex' };
  }
  const mergeState = parseMergeStateStatus(pullRequest.mergeStateStatus);
  return { kind: 'ok', prState, liveHeadSha: headRefOid, mergeState };
}

function guardRequest(
  request: ReadForgeMergeRequest,
  runGh: ((args: readonly string[]) => Promise<GhInvocationResult>) | undefined,
): string | null {
  if (runGh === undefined) {
    return 'merge read is not configured';
  }
  if (!isValidRepository(request.repository)) {
    return 'forge repository is not configured or not valid';
  }
  if (!Number.isSafeInteger(request.pullRequestNumber) || request.pullRequestNumber < 1) {
    return 'pull request number is not valid';
  }
  return null;
}

export class GhForgeMergeReadAdapter implements ForgeMergeReadPort {
  private readonly runGh?: (args: readonly string[]) => Promise<GhInvocationResult>;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(options: GhForgeMergeReadAdapterOptions = {}) {
    this.runGh = options.runGh;
    this.timeoutMs = options.timeoutMs ?? GRAPHQL_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
  }

  isConfigured(): boolean {
    return this.runGh !== undefined;
  }

  async readForgeMerge(request: ReadForgeMergeRequest): Promise<ReadForgeMergeResult> {
    const guardReason = guardRequest(request, this.runGh);
    if (guardReason !== null) {
      return { outcome: 'unavailable', code: 'forge-error', reason: guardReason };
    }

    const requiredContexts = request.requiredContexts;
    const contextsByName = new Map<string, MergeContextNode>();
    let contextsHasNext = true;
    let contextsCursor: string | null = null;
    let threadsUnresolved = 0;
    let threadsHasNext = true;
    let threadsCursor: string | null = null;
    let threadsUnknown = false;
    let meta: MergePrMetaPayload | null = null;

    while (contextsHasNext || threadsHasNext) {
      const budget = this.budget(request.deadlineIso);
      if (budget === null) {
        return { outcome: 'unavailable', code: 'unknown', reason: 'deadline is not a valid ISO time' };
      }
      if (budget.remainingToDeadline < BUDGET_MIN_REMAINING_MS) {
        return { outcome: 'budget-exhausted' };
      }
      const fetched = await this.runPage(request, contextsCursor, threadsCursor, budget.timerMs);
      if (fetched.kind !== 'page') {
        return fetched.kind === 'not-found'
          ? { outcome: 'not-found' }
          : { outcome: 'unavailable', code: fetched.code, reason: fetched.reason };
      }
      if (meta === null) {
        meta = fetched.meta;
      }
      for (const node of fetched.contexts.nodes) {
        contextsByName.set(node.name, node);
      }
      contextsHasNext = fetched.contexts.hasNextPage;
      contextsCursor = fetched.contexts.hasNextPage ? fetched.contexts.endCursor : null;
      if (fetched.threads.kind === 'page') {
        threadsUnresolved += fetched.threads.unresolved;
        threadsHasNext = fetched.threads.hasNextPage;
        threadsCursor = fetched.threads.hasNextPage ? fetched.threads.endCursor : null;
      } else {
        threadsUnknown = true;
        threadsHasNext = false;
      }
    }

    if (meta === null) {
      return { outcome: 'unavailable', code: 'unknown', reason: 'no forge page was read' };
    }

    const contexts = requiredContexts.map((name) => {
      const node = contextsByName.get(name);
      if (node === undefined) {
        return { name, state: 'missing', isGreen: false, creatorLogin: null };
      }
      const isGreen =
        node.state === 'SUCCESS' && (name !== 'premerge' || node.creatorLogin === request.posterLogin);
      return { name, state: node.state, isGreen, creatorLogin: node.creatorLogin };
    });

    return {
      outcome: 'ok',
      prState: meta.prState,
      liveHeadSha: meta.liveHeadSha,
      mergeState: meta.mergeState,
      contexts,
      unresolvedThreads: threadsUnknown ? 'unknown' : threadsUnresolved,
    };
  }

  private async runPage(
    request: ReadForgeMergeRequest,
    contextsCursor: string | null,
    threadsCursor: string | null,
    remaining: number,
  ): Promise<
    | {
        kind: 'page';
        meta: MergePrMetaPayload;
        contexts: MergeContextsPageResult & { kind: 'page' };
        threads: MergeThreadsPageResult;
      }
    | { kind: 'not-found' }
    | { kind: 'unavailable'; code: 'forge-error' | 'unreadable' | 'unknown'; reason: string }
  > {
    const args = this.graphqlArgs(request, contextsCursor, threadsCursor);
    const raced = await this.runGhWithinTimeout(args, remaining);
    if (raced.kind === 'failed') {
      return { kind: 'unavailable', code: 'forge-error', reason: 'gh api graphql could not complete' };
    }
    if (raced.kind === 'timed-out') {
      return { kind: 'unavailable', code: 'forge-error', reason: 'gh api graphql timed out' };
    }
    const gh = raced.gh;
    if (gh.exitCode !== 0) {
      if (isPullRequestNotFound(gh)) {
        return { kind: 'not-found' };
      }
      return { kind: 'unavailable', code: 'forge-error', reason: `gh api graphql failed (exit ${gh.exitCode})` };
    }
    if (gh.stdout.trim() === '') {
      return { kind: 'unavailable', code: 'forge-error', reason: 'gh api graphql returned no output' };
    }
    if (Buffer.byteLength(gh.stdout, 'utf8') > GRAPHQL_MAX_STDOUT_BYTES) {
      return { kind: 'unavailable', code: 'forge-error', reason: 'gh api graphql output too large' };
    }
    const meta = parseMergePrMeta(gh.stdout);
    if (meta.kind !== 'ok') {
      return meta.kind === 'unreadable'
        ? { kind: 'unavailable', code: 'unreadable', reason: 'gh api graphql returned an unreadable answer' }
        : { kind: 'unavailable', code: 'unknown', reason: meta.reason };
    }
    const contexts = parseMergeContextsPage(gh.stdout);
    if (contexts.kind !== 'page') {
      return contexts.kind === 'unreadable'
        ? { kind: 'unavailable', code: 'unreadable', reason: 'gh api graphql returned an unreadable contexts page' }
        : { kind: 'unavailable', code: 'unknown', reason: contexts.reason };
    }
    const threads = parseReviewThreadsPage(gh.stdout);
    return { kind: 'page', meta, contexts, threads };
  }

  /**
   * Budget rule (plan §3.1): a call is started only while more than 2 s
   * remain to the deadline, and the call itself is raced against
   * `min(timeoutMs, deadlineIso − now)` — the deadline floor is about the
   * pass, never a test hook shrinking the per-call timeout.
   */
  private budget(deadlineIso: string): { readonly remainingToDeadline: number; readonly timerMs: number } | null {
    const nowMs = this.now();
    const deadlineMs = Date.parse(deadlineIso);
    if (!Number.isFinite(deadlineMs)) {
      return null;
    }
    const remainingToDeadline = Math.max(0, deadlineMs - nowMs);
    return { remainingToDeadline, timerMs: Math.min(this.timeoutMs, remainingToDeadline) };
  }

  private graphqlArgs(
    request: ReadForgeMergeRequest,
    contextsCursor: string | null,
    threadsCursor: string | null,
  ): string[] {
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${MERGE_READ_QUERY}`,
      '-f',
      `owner=${request.repository.owner}`,
      '-f',
      `repo=${request.repository.repo}`,
      '-F',
      `number=${request.pullRequestNumber}`,
    ];
    if (contextsCursor !== null) {
      args.push('-f', `contextsAfter=${contextsCursor}`);
    }
    if (threadsCursor !== null) {
      args.push('-f', `threadsAfter=${threadsCursor}`);
    }
    return args;
  }

  /**
   * One gh invocation raced against its remaining budget: a call that
   * settles after the deadline won must not become an unhandled rejection.
   * The caller maps the three outcomes onto its own result shapes.
   */
  private async runGhWithinTimeout(
    args: readonly string[],
    timeoutMs: number,
  ): Promise<
    | { kind: 'ok'; gh: GhInvocationResult }
    | { kind: 'timed-out' }
    | { kind: 'failed' }
  > {
    const runGh = this.runGh;
    if (runGh === undefined) {
      return { kind: 'failed' };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending = runGh(args);
      pending.catch(() => undefined);
      const gh = await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(GRAPHQL_TIMED_OUT)), timeoutMs);
        }),
      ]);
      return { kind: 'ok', gh };
    } catch (error) {
      if (error instanceof Error && error.message === GRAPHQL_TIMED_OUT) {
        return { kind: 'timed-out' };
      }
      return { kind: 'failed' };
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}
