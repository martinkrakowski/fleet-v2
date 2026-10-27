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
  ForgePullRequestRef,
  ForgeReadPort,
  PullRequestSnapshot,
  ReadPullRequestRequest,
  ReadPullRequestResult,
} from '../../application/ports/out/ForgeReadPort.out-port.js';
import type { GhInvocationResult } from './ForgeActionAdapter.adapter.js';
import { isSafeBranchName } from './ForgeActionAdapter.adapter.js';

export interface ForgeReadAdapterOptions {
  readonly owner?: string;
  readonly repo?: string;
  readonly runGh?: (args: readonly string[]) => Promise<GhInvocationResult>;
}

/** Always ask for state and head: `--json number` alone is answered without the forge. */
export const PULL_REQUEST_VIEW_FIELDS =
  'number,state,headRefOid,headRefName,baseRefName,mergedAt,closedAt,mergeCommit';

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+$/;
const HEX_40 = /^[0-9a-f]{40}$/;
const ALL_DIGITS = /^\d+$/;

const UNAVAILABLE_UNREADABLE: ReadPullRequestResult = {
  outcome: 'unavailable',
  reason: 'gh pr view returned an unreadable pull request',
};

const UNAVAILABLE_DIFFERENT: ReadPullRequestResult = {
  outcome: 'unavailable',
  reason: 'gh pr view answered for a different pull request',
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? '';
}

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
export function parsePullRequestView(stdout: string, ref: ForgePullRequestRef): ReadPullRequestResult {
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
    headSha,
    headRef,
    baseRef,
    mergedAtIso,
    closedAtIso,
    mergeCommitSha,
  };
  return { outcome: 'found', pullRequest };
}

export class ForgeReadAdapter implements ForgeReadPort {
  private readonly owner?: string;
  private readonly repo?: string;
  private readonly runGh?: (args: readonly string[]) => Promise<GhInvocationResult>;

  constructor(options: ForgeReadAdapterOptions = {}) {
    this.owner = options.owner;
    this.repo = options.repo;
    this.runGh = options.runGh;
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
    let gh: GhInvocationResult;
    try {
      gh = await runGh(args);
    } catch (error) {
      return {
        outcome: 'unavailable',
        reason: `gh pr view could not complete: ${errorMessage(error)}`,
      };
    }
    if (gh.exitCode !== 0) {
      return this.unavailableExit(gh);
    }
    return parsePullRequestView(gh.stdout, ref);
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
      reason: `gh pr view failed (exit ${gh.exitCode}): ${firstLine(gh.stderr) || firstLine(gh.stdout)}`,
    };
  }
}
