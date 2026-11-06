// Implemented adapter — lane CO24 (PR-feedback fix round).
/**
 * PullRequestFindingsReadAdapter implements PullRequestFindingsReadPort
 * through the reviewed GitHub CLI subprocess: one read-only
 * `gh api graphql` query per page, allow-listed argv, no mutation, no
 * comment, no thread resolution. The delegate is injected; this adapter
 * never spawns a process and never reads a credential.
 *
 * The answer is complete or it is unavailable: the pull request must be open
 * and the forge head must equal the expected full head on every page, every page is followed by its cursor, the
 * nodes actually fetched are counted against `totalCount`, and any malformed
 * node makes the whole answer `unreadable` instead of a guess. Only
 * unresolved threads are returned. Every call is raced against the budget
 * rule (a call with under 2 s left is not started) and the work is bounded
 * in pages, threads, stdout bytes and body bytes. Details are fixed phrases;
 * forge output and stderr never reach a result.
 */

import type {
  PullRequestAuthorKind,
  PullRequestFinding,
  PullRequestFindingsReadPort,
  PullRequestFindingsRequest,
  PullRequestFindingsResult,
  PullRequestFindingsUnavailableCode,
} from '../../application/ports/out/PullRequestFindingsReadPort.out-port.js';
import type { GhInvocationResult } from './ForgeActionAdapter.adapter.js';

export interface PullRequestFindingsRepositoryRef {
  readonly owner: string;
  readonly repo: string;
}

export interface PullRequestFindingsReadAdapterOptions {
  /** Host-side delegate; the composition root binds the reviewed read-only subprocess. */
  readonly runGh?: (args: readonly string[], timeoutMs?: number) => Promise<GhInvocationResult>;
  /** Used only when the request carries no repository object. */
  readonly repository?: PullRequestFindingsRepositoryRef;
  /** Test hook: wall clock (epoch ms) for the budget rule; default Date.now. */
  readonly now?: () => number;
  /** Normal timeout for one graphql call; default 30 000. */
  readonly timeoutMs?: number;
}

const GRAPHQL_TIMEOUT_MS = 30_000;
const MIN_REMAINING_TO_START_MS = 2_000;
const GRAPHQL_TIMED_OUT = 'gh api graphql timed out';
const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const MAX_THREADS = 5_000;
const MAX_STDOUT_BYTES = 1_048_576;
const MAX_BODY_BYTES = 4_096;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+$/;
const FULL_COMMIT_PATTERN = /^[0-9a-f]{40}$/;

const FINDINGS_QUERY = `
  query PullRequestFindings($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        state
        headRefOid
        reviewThreads(first: ${PAGE_SIZE}, after: $after) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            isResolved
            path
            line
            comments(first: 1) {
              nodes { body author { __typename } }
            }
          }
        }
      }
    }
  }
`;

type Unavailable = Extract<PullRequestFindingsResult, { outcome: 'unavailable' }>;

function unavailable(code: PullRequestFindingsUnavailableCode, detail?: string): Unavailable {
  return detail === undefined
    ? { outcome: 'unavailable', code }
    : { outcome: 'unavailable', code, detail };
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
  readonly expectedHeadSha: string;
  readonly deadlineMs: number | null;
}

function validateRequest(
  request: PullRequestFindingsRequest,
  fallback: PullRequestFindingsRepositoryRef | undefined,
): ValidRequest | Unavailable {
  const invalid = unavailable('unreadable', 'request is not valid');
  const requested = ownData(request, 'repository');
  const repository = typeof requested === 'object' && requested !== null ? requested : fallback;
  const owner = ownData(repository, 'owner');
  const repo = ownData(repository, 'repo');
  if (
    typeof owner !== 'string' ||
    typeof repo !== 'string' ||
    !REPOSITORY_PATTERN.test(owner) ||
    !REPOSITORY_PATTERN.test(repo)
  ) {
    return invalid;
  }
  const number = ownData(request, 'pullRequestNumber');
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) {
    return invalid;
  }
  const expectedHeadSha = ownData(request, 'expectedHeadSha');
  if (typeof expectedHeadSha !== 'string' || !FULL_COMMIT_PATTERN.test(expectedHeadSha)) {
    return invalid;
  }
  const deadline = ownData(request, 'deadlineIso');
  if (deadline === undefined) {
    return { owner, repo, number, expectedHeadSha, deadlineMs: null };
  }
  const deadlineMs = typeof deadline === 'string' ? Date.parse(deadline) : Number.NaN;
  if (!Number.isFinite(deadlineMs)) {
    return unavailable('forge-error', 'deadline');
  }
  return { owner, repo, number, expectedHeadSha, deadlineMs };
}

interface Page {
  readonly open: boolean;
  readonly headRefOid: string;
  readonly totalCount: number;
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
  readonly nodes: readonly unknown[];
}

function parsePage(stdout: string): Page | Unavailable {
  const unreadable = unavailable('unreadable', 'answer is not readable');
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return unreadable;
  }
  if (!isRecord(parsed) || (Array.isArray(parsed.errors) && parsed.errors.length > 0)) {
    return unreadable;
  }
  const data = parsed.data;
  const repository = isRecord(data) ? data.repository : undefined;
  const pullRequest = isRecord(repository) ? repository.pullRequest : undefined;
  if (!isRecord(pullRequest)) {
    return unreadable;
  }
  const state = pullRequest.state;
  if (state !== 'OPEN' && state !== 'CLOSED' && state !== 'MERGED') {
    return unreadable;
  }
  const headRefOid = pullRequest.headRefOid;
  if (typeof headRefOid !== 'string' || !FULL_COMMIT_PATTERN.test(headRefOid)) {
    return unreadable;
  }
  const threads = pullRequest.reviewThreads;
  if (!isRecord(threads)) {
    return unreadable;
  }
  const totalCount = threads.totalCount;
  if (typeof totalCount !== 'number' || !Number.isSafeInteger(totalCount) || totalCount < 0) {
    return unreadable;
  }
  const pageInfo = threads.pageInfo;
  if (!isRecord(pageInfo) || typeof pageInfo.hasNextPage !== 'boolean') {
    return unreadable;
  }
  const rawCursor = pageInfo.endCursor;
  if (rawCursor !== null && rawCursor !== undefined && typeof rawCursor !== 'string') {
    return unreadable;
  }
  const endCursor = typeof rawCursor === 'string' && rawCursor.trim().length > 0 ? rawCursor : null;
  if (!Array.isArray(threads.nodes)) {
    return unreadable;
  }
  return {
    open: state === 'OPEN',
    headRefOid,
    totalCount,
    hasNextPage: pageInfo.hasNextPage,
    endCursor,
    nodes: threads.nodes,
  };
}

function authorKindOf(typename: unknown): PullRequestAuthorKind | null {
  if (typename === 'User') {
    return 'user';
  }
  if (typename === 'Bot') {
    return 'bot';
  }
  return null;
}

/** The thread id and whether it is resolved, or null for a malformed node. */
function identifyNode(node: unknown): { id: string; resolved: boolean; record: Record<string, unknown> } | null {
  if (!isRecord(node)) {
    return null;
  }
  const id = node.id;
  const resolved = node.isResolved;
  if (typeof id !== 'string' || id.length === 0 || typeof resolved !== 'boolean') {
    return null;
  }
  return { id, resolved, record: node };
}

/**
 * One thread as a finding, `too-large` for an oversized unresolved body, or
 * null when malformed. A resolved thread's body is never returned, so its
 * size is not bounded here.
 */
function toFinding(id: string, node: Record<string, unknown>, resolved: boolean): PullRequestFinding | 'too-large' | null {
  const path = node.path;
  const line = node.line;
  if (typeof path !== 'string') {
    return null;
  }
  if (line !== null && (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 0)) {
    return null;
  }
  const comments = node.comments;
  const first = isRecord(comments) && Array.isArray(comments.nodes) ? comments.nodes[0] : undefined;
  if (!isRecord(first) || typeof first.body !== 'string' || !isRecord(first.author)) {
    return null;
  }
  const authorKind = authorKindOf(first.author.__typename);
  if (authorKind === null) {
    return null;
  }
  if (resolved) {
    return { threadId: id, path, line, authorKind, state: 'resolved', text: '' };
  }
  if (Buffer.byteLength(first.body, 'utf8') > MAX_BODY_BYTES) {
    return 'too-large';
  }
  return { threadId: id, path, line, authorKind, state: 'unresolved', text: first.body };
}

export class PullRequestFindingsReadAdapter implements PullRequestFindingsReadPort {
  private readonly runGh?: (args: readonly string[], timeoutMs?: number) => Promise<GhInvocationResult>;
  private readonly repository?: PullRequestFindingsRepositoryRef;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(options: PullRequestFindingsReadAdapterOptions = {}) {
    this.runGh = options.runGh;
    this.repository = options.repository;
    this.now = options.now ?? (() => Date.now());
    this.timeoutMs = options.timeoutMs ?? GRAPHQL_TIMEOUT_MS;
  }

  isConfigured(): boolean {
    return this.runGh !== undefined;
  }

  async readPullRequestFindings(request: PullRequestFindingsRequest): Promise<PullRequestFindingsResult> {
    try {
      return await this.read(request);
    } catch {
      return unavailable('forge-error', 'read failed');
    }
  }

  private async read(request: PullRequestFindingsRequest): Promise<PullRequestFindingsResult> {
    if (this.runGh === undefined) {
      return unavailable('unconfigured');
    }
    const valid = validateRequest(request, this.repository);
    if ('outcome' in valid) {
      return valid;
    }

    const findings: PullRequestFinding[] = [];
    const seen = new Set<string>();
    let fetched = 0;
    let cursor: string | null = null;
    let firstTotal: number | null = null;
    let headSha: string | null = null;

    for (let pageNumber = 1; ; pageNumber += 1) {
      if (pageNumber > MAX_PAGES) {
        return unavailable('too-large', 'too many pages');
      }
      const timeoutMs = this.callBudget(valid.deadlineMs);
      if (timeoutMs === null) {
        return unavailable('forge-error', 'deadline');
      }
      const raced = await this.runWithinTimeout(this.graphqlArgs(valid, cursor), timeoutMs);
      if (raced.kind === 'timed-out') {
        return unavailable('forge-error', 'timeout');
      }
      if (raced.kind === 'failed') {
        return unavailable('forge-error', 'call failed');
      }
      const gh = raced.gh;
      if (!isRecord(gh) || typeof gh.exitCode !== 'number' || typeof gh.stdout !== 'string') {
        return unavailable('unreadable', 'answer is not readable');
      }
      if (gh.exitCode !== 0) {
        return unavailable('forge-error', `exit ${gh.exitCode}`);
      }
      if (gh.stdout.trim() === '') {
        return unavailable('forge-error', 'no output');
      }
      if (Buffer.byteLength(gh.stdout, 'utf8') > MAX_STDOUT_BYTES) {
        return unavailable('too-large', 'page output too large');
      }
      const page = parsePage(gh.stdout);
      if ('outcome' in page) {
        return page;
      }
      if (!page.open) {
        return unavailable('not-open');
      }
      if (page.headRefOid !== valid.expectedHeadSha || (headSha !== null && page.headRefOid !== headSha)) {
        return unavailable('head-moved');
      }
      headSha = page.headRefOid;
      if (firstTotal === null) {
        firstTotal = page.totalCount;
        if (firstTotal > MAX_THREADS) {
          return unavailable('too-large', 'too many threads');
        }
      } else if (page.totalCount !== firstTotal) {
        return unavailable('partial-page', 'thread count changed between pages');
      }

      for (const raw of page.nodes) {
        const node = identifyNode(raw);
        if (node === null) {
          return unavailable('unreadable', 'a thread is malformed');
        }
        if (seen.has(node.id)) {
          return unavailable('partial-page', 'a thread repeated between pages');
        }
        seen.add(node.id);
        fetched += 1;
        if (fetched > MAX_THREADS) {
          return unavailable('too-large', 'too many threads');
        }
        // A resolved thread is validated like an unresolved one (an unknown
        // or missing author makes the whole answer unreadable), then dropped.
        const finding = toFinding(node.id, node.record, node.resolved);
        if (finding === null) {
          return unavailable('unreadable', 'a thread is malformed');
        }
        if (finding === 'too-large') {
          return unavailable('too-large', 'a thread body is too large');
        }
        if (!node.resolved) {
          findings.push(finding);
        }
      }

      if (!page.hasNextPage) {
        break;
      }
      if (page.endCursor === null || page.endCursor === cursor || page.nodes.length === 0) {
        return unavailable('partial-page', 'the next page cannot be reached');
      }
      cursor = page.endCursor;
    }

    if (fetched !== firstTotal || headSha === null) {
      return unavailable('partial-page', 'fewer threads were read than the forge reports');
    }
    return { outcome: 'available', headSha, findings };
  }

  /**
   * Budget rule: a call is started only while at least 2 s remain to the
   * deadline, and is raced against min(timeout, time to the deadline).
   * Without a deadline only the per-call timeout applies.
   */
  private callBudget(deadlineMs: number | null): number | null {
    if (deadlineMs === null) {
      return this.timeoutMs;
    }
    const remaining = Math.max(0, deadlineMs - this.now());
    if (remaining < MIN_REMAINING_TO_START_MS) {
      return null;
    }
    return Math.min(this.timeoutMs, remaining);
  }

  private graphqlArgs(request: ValidRequest, cursor: string | null): readonly string[] {
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${FINDINGS_QUERY}`,
      '-f',
      `owner=${request.owner}`,
      '-f',
      `name=${request.repo}`,
      '-F',
      `number=${request.number}`,
    ];
    if (cursor !== null) {
      args.push('-f', `after=${cursor}`);
    }
    return args;
  }

  /** One gh call raced against its budget; a late settle never becomes an unhandled rejection. */
  private async runWithinTimeout(
    args: readonly string[],
    timeoutMs: number,
  ): Promise<{ kind: 'ok'; gh: GhInvocationResult } | { kind: 'timed-out' } | { kind: 'failed' }> {
    const runGh = this.runGh;
    if (runGh === undefined) {
      return { kind: 'failed' };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending = runGh(args, timeoutMs);
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
