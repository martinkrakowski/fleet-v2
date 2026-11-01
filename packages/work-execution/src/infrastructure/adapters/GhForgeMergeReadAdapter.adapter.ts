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
  MergeContextSnapshot,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Navigate a GraphQL page answer to the pullRequest object, or `undefined` when unusable. */
function readPullRequest(stdout: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
    return undefined;
  }
  if (!isRecord(parsed.data)) {
    return undefined;
  }
  if (!isRecord(parsed.data.repository)) {
    return undefined;
  }
  const pullRequest = parsed.data.repository.pullRequest;
  if (!isRecord(pullRequest)) {
    return undefined;
  }
  return pullRequest;
}

interface PageInfo {
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

function parsePageInfo(value: unknown): PageInfo | null {
  if (!isRecord(value)) {
    return null;
  }
  const hasNextPage = value.hasNextPage;
  if (typeof hasNextPage !== 'boolean') {
    return null;
  }
  const endCursor = value.endCursor;
  if (endCursor !== null && endCursor !== undefined && typeof endCursor !== 'string') {
    return null;
  }
  const cursor = typeof endCursor === 'string' && endCursor.trim().length > 0 ? endCursor : null;
  return { hasNextPage, endCursor: cursor };
}

function extractCreatorLogin(creator: unknown): string | null | undefined {
  if (creator === null || creator === undefined) {
    return null;
  }
  if (!isRecord(creator)) {
    return undefined;
  }
  const login = creator.login;
  if (login === null || login === undefined) {
    return null;
  }
  return typeof login === 'string' ? login : undefined;
}

function normalizeContextNode(node: unknown): MergeContextNode | null {
  if (!isRecord(node)) {
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
  const creatorLogin = extractCreatorLogin(creator);
  if (creatorLogin === undefined) {
    return null;
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
  if (rollup !== null && !isRecord(rollup)) {
    return { kind: 'unreadable' };
  }
  const contexts = rollup === null ? null : (rollup as Record<string, unknown>).contexts;
  if (contexts === null) {
    return { kind: 'page', nodes: [], hasNextPage: false, endCursor: null };
  }
  if (!isRecord(contexts)) {
    return { kind: 'unreadable' };
  }
  const pageInfo = parsePageInfo((contexts as Record<string, unknown>).pageInfo);
  if (pageInfo === null) {
    return { kind: 'unreadable' };
  }
  if (pageInfo.hasNextPage && pageInfo.endCursor === null) {
    return { kind: 'unknown', reason: 'pageInfo hasNextPage is true but endCursor is null' };
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
  if (!isRecord(threads)) {
    return { kind: 'unreadable' };
  }
  const pageInfo = parsePageInfo((threads as Record<string, unknown>).pageInfo);
  if (pageInfo === null) {
    return { kind: 'unreadable' };
  }
  if (pageInfo.hasNextPage && pageInfo.endCursor === null) {
    return { kind: 'unknown', reason: 'pageInfo hasNextPage is true but endCursor is null' };
  }
  const rawNodes = (threads as Record<string, unknown>).nodes;
  if (!Array.isArray(rawNodes)) {
    return { kind: 'unreadable' };
  }
  let unresolved = 0;
  for (const raw of rawNodes) {
    if (!isRecord(raw)) {
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

interface ContextsPaginationState {
  hasNext: boolean;
  cursor: string | null;
}

interface ThreadsPaginationState {
  unresolved: number;
  hasNext: boolean;
  cursor: string | null;
  unknown: boolean;
}

function applyContextsPage(
  state: ContextsPaginationState,
  contextsByName: Map<string, MergeContextNode>,
  page: MergeContextsPageResult & { kind: 'page' },
): void {
  if (!state.hasNext) {
    return;
  }
  for (const node of page.nodes) {
    contextsByName.set(node.name, node);
  }
  state.hasNext = page.hasNextPage;
  state.cursor = page.hasNextPage ? page.endCursor : null;
}

function applyThreadsPage(
  state: ThreadsPaginationState,
  page: MergeThreadsPageResult,
): void {
  if (!state.hasNext) {
    return;
  }
  if (page.kind !== 'page') {
    state.unknown = true;
    state.hasNext = false;
    state.cursor = null;
    return;
  }
  state.unresolved += page.unresolved;
  state.hasNext = page.hasNextPage;
  state.cursor = page.hasNextPage ? page.endCursor : null;
}

function buildContextSnapshots(
  requiredContexts: readonly string[],
  contextsByName: ReadonlyMap<string, MergeContextNode>,
  posterLogin?: string,
): MergeContextSnapshot[] {
  return requiredContexts.map((name) => {
    const node = contextsByName.get(name);
    if (node === undefined) {
      return { name, state: 'missing', isGreen: false, creatorLogin: null };
    }
    const isGreen =
      node.state === 'SUCCESS' &&
      (name !== 'premerge' || (node.creatorLogin !== null && node.creatorLogin === posterLogin));
    return { name, state: node.state, isGreen, creatorLogin: node.creatorLogin };
  });
}

type RunPageResult =
  | {
      kind: 'page';
      meta: MergePrMetaPayload;
      contexts: MergeContextsPageResult & { kind: 'page' };
      threads: MergeThreadsPageResult;
    }
  | { kind: 'not-found' }
  | { kind: 'unavailable'; code: 'forge-error' | 'unreadable' | 'unknown'; reason: string };

function mapFetchFailure(fetched: Exclude<RunPageResult, { kind: 'page' }>): ReadForgeMergeResult {
  if (fetched.kind === 'not-found') {
    return { outcome: 'not-found' };
  }
  return { outcome: 'unavailable', code: fetched.code, reason: fetched.reason };
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

  private checkBudget(
    deadlineIso: string,
  ): { ok: true; timerMs: number } | { ok: false; result: ReadForgeMergeResult } {
    const budget = this.budget(deadlineIso);
    if (budget === null) {
      return {
        ok: false,
        result: { outcome: 'unavailable', code: 'unknown', reason: 'deadline is not a valid ISO time' },
      };
    }
    if (budget.remainingToDeadline < BUDGET_MIN_REMAINING_MS) {
      return { ok: false, result: { outcome: 'budget-exhausted' } };
    }
    return { ok: true, timerMs: budget.timerMs };
  }

  async readForgeMerge(request: ReadForgeMergeRequest): Promise<ReadForgeMergeResult> {
    const guardReason = guardRequest(request, this.runGh);
    if (guardReason !== null) {
      return { outcome: 'unavailable', code: 'forge-error', reason: guardReason };
    }

    const contextsByName = new Map<string, MergeContextNode>();
    const contexts: ContextsPaginationState = { hasNext: true, cursor: null };
    const threads: ThreadsPaginationState = { unresolved: 0, hasNext: true, cursor: null, unknown: false };
    let meta: MergePrMetaPayload | null = null;

    while (contexts.hasNext || threads.hasNext) {
      const budgetCheck = this.checkBudget(request.deadlineIso);
      if (!budgetCheck.ok) {
        return budgetCheck.result;
      }
      const fetched = await this.runPage(request, contexts.cursor, threads.cursor, budgetCheck.timerMs);
      if (fetched.kind !== 'page') {
        return mapFetchFailure(fetched);
      }
      if (meta !== null && fetched.meta.liveHeadSha !== meta.liveHeadSha) {
        return { outcome: 'unavailable', code: 'unknown', reason: 'the head oid changed between pages' };
      }
      meta = fetched.meta;
      applyContextsPage(contexts, contextsByName, fetched.contexts);
      applyThreadsPage(threads, fetched.threads);
    }

    if (meta === null) {
      return { outcome: 'unavailable', code: 'unknown', reason: 'no forge page was read' };
    }

    const resolvedContexts = buildContextSnapshots(request.requiredContexts, contextsByName, request.posterLogin);

    return {
      outcome: 'ok',
      prState: meta.prState,
      liveHeadSha: meta.liveHeadSha,
      mergeState: meta.mergeState,
      contexts: resolvedContexts,
      unresolvedThreads: threads.unknown ? 'unknown' : threads.unresolved,
    };
  }

  private async runPage(
    request: ReadForgeMergeRequest,
    contextsCursor: string | null,
    threadsCursor: string | null,
    remaining: number,
  ): Promise<RunPageResult> {
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
    if (contextsCursor !== null && contextsCursor.trim().length > 0) {
      args.push('-f', `contextsAfter=${contextsCursor}`);
    }
    if (threadsCursor !== null && threadsCursor.trim().length > 0) {
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
