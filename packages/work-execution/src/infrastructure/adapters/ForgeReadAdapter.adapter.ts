// @generated adapter scaffold — implemented for lane AM4b-2.
/**
 * ForgeReadAdapter implements ForgeReadPort through the reviewed GitHub CLI
 * subprocess: one read-only `gh pr view` per call, by number or head branch,
 * with an optional per-call repository. Anything that cannot be read or
 * verified is unavailable, never a guess and never absence. Auto-merge A13
 * and the conductor's reconcile read it; the work board (WB5c) adds the list
 * read to this same port.
 */

import type {
  ForgeReadPort,
  ListOpenPullRequestsByBaseRequest,
  ListOpenPullRequestsByBaseResult,
  OpenPullRequestSummary,
  PullRequestCiCost,
  PullRequestCiCostUnavailableReason,
  PullRequestRef,
  PullRequestSnapshot,
  ReadPullRequestCiCostRequest,
  ReadPullRequestCiCostResult,
  ReadPullRequestRequest,
  ReadPullRequestResult,
  WorkflowCiCost,
} from '../../application/ports/out/ForgeReadPort.out-port.js';
import type { ContainsCommitRequest, ContainsCommitResult } from '../../application/ports/out/ForgeAncestryPort.out-port.js';
import type { ForgeAncestryPort } from '../../application/ports/out/ForgeAncestryPort.out-port.js';
import { parseBaseBranch } from '../../domain/base-branch.js';
import type { GhInvocationResult } from './ForgeActionAdapter.adapter.js';
import { isSafeBranchName } from './ForgeActionAdapter.adapter.js';
import { LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';

export interface ForgeReadAdapterOptions {
  readonly owner?: string;
  readonly repo?: string;
  readonly runGh?: (args: readonly string[], timeoutMs?: number) => Promise<GhInvocationResult>;
  /** Test hook: overrides the read deadline (READ_TIMEOUT_MS). */
  readonly timeoutMs?: number;
}

/** Always ask for state and head: `--json number` alone is answered without the forge. */
export const PULL_REQUEST_VIEW_FIELDS =
  'number,state,headRefOid,headRefName,baseRefName,mergedAt,closedAt,mergeCommit,mergeStateStatus';

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+$/;
const HEX_40 = /^[0-9a-f]{40}$/;
const ALL_DIGITS = /^\d+$/;

/** Deadline for one `gh pr view`; a read that outlives it is unavailable. */
const READ_TIMEOUT_MS = 30_000;
/** Stdout above one mebibyte is not parsed; it is unavailable. */
const READ_MAX_STDOUT_BYTES = 1_048_576;

/** Marker error for the losing read deadline inside the race. */
const READ_TIMED_OUT = 'gh pr view timed out';

const UNAVAILABLE_UNREADABLE: ReadPullRequestResult = {
  outcome: 'unavailable',
  reason: 'gh pr view returned an unreadable pull request',
};

const UNAVAILABLE_DIFFERENT: ReadPullRequestResult = {
  outcome: 'unavailable',
  reason: 'gh pr view answered for a different pull request',
};

const UNAVAILABLE_UNREADABLE_COMPARE: ContainsCommitResult = {
  outcome: 'unavailable',
  reason: 'gh api compare returned an unreadable answer',
};

function isValidRepository(repository: { readonly owner?: unknown; readonly repo?: unknown }): boolean {
  return (
    typeof repository.owner === 'string' &&
    typeof repository.repo === 'string' &&
    REPOSITORY_PATTERN.test(repository.owner) &&
    REPOSITORY_PATTERN.test(repository.repo)
  );
}

function parseSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function parseState(value: unknown): PullRequestSnapshot['state'] | null {
  if (value === 'OPEN') return 'open';
  if (value === 'MERGED') return 'merged';
  if (value === 'CLOSED') return 'closed';
  return null;
}

/** CLEAN → clean, BEHIND → behind, BLOCKED/DIRTY/UNSTABLE → blocked, anything else or absent → unknown. */
export function parseMergeStateStatus(value: unknown): PullRequestSnapshot['mergeState'] {
  if (value === 'CLEAN') return 'clean';
  if (value === 'BEHIND') return 'behind';
  if (value === 'BLOCKED' || value === 'DIRTY' || value === 'UNSTABLE') return 'blocked';
  return 'unknown';
}

function parseHex40(value: unknown): string | null {
  return typeof value === 'string' && HEX_40.test(value) ? value : null;
}

function parseNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Returns `undefined` when invalid, `null` for an absent timestamp. */
function parseTimestamp(value: unknown): string | null | undefined {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  if (Number.isNaN(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

/** Returns `undefined` when invalid, `null` when no merge commit. */
function parseMergeCommit(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const oid = (value as Record<string, unknown>).oid;
  return typeof oid === 'string' && HEX_40.test(oid) ? oid : undefined;
}

/** Pure parse of one `gh pr view --json PULL_REQUEST_VIEW_FIELDS` stdout, checked against the ref. */
export function parsePullRequestView(stdout: string, ref: PullRequestRef): ReadPullRequestResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return UNAVAILABLE_UNREADABLE;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return UNAVAILABLE_UNREADABLE;
  }
  const record = parsed as Record<string, unknown>;
  const number = parseSafeInteger(record.number);
  const state = parseState(record.state);
  const headSha = parseHex40(record.headRefOid);
  const headRef = parseNonEmptyString(record.headRefName);
  const baseRef = parseNonEmptyString(record.baseRefName);
  const mergedAtIso = parseTimestamp(record.mergedAt);
  const closedAtIso = parseTimestamp(record.closedAt);
  const mergeCommitSha = parseMergeCommit(record.mergeCommit);
  const mergeState = parseMergeStateStatus(record.mergeStateStatus);
  if (
    number === null ||
    state === null ||
    headSha === null ||
    headRef === null ||
    baseRef === null ||
    mergedAtIso === undefined ||
    closedAtIso === undefined ||
    mergeCommitSha === undefined
  ) {
    return UNAVAILABLE_UNREADABLE;
  }
  if ((state === 'merged') !== (mergedAtIso !== null)) {
    return UNAVAILABLE_UNREADABLE;
  }
  if (ref.kind === 'number' && ref.number !== number) {
    return UNAVAILABLE_DIFFERENT;
  }
  if (ref.kind === 'branch' && ref.branchName !== headRef) {
    return UNAVAILABLE_DIFFERENT;
  }
  const pullRequest: PullRequestSnapshot = {
    number,
    state,
    mergeState,
    headSha,
    headRef,
    baseRef,
    mergedAtIso,
    closedAtIso,
    mergeCommitSha,
  };
  return { outcome: 'found', pullRequest };
}

/**
 * Pure parse of one `gh api repos/<owner>/<repo>/compare/<base>...<head>`
 * stdout (CT-2b): `identical` or `ahead` means the head contains the base;
 * `behind` or `diverged` means it does not; anything else (unparsable,
 * missing or an unknown status) is unavailable, never a guess.
 */
export function parseCompareStatus(stdout: string): ContainsCommitResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return UNAVAILABLE_UNREADABLE_COMPARE;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return UNAVAILABLE_UNREADABLE_COMPARE;
  }
  const status = (parsed as Record<string, unknown>).status;
  if (status === 'identical' || status === 'ahead') {
    return { outcome: 'answered', contains: true };
  }
  if (status === 'behind' || status === 'diverged') {
    return { outcome: 'answered', contains: false };
  }
  return UNAVAILABLE_UNREADABLE_COMPARE;
}

/**
 * The jq program that reduces every page to one line per pull request with
 * only the three fields the port returns, so no title, body, author or label
 * ever reaches this process.
 */
export const OPEN_PULL_REQUESTS_JQ = '.[] | {number: .number, head: {sha: .head.sha}, base: {ref: .base.ref}}';

const UNAVAILABLE_UNREADABLE_LIST: ListOpenPullRequestsByBaseResult = {
  outcome: 'unavailable',
  reason: 'gh api pulls returned an unreadable answer',
};

/** One line of the open-pull-request listing; `null` when it is not exactly the requested shape. */
function parseOpenPullRequestLine(line: string, base: string): OpenPullRequestSummary | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const head = record.head;
  const baseRecord = record.base;
  const number = parseSafeInteger(record.number);
  const headSha =
    head !== null && typeof head === 'object' && !Array.isArray(head)
      ? parseHex40((head as Record<string, unknown>).sha)
      : null;
  const baseRef =
    baseRecord !== null && typeof baseRecord === 'object' && !Array.isArray(baseRecord)
      ? (baseRecord as Record<string, unknown>).ref
      : undefined;
  if (number === null || headSha === null || baseRef !== base) {
    return null;
  }
  return { number, headSha, baseRef: base };
}

/**
 * Pure parse of the `gh api --paginate --jq OPEN_PULL_REQUESTS_JQ` stdout: one
 * JSON object per line, from every page. Every line must be an object with an
 * integer `number`, a 40-hex `head.sha` and exactly the requested `base.ref`;
 * one line that is not (a partial page, another base, anything else) makes the
 * whole answer unavailable, never a shorter list. Empty stdout is the forge's
 * answer of no open pull request; a failed or cut-short call never reaches here
 * because its exit code is not zero.
 */
export function parseOpenPullRequests(stdout: string, base: string): ListOpenPullRequestsByBaseResult {
  const seen = new Set<number>();
  const pullRequests: OpenPullRequestSummary[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    const summary = parseOpenPullRequestLine(line, base);
    if (summary === null) {
      return UNAVAILABLE_UNREADABLE_LIST;
    }
    if (!seen.has(summary.number)) {
      seen.add(summary.number);
      pullRequests.push(summary);
    }
  }
  return { outcome: 'listed', pullRequests };
}

// --- CO20: read-only merged-PR CI cost --------------------------------------

/** Pagination pages above this are never read again: the answer stays partial. */
export const MAX_CI_COST_PAGES = 20;
/** Distinct workflows above this make the whole answer too large. */
export const MAX_CI_COST_WORKFLOWS = 256;
/** A workflow name outside 1..128 characters is unreadable, never truncated. */
export const WORKFLOW_NAME_MAX_LENGTH = 128;

/** The GraphQL query: one page of a merged pull request's last commit's check suites. */
export const PULL_REQUEST_CI_COST_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number
      state
      headRefOid
      commits(last: 1) {
        nodes {
          commit {
            oid
            checkSuites(first: 100, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes {
                workflowRun { workflow { name } }
                checkRuns(first: 100) {
                  pageInfo { hasNextPage }
                  nodes { status startedAt completedAt }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;
const PATH_SHAPED = /[/\\]/;

/**
 * True when a workflow name is a plain, bounded identifier: no control
 * character, no path separator, not `.` or `..`, and never secret-shaped
 * (the name is echoed into the use case's counts, so the check is fail-closed).
 */
export function isSafeWorkflowName(value: string): boolean {
  if (value.length === 0 || value.length > WORKFLOW_NAME_MAX_LENGTH) {
    return false;
  }
  if (CONTROL_CHARACTER.test(value) || PATH_SHAPED.test(value) || value === '.' || value === '..') {
    return false;
  }
  return !LANE_DIFF_SECRET_PATTERNS.some((entry) => entry.regex.test(value));
}

/**
 * The parsed contribution of one check suite: its workflow name and the
 * billed minutes of its completed check runs; `null` for a non-Actions
 * (external) suite that carries no workflow run.
 */
export interface ParsedCheckSuite {
  readonly workflowName: string | null;
  readonly checkRuns: number;
  readonly billedMinutes: number;
}

/** The pure parse of one GraphQL page of the merged-PR CI-cost read. */
export type PullRequestCiCostPageParse =
  | {
      readonly kind: 'page';
      readonly headSha: string;
      readonly suites: readonly ParsedCheckSuite[];
      readonly hasMore: boolean;
      readonly endCursor: string | null;
    }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'fail'; readonly reason: PullRequestCiCostUnavailableReason };

function isPlainArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value) && !(value as unknown[]).some((_, index) => !(index in (value as unknown[])));
}

function objectAt(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isoMsOf(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0 || Number.isNaN(Date.parse(value))) {
    return null;
  }
  return Date.parse(value);
}

/**
 * The pure parse of one page: every field is verified, a present non-empty
 * `errors` array is unreadable, a missing pull request is known absence only
 * on page 1 (later pages are partial), and the state must be MERGED for a
 * pull request numbered exactly as asked with one head commit whose oid
 * matches the head and carries sparse-free check suites. A truncated check
 * run list or an incomplete check run is partial; an unmerged pull request
 * is named; nothing is guessed and nothing is echoed but ids and codes.
 */
export function parsePullRequestCiCostPage(
  stdout: unknown,
  pullRequestNumber: number,
  pageIndex: number,
  expectedHeadSha: string | null,
): PullRequestCiCostPageParse {
  let parsed: unknown;
  try {
    parsed = typeof stdout === 'string' ? JSON.parse(stdout) : stdout;
  } catch {
    return { kind: 'fail', reason: 'unreadable-ci-cost' };
  }
  const root = objectAt(parsed);
  if (root === null) {
    return { kind: 'fail', reason: 'unreadable-ci-cost' };
  }
  const errors = root.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return { kind: 'fail', reason: 'unreadable-ci-cost' };
  }
  const data = objectAt(root.data);
  if (data === null) {
    return { kind: 'fail', reason: 'unreadable-ci-cost' };
  }
  const repository = objectAt(data.repository);
  if (repository === null) {
    return pageIndex === 0 ? { kind: 'not-found' } : { kind: 'fail', reason: 'partial-ci-cost' };
  }
  const pullRequest = objectAt(repository.pullRequest);
  if (pullRequest === null) {
    return pageIndex === 0 ? { kind: 'not-found' } : { kind: 'fail', reason: 'partial-ci-cost' };
  }
  const number = pullRequest.number;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number !== pullRequestNumber) {
    return { kind: 'fail', reason: 'different-pull-request' };
  }
  if (pullRequest.state !== 'MERGED') {
    return { kind: 'fail', reason: 'pull-request-not-merged' };
  }
  const headSha = pullRequest.headRefOid;
  if (typeof headSha !== 'string' || !HEX_40.test(headSha)) {
    return { kind: 'fail', reason: 'unreadable-ci-cost' };
  }
  if (expectedHeadSha !== null && headSha !== expectedHeadSha) {
    return { kind: 'fail', reason: 'partial-ci-cost' };
  }
  const commits = objectAt(pullRequest.commits);
  if (commits === null) {
    return { kind: 'fail', reason: 'unreadable-ci-cost' };
  }
  const nodes = commits.nodes;
  if (!isPlainArray(nodes) || nodes.length !== 1) {
    return { kind: 'fail', reason: 'unreadable-ci-cost' };
  }
  const commit = objectAt(objectAt(nodes[0])?.commit);
  if (commit === null || commit.oid !== headSha) {
    return { kind: 'fail', reason: 'unreadable-ci-cost' };
  }
  const checkSuites = objectAt(commit.checkSuites);
  if (checkSuites === null) {
    return { kind: 'fail', reason: 'unreadable-ci-cost' };
  }
  const suiteNodes = checkSuites.nodes;
  if (!isPlainArray(suiteNodes)) {
    return { kind: 'fail', reason: 'unreadable-ci-cost' };
  }
  const suites: ParsedCheckSuite[] = [];
  for (const suiteNode of suiteNodes) {
    const suite = objectAt(suiteNode);
    if (suite === null) {
      return { kind: 'fail', reason: 'unreadable-ci-cost' };
    }
    const workflowRun = suite.workflowRun;
    if (workflowRun === null) {
      // A non-Actions (external) check suite carries no workflow run.
      continue;
    }
    const run = objectAt(workflowRun);
    const name = run === null ? undefined : objectAt(run.workflow)?.name;
    if (typeof name !== 'string' || !isSafeWorkflowName(name)) {
      return { kind: 'fail', reason: 'unreadable-ci-cost' };
    }
    const checkRuns = objectAt(suite.checkRuns);
    if (checkRuns === null) {
      return { kind: 'fail', reason: 'unreadable-ci-cost' };
    }
    const checkRunsPageInfo = objectAt(checkRuns.pageInfo);
    if (checkRunsPageInfo?.hasNextPage === true) {
      return { kind: 'fail', reason: 'partial-ci-cost' };
    }
    const runNodes = checkRuns.nodes;
    if (!isPlainArray(runNodes)) {
      return { kind: 'fail', reason: 'unreadable-ci-cost' };
    }
    let checkRunCount = 0;
    let billedMinutes = 0;
    for (const runNode of runNodes) {
      const checkRun = objectAt(runNode);
      if (checkRun === null) {
        return { kind: 'fail', reason: 'unreadable-ci-cost' };
      }
      if (checkRun.status !== 'COMPLETED') {
        return { kind: 'fail', reason: 'partial-ci-cost' };
      }
      const startedMs = isoMsOf(checkRun.startedAt);
      const completedMs = isoMsOf(checkRun.completedAt);
      if (startedMs === null || completedMs === null || completedMs < startedMs) {
        return { kind: 'fail', reason: 'unreadable-ci-cost' };
      }
      const minutes = completedMs === startedMs ? 0 : Math.ceil((completedMs - startedMs) / 60_000);
      if (!Number.isSafeInteger(minutes) || minutes < 0) {
        return { kind: 'fail', reason: 'unreadable-ci-cost' };
      }
      checkRunCount += 1;
      const total = billedMinutes + minutes;
      if (!Number.isSafeInteger(total)) {
        return { kind: 'fail', reason: 'ci-cost-too-large' };
      }
      billedMinutes = total;
    }
    suites.push({ workflowName: name, checkRuns: checkRunCount, billedMinutes });
  }
  const pageInfo = objectAt(checkSuites.pageInfo);
  const hasMore = pageInfo?.hasNextPage === true;
  const endCursor = typeof pageInfo?.endCursor === 'string' && pageInfo.endCursor.length > 0 ? pageInfo.endCursor : null;  if (hasMore && endCursor === null) {
    return { kind: 'fail', reason: 'partial-ci-cost' };
  }
  return { kind: 'page', headSha, suites, hasMore, endCursor };
}

export class ForgeReadAdapter implements ForgeReadPort, ForgeAncestryPort {
  private readonly owner?: string;
  private readonly repo?: string;
  private readonly runGh?: (args: readonly string[], timeoutMs?: number) => Promise<GhInvocationResult>;
  private readonly timeoutMs: number;

  constructor(options: ForgeReadAdapterOptions = {}) {
    this.owner = options.owner;
    this.repo = options.repo;
    this.runGh = options.runGh;
    this.timeoutMs = options.timeoutMs ?? READ_TIMEOUT_MS;
  }

  isConfigured(): boolean {
    return (
      this.runGh !== undefined &&
      typeof this.owner === 'string' &&
      typeof this.repo === 'string' &&
      REPOSITORY_PATTERN.test(this.owner) &&
      REPOSITORY_PATTERN.test(this.repo)
    );
  }

  async readPullRequest(request: ReadPullRequestRequest): Promise<ReadPullRequestResult> {
    const runGh = this.runGh;
    if (runGh === undefined) {
      return { outcome: 'unavailable', reason: 'forge read is not configured' };
    }
    const repository = request.repository ?? { owner: this.owner, repo: this.repo };
    if (!isValidRepository(repository)) {
      return { outcome: 'unavailable', reason: 'forge repository is not configured or not valid' };
    }
    const ref = request.ref;
    if (ref.kind === 'number') {
      if (!Number.isSafeInteger(ref.number) || ref.number < 1) {
        return { outcome: 'unavailable', reason: 'pull request number is not valid' };
      }
    } else if (!isSafeBranchName(ref.branchName) || ALL_DIGITS.test(ref.branchName)) {
      return { outcome: 'unavailable', reason: 'branch name is not valid' };
    }
    const refArg = ref.kind === 'number' ? String(ref.number) : ref.branchName;
    const args = [
      'pr',
      'view',
      refArg,
      '-R',
      `${repository.owner}/${repository.repo}`,
      '--json',
      PULL_REQUEST_VIEW_FIELDS,
    ];
    const raced = await this.runGhWithinDeadline(args, request.timeoutMs);
    if (raced.kind === 'timed-out') {
      return { outcome: 'unavailable', reason: 'gh pr view timed out' };
    }
    if (raced.kind === 'failed') {
      return { outcome: 'unavailable', reason: 'gh pr view could not complete' };
    }
    const gh = raced.gh;
    if (gh.exitCode !== 0) {
      return this.unavailableExit(gh);
    }
    if (Buffer.byteLength(gh.stdout, 'utf8') > READ_MAX_STDOUT_BYTES) {
      return {
        outcome: 'unavailable',
        reason: 'gh pr view output too large',
      };
    }
    return parsePullRequestView(gh.stdout, ref);
  }

  async listOpenPullRequestsByBase(request: ListOpenPullRequestsByBaseRequest): Promise<ListOpenPullRequestsByBaseResult> {
    try {
      const base = parseBaseBranch(request.base);
      if (base === undefined) {
        return { outcome: 'unavailable', reason: 'invalid-request' };
      }
      if (this.runGh === undefined) {
        return { outcome: 'unavailable', reason: 'forge read is not configured' };
      }
      const repository = request.repository ?? { owner: this.owner, repo: this.repo };
      if (!isValidRepository(repository)) {
        return { outcome: 'unavailable', reason: 'forge repository is not configured or not valid' };
      }
      const args = [
        'api',
        '--paginate',
        `repos/${repository.owner}/${repository.repo}/pulls?state=open&base=${encodeURIComponent(base)}&per_page=100`,
        '--jq',
        OPEN_PULL_REQUESTS_JQ,
      ];
      const raced = await this.runGhWithinDeadline(args, request.timeoutMs);
      if (raced.kind === 'timed-out') {
        return { outcome: 'unavailable', reason: READ_TIMED_OUT };
      }
      if (raced.kind === 'failed') {
        return { outcome: 'unavailable', reason: 'gh api pulls could not complete' };
      }
      const gh = raced.gh;
      if (gh.exitCode !== 0) {
        return { outcome: 'unavailable', reason: `gh api pulls failed (exit ${gh.exitCode})` };
      }
      if (typeof gh.stdout !== 'string' || Buffer.byteLength(gh.stdout, 'utf8') > READ_MAX_STDOUT_BYTES) {
        return { outcome: 'unavailable', reason: 'gh api pulls output too large' };
      }
      return parseOpenPullRequests(gh.stdout, base);
    } catch {
      return { outcome: 'unavailable', reason: 'gh api pulls could not complete' };
    }
  }

  /**
   * The read-only merged-PR CI-cost read (CO20): one fully paginated GraphQL
   * query per call, `-f` for every string variable and `-F` for the integer
   * number, never a mutating flag. Every page is bounded by the remaining
   * deadline; a malformed, truncated, oversized or unmerged answer is
   * unavailable or absence, never a zero count or an empty list, and no
   * stderr or path is ever echoed.
   */
  async readPullRequestCiCost(request: ReadPullRequestCiCostRequest): Promise<ReadPullRequestCiCostResult> {
    try {
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        return { outcome: 'unavailable', reason: 'invalid-request' };
      }
      const prototype = Object.getPrototypeOf(request);
      if (prototype !== Object.prototype && prototype !== null) {
        return { outcome: 'unavailable', reason: 'invalid-request' };
      }
      const pullRequestNumber = request.pullRequestNumber;
      if (typeof pullRequestNumber !== 'number' || !Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) {
        return { outcome: 'unavailable', reason: 'invalid-request' };
      }
      const timeoutMs = request.timeoutMs;
      if (timeoutMs !== undefined) {
        if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) {
          return { outcome: 'unavailable', reason: 'invalid-request' };
        }
        if (timeoutMs <= 0) {
          return { outcome: 'unavailable', reason: 'ci-cost-timed-out' };
        }
      }
      if (this.runGh === undefined) {
        return { outcome: 'unavailable', reason: 'forge-not-configured' };
      }
      const repository = request.repository ?? { owner: this.owner, repo: this.repo };
      if (!isValidRepository(repository)) {
        return { outcome: 'unavailable', reason: 'invalid-repository' };
      }
      const effectiveTimeoutMs = timeoutMs === undefined ? this.timeoutMs : Math.min(this.timeoutMs, timeoutMs);
      const deadlineMs = Date.now() + effectiveTimeoutMs;
      const perPageTotals = new Map<string, { checkRuns: number; billedMinutes: number }>();
      let headSha: string | null = null;
      let cursor: string | null = null;
      for (let pageIndex = 0; pageIndex < MAX_CI_COST_PAGES; pageIndex += 1) {
        const remainingMs = deadlineMs - Date.now();
        if (remainingMs <= 0) {
          return { outcome: 'unavailable', reason: 'ci-cost-timed-out' };
        }
        const args: string[] = [
          'api',
          'graphql',
          '-f',
          `query=${PULL_REQUEST_CI_COST_QUERY}`,
          '-f',
          `owner=${repository.owner}`,
          '-f',
          `repo=${repository.repo}`,
          '-F',
          `number=${String(pullRequestNumber)}`,
        ];
        if (cursor !== null) {
          args.push('-f', `after=${cursor}`);
        }
        const raced = await this.runGhWithinDeadline(args, remainingMs);
        if (raced.kind === 'timed-out') {
          return { outcome: 'unavailable', reason: 'ci-cost-timed-out' };
        }
        if (raced.kind === 'failed') {
          return { outcome: 'unavailable', reason: 'ci-cost-failed' };
        }
        const gh = raced.gh;
        if (gh.exitCode !== 0) {
          return { outcome: 'unavailable', reason: 'ci-cost-failed' };
        }
        if (typeof gh.stdout !== 'string' || Buffer.byteLength(gh.stdout, 'utf8') > READ_MAX_STDOUT_BYTES) {
          return { outcome: 'unavailable', reason: 'ci-cost-too-large' };
        }
        const page = parsePullRequestCiCostPage(gh.stdout, pullRequestNumber, pageIndex, headSha);
        if (page.kind === 'not-found') {
          return { outcome: 'not-found' };
        }
        if (page.kind === 'fail') {
          return { outcome: 'unavailable', reason: page.reason };
        }
        headSha = page.headSha;
        for (const suite of page.suites) {
          const workflowName = suite.workflowName;
          if (workflowName === null) {
            continue;
          }
          const known = perPageTotals.get(workflowName);
          const checkRuns = known === undefined ? suite.checkRuns : known.checkRuns + suite.checkRuns;
          const billedMinutes = known === undefined ? suite.billedMinutes : known.billedMinutes + suite.billedMinutes;
          if (!Number.isSafeInteger(checkRuns) || !Number.isSafeInteger(billedMinutes)) {
            return { outcome: 'unavailable', reason: 'ci-cost-too-large' };
          }
          perPageTotals.set(workflowName, { checkRuns, billedMinutes });
          if (perPageTotals.size > MAX_CI_COST_WORKFLOWS) {
            return { outcome: 'unavailable', reason: 'ci-cost-too-large' };
          }
        }
        if (!page.hasMore) {
          const workflows: WorkflowCiCost[] = [...perPageTotals.entries()]
            .map(([workflowName, totals]) => ({ workflowName, checkRuns: totals.checkRuns, billedMinutes: totals.billedMinutes }))
            .sort((a, b) => (a.workflowName < b.workflowName ? -1 : a.workflowName > b.workflowName ? 1 : 0));
          let totalCheckRuns = 0;
          let totalBilledMinutes = 0;
          for (const workflow of workflows) {
            totalCheckRuns += workflow.checkRuns;
            totalBilledMinutes += workflow.billedMinutes;
            if (!Number.isSafeInteger(totalCheckRuns) || !Number.isSafeInteger(totalBilledMinutes)) {
              return { outcome: 'unavailable', reason: 'ci-cost-too-large' };
            }
          }
          const cost: PullRequestCiCost = {
            pullRequestNumber,
            headSha,
            totalCheckRuns,
            totalBilledMinutes,
            workflows,
          };
          return { outcome: 'found', cost };
        }
        if (page.endCursor === null || pageIndex + 1 >= MAX_CI_COST_PAGES) {
          return { outcome: 'unavailable', reason: 'partial-ci-cost' };
        }
        cursor = page.endCursor;
      }
      return { outcome: 'unavailable', reason: 'partial-ci-cost' };
    } catch {
      return { outcome: 'unavailable', reason: 'invalid-request' };
    }
  }

  /**
   * One gh invocation raced against the read deadline: a read that settles
   * after the deadline won must not become an unhandled rejection. An
   * optional per-read cap bounds the call to `min(adapter normal timeout,
   * timeoutMs)` (the daemon merge path passes the remaining budget). The
   * caller maps the three outcomes onto its own reason strings.
   */
  private async runGhWithinDeadline(
    args: readonly string[],
    timeoutMs?: number,
  ): Promise<
    | { kind: 'ok'; gh: GhInvocationResult }
    | { kind: 'timed-out' }
    | { kind: 'failed' }
  > {
    const runGh = this.runGh;
    if (runGh === undefined) {
      return { kind: 'failed' };
    }
    const effectiveTimeoutMs =
      timeoutMs === undefined ? this.timeoutMs : Math.min(this.timeoutMs, timeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending = runGh(args, effectiveTimeoutMs);
      pending.catch(() => undefined);
      const gh = await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(READ_TIMED_OUT)), effectiveTimeoutMs);
        }),
      ]);
      return { kind: 'ok', gh };
    } catch (error) {
      if (error instanceof Error && error.message === READ_TIMED_OUT) {
        return { kind: 'timed-out' };
      }
      return { kind: 'failed' };
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  async containsCommit(request: ContainsCommitRequest): Promise<ContainsCommitResult> {
    const runGh = this.runGh;
    if (runGh === undefined) {
      return { outcome: 'unavailable', reason: 'forge read is not configured' };
    }
    const repository = request.repository ?? { owner: this.owner, repo: this.repo };
    if (!isValidRepository(repository)) {
      return { outcome: 'unavailable', reason: 'forge repository is not configured or not valid' };
    }
    if (!HEX_40.test(request.ancestorSha) || !HEX_40.test(request.descendantSha)) {
      return { outcome: 'unavailable', reason: 'commit sha is not valid' };
    }
    // Equal shas are the same commit: the descendant contains the ancestor.
    if (request.ancestorSha === request.descendantSha) {
      return { outcome: 'answered', contains: true };
    }
    // Only the status is read: the full compare answer carries every file's
    // patch since the merge base, which can exceed the stdout cap on a busy
    // merge train and would leave the run parked for no reason.
    const args = [
      'api',
      `repos/${repository.owner}/${repository.repo}/compare/${request.ancestorSha}...${request.descendantSha}`,
      '--jq',
      '{status: .status}',
    ];
    const raced = await this.runGhWithinDeadline(args);
    if (raced.kind === 'timed-out') {
      return { outcome: 'unavailable', reason: 'gh api compare timed out' };
    }
    if (raced.kind === 'failed') {
      return { outcome: 'unavailable', reason: 'gh api compare could not complete' };
    }
    const gh = raced.gh;
    if (gh.exitCode !== 0) {
      return { outcome: 'unavailable', reason: `gh api compare failed (exit ${gh.exitCode})` };
    }
    if (Buffer.byteLength(gh.stdout, 'utf8') > READ_MAX_STDOUT_BYTES) {
      return { outcome: 'unavailable', reason: 'gh api compare output too large' };
    }
    return parseCompareStatus(gh.stdout);
  }

  private unavailableExit(gh: GhInvocationResult): ReadPullRequestResult {
    const text = `${gh.stderr}\n${gh.stdout}`.toLowerCase();
    if (
      text.includes('no pull requests found for branch') ||
      text.includes('could not resolve to a pullrequest')
    ) {
      return { outcome: 'not-found' };
    }
    return {
      outcome: 'unavailable',
      reason: `gh pr view failed (exit ${gh.exitCode})`,
    };
  }
}
