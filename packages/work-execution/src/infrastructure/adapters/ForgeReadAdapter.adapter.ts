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
  PullRequestRef,
  PullRequestSnapshot,
  ReadPullRequestRequest,
  ReadPullRequestResult,
} from '../../application/ports/out/ForgeReadPort.out-port.js';
import type { ContainsCommitRequest, ContainsCommitResult } from '../../application/ports/out/ForgeAncestryPort.out-port.js';
import type { ForgeAncestryPort } from '../../application/ports/out/ForgeAncestryPort.out-port.js';
import type { GhInvocationResult } from './ForgeActionAdapter.adapter.js';
import { isSafeBranchName } from './ForgeActionAdapter.adapter.js';

export interface ForgeReadAdapterOptions {
  readonly owner?: string;
  readonly repo?: string;
  readonly runGh?: (args: readonly string[]) => Promise<GhInvocationResult>;
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

export class ForgeReadAdapter implements ForgeReadPort, ForgeAncestryPort {
  private readonly owner?: string;
  private readonly repo?: string;
  private readonly runGh?: (args: readonly string[]) => Promise<GhInvocationResult>;
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
    const raced = await this.runGhWithinDeadline(args);
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

  /**
   * One gh invocation raced against the shared read deadline: a read that
   * settles after the deadline won must not become an unhandled rejection.
   * The caller maps the three outcomes onto its own reason strings.
   */
  private async runGhWithinDeadline(args: readonly string[]): Promise<
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
          timer = setTimeout(() => reject(new Error(READ_TIMED_OUT)), this.timeoutMs);
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
