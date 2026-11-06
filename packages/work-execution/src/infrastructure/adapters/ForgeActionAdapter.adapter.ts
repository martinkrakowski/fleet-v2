// Implemented adapter — acceptance & forge station (cross-context step).
/**
 * ForgeActionAdapter implements ForgeActionPort through the reviewed
 * GitHub CLI subprocess. Credentials stay in the adapter's environment
 * and never reach lanes. Every invocation uses an explicit allow-listed
 * argument array; the branch head is verified against the expected head
 * before any command runs, merges are pinned to the expected head with
 * --match-head-commit, and an unknown or unverifiable outcome is reported
 * as ambiguous for reconciliation rather than guessed. Every refusal names
 * a kind derived from the failed run's whole output; an unrecognised one
 * is `other`. A13: because `gh pr merge` can exit non-zero after the merge
 * landed (for example a failing `--delete-branch` follow-up), every merge
 * refusal is confirmed by a read of the pull request state; merged at the
 * expected head is executed, open or closed is refused, and a read that
 * cannot answer is ambiguous rather than a guess.
 */

import type {
  ForgeActionPort,
  ForgeActionRequest,
  ForgeActionResult,
  OpenPullRequestByHead,
  OpenPullRequestsByHeadResult,
} from '../../application/ports/out/ForgeActionPort.out-port.js';
import type {
  MergeBranchHeadRequest,
  MergeBranchHeadResult,
  MergeForgeActionPort,
  MergeForgeActionRequest,
  MergeForgeActionResult,
  MergeForgeCreateBranchRequest,
  MergeForgeMergeMainIntoBranchRequest,
} from '../../application/ports/out/MergeForgeActionPort.out-port.js';
import type {
  ForgeReadPort,
  ForgeRepositoryRef,
  ReadPullRequestRequest,
  ReadPullRequestResult,
} from '../../application/ports/out/ForgeReadPort.out-port.js';
import type { ForgeRefusalKind } from '../../domain/coordination-keys.js';
import { parseBaseBranch } from '../../domain/base-branch.js';
import { classifyGhRefusal } from './gh-refusal.js';
import { ForgeReadAdapter } from './ForgeReadAdapter.adapter.js';

export {
  PERMISSION_NEEDLES,
  PROTECTION_NEEDLES,
  CONFLICT_NEEDLES,
  classifyGhRefusal,
} from './gh-refusal.js';

/** Result of one reviewed gh invocation. */
export interface GhInvocationResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Host-side delegates; the composition root binds the reviewed subprocess. */
export interface ForgeActionDelegate {
  /**
   * Run one reviewed `gh` invocation. The merge path (MergeForgeActionPort)
   * passes the per-kind `GH_CONFIG_DIR` and a subprocess-terminating timeout;
   * the attempt-bound path leaves both undefined.
   */
  readonly runGh?: (
    args: readonly string[],
    ghConfigDir?: string,
    timeoutMs?: number,
  ) => Promise<GhInvocationResult>;
  /**
   * Resolve the branch's current live head for exactly this request; a
   * delegate that cannot verify the head is required to refuse instead of
   * running any gh command.
   */
  readonly verifyCurrentHeadSha?: (
    branchName: string,
    request: ForgeActionRequest,
  ) => Promise<string>;
  /**
   * Read-only PR state (AM4b-2). Required for `push-to-pr`: without it the
   * push refuses, since the open PR and its head cannot be checked, and for
   * the merge path's head guard and A13/update-branch re-reads.
   */
  readonly pullRequestRead?: Pick<ForgeReadPort, 'readPullRequest'>;
  /**
   * The installation's repository (AM4b-3): when configured, every `gh`
   * argv carries `-R owner/repo` and reads name it explicitly.
   */
  readonly repository?: ForgeRepositoryRef;
  /** Wall-clock supplier for the merge path's deadline budget; tests inject a fixed clock. */
  readonly nowIso?: () => string;
}

/** Per-kind `GH_CONFIG_DIR` routing for the merge path (D-DT8). Values are never logged or printed. */
export interface ForgeActionAdapterConfig {
  /** The statuses-only poster identity's config dir; required for `post-status`. */
  readonly premergeGhConfigDir?: string;
  /** The merger identity's config dir; required for `merge-pr` and `update-branch`. */
  readonly mergeGhConfigDir?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? '';
}

/** Commit SHAs are 7-40 lowercase hex characters. */
function isCommitSha(value: string): boolean {
  return /^[0-9a-f]{7,40}$/.test(value);
}

/** A repository owner/repo segment: the forge-read's one-line rule, duplicated here (never imported). */
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+$/;

/** The exact 40-lowercase-hex commit id the post-status url pins. */
const HEX_40_PATTERN = /^[0-9a-f]{40}$/;

/** A refused `other` result; the shared refusal shape for post-status validation. */
function refusedOther(reason: string): ForgeActionResult {
  return { outcome: 'refused', reason, refusalKind: 'other' };
}

/** Whether a status description is paired with its state (rule: exactly these pairs). */
function pairedDescription(state: string, description: string): boolean {
  if (state === 'pending') {
    return description === 'waiting for the pre-merge review';
  }
  if (state === 'success') {
    return description === 'pre-merge receipt recorded' || description === 'not required for tier 1';
  }
  if (state === 'failure') {
    return /^findings: (?:0|[1-9][0-9]{0,2})$/.test(description);
  }
  return false;
}

/** Branch names stay one safe git ref segment path. */
export function isSafeBranchName(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes('..') &&
    !value.endsWith('/') &&
    !value.endsWith('.') &&
    !value.endsWith('.lock') &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
  );
}

/** Normal one-call timeout for `gh`, matching ForgeReadAdapter's read deadline. */
const NORMAL_FORGE_TIMEOUT_MS = 30_000;
/** A call with less than this much budget left is not started (plan §3.1). */
const MIN_REMAINING_TO_START_MS = 2_000;

/** A merge-pass request that is bound to a pull request (every kind but create-branch and merge-main-into-branch). */
type MergePullRequestRequest = Exclude<
  MergeForgeActionRequest,
  { readonly kind: 'create-branch' } | { readonly kind: 'merge-main-into-branch' }
>;

/** One own data property, read without running a getter; undefined for anything else. */
function ownData(source: unknown, key: string): unknown {
  try {
    if (typeof source !== 'object' || source === null) {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    return descriptor === undefined ? undefined : descriptor.value;
  } catch {
    // A Proxy trap may throw; the value then reads as absent.
    return undefined;
  }
}

/** A plain copy of a create-branch request's own data properties; absent keys stay absent. */
function snapshotCreateBranchRequest(request: object): MergeForgeCreateBranchRequest {
  const repository = ownData(request, 'repository');
  const copy: Record<string, unknown> = {
    kind: 'create-branch',
    actionId: ownData(request, 'actionId'),
    repository:
      typeof repository === 'object' && repository !== null
        ? { owner: ownData(repository, 'owner'), repo: ownData(repository, 'repo') }
        : repository,
    branchName: ownData(request, 'branchName'),
    sourceBranch: ownData(request, 'sourceBranch'),
    expectedHeadSha: ownData(request, 'expectedHeadSha'),
    deadlineIso: ownData(request, 'deadlineIso'),
  };
  for (const key of ['pullRequestNumber', 'status']) {
    if (Object.getOwnPropertyDescriptor(request, key) !== undefined) {
      copy[key] = ownData(request, key) ?? true;
    }
  }
  return copy as unknown as MergeForgeCreateBranchRequest;
}

/** Bounds for the legacy open-pull-request head lookup. */
const PR_HEAD_LOOKUP_TIMEOUT_MS = 15_000;
const PR_HEAD_LOOKUP_PAGE = 20;
const MAX_PR_LOOKUP_BODY_BYTES = 262_144;

/**
 * A plain copy of a merge-main-into-branch request's own data properties; absent
 * keys stay absent.
 */
function snapshotMergeMainIntoBranchRequest(request: object): MergeForgeMergeMainIntoBranchRequest {
  const repository = ownData(request, 'repository');
  const copy: Record<string, unknown> = {
    kind: 'merge-main-into-branch',
    actionId: ownData(request, 'actionId'),
    repository:
      typeof repository === 'object' && repository !== null
        ? { owner: ownData(repository, 'owner'), repo: ownData(repository, 'repo') }
        : repository,
    branchName: ownData(request, 'branchName'),
    sourceBranch: ownData(request, 'sourceBranch'),
    expectedHeadSha: ownData(request, 'expectedHeadSha'),
    deadlineIso: ownData(request, 'deadlineIso'),
  };
  for (const key of ['pullRequestNumber', 'status']) {
    if (Object.getOwnPropertyDescriptor(request, key) !== undefined) {
      copy[key] = ownData(request, key) ?? true;
    }
  }
  return copy as unknown as MergeForgeMergeMainIntoBranchRequest;
}

/** The largest ref body a branch-head read parses. */
const MAX_REF_BODY_CHARS = 65_536;

export class ForgeActionAdapter implements ForgeActionPort, MergeForgeActionPort {
  private readonly delegate?: ForgeActionDelegate;
  private readonly forgeRead?: ForgeReadPort;
  private readonly config?: ForgeActionAdapterConfig;

  constructor(
    delegate?: ForgeActionDelegate,
    forgeRead?: ForgeReadPort,
    config?: ForgeActionAdapterConfig,
  ) {
    this.delegate = delegate;
    this.forgeRead = forgeRead;
    this.config = config;
  }

  isConfigured(): boolean {
    return this.delegate !== undefined && this.delegate.runGh !== undefined;
  }

  /**
   * Read-only lookup of the open pull requests for `<owner>:<branch>` in the
   * bound repository (WB5b legacy PR-number lookup). The head is always
   * qualified with the repository's owner and every result's head repository
   * owner is re-checked, so a fork's branch of the same name never matches.
   * One bounded `gh api` read; any failure is `unreadable`, never empty.
   */
  async findOpenPullRequestsByHead(query: {
    readonly repository: string;
    readonly branchName: string;
  }): Promise<OpenPullRequestsByHeadResult> {
    const runGh = this.delegate?.runGh;
    if (runGh === undefined) {
      return { outcome: 'unreadable', reason: 'no gh subprocess is configured' };
    }
    const parts = query.repository.split('/');
    const owner = parts[0] ?? '';
    const repo = parts[1] ?? '';
    const namePattern = /^[A-Za-z0-9_.-]{1,100}$/;
    if (parts.length !== 2 || !namePattern.test(owner) || !namePattern.test(repo)) {
      return { outcome: 'unreadable', reason: 'the repository is not owner/repo' };
    }
    // The head owner always comes from the bound repository, never from the
    // query: an unbound adapter refuses, and a query for another repository
    // refuses.
    const bound = this.delegate?.repository;
    if (bound === undefined) {
      return { outcome: 'unreadable', reason: 'legacy-pr-lookup-unbound-repository' };
    }
    if (
      bound.owner.toLowerCase() !== owner.toLowerCase() ||
      bound.repo.toLowerCase() !== repo.toLowerCase()
    ) {
      return { outcome: 'unreadable', reason: 'legacy-pr-lookup-repository-mismatch' };
    }
    if (!isSafeBranchName(query.branchName)) {
      return { outcome: 'unreadable', reason: 'the branch name is not safe' };
    }
    // The bound owner and repo reach the endpoint path and the head filter, so
    // they are screened like the post-status path screens them (WB5b2).
    if (!REPOSITORY_PATTERN.test(bound.owner) || !REPOSITORY_PATTERN.test(bound.repo)) {
      return { outcome: 'unreadable', reason: 'the bound repository owner or repo is invalid' };
    }
    const args = [
      'api',
      `repos/${bound.owner}/${bound.repo}/pulls?head=${encodeURIComponent(`${bound.owner}:${query.branchName}`)}&state=open&per_page=${PR_HEAD_LOOKUP_PAGE}`,
    ];
    let gh: GhInvocationResult;
    try {
      gh = await runGh(args, undefined, PR_HEAD_LOOKUP_TIMEOUT_MS);
    } catch {
      return { outcome: 'unreadable', reason: 'the pull request lookup could not complete' };
    }
    if (gh.exitCode !== 0 || typeof gh.stdout !== 'string' || Buffer.byteLength(gh.stdout, 'utf8') > MAX_PR_LOOKUP_BODY_BYTES) {
      return { outcome: 'unreadable', reason: 'the pull request lookup failed' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(gh.stdout);
    } catch {
      return { outcome: 'unreadable', reason: 'the pull request lookup answer was not JSON' };
    }
    if (!Array.isArray(parsed) || parsed.length >= PR_HEAD_LOOKUP_PAGE) {
      // A full page may hide more matches: never guess from a truncated list.
      return { outcome: 'unreadable', reason: 'the pull request lookup answer was not a complete list' };
    }
    const pullRequests: OpenPullRequestByHead[] = [];
    for (const item of parsed as unknown[]) {
      const record = item as {
        number?: unknown;
        head?: { sha?: unknown; ref?: unknown; repo?: { owner?: { login?: unknown } | null } | null } | null;
      } | null;
      const number = record?.number;
      const sha = record?.head?.sha;
      const login = record?.head?.repo?.owner?.login;
      if (
        typeof number !== 'number' ||
        !Number.isSafeInteger(number) ||
        number < 1 ||
        typeof sha !== 'string' ||
        record?.head?.ref !== query.branchName ||
        typeof login !== 'string' ||
        login.toLowerCase() !== bound.owner.toLowerCase()
      ) {
        // A malformed, fork-headed or other-branch entry is ignored.
        continue;
      }
      pullRequests.push({ number, headSha: sha });
    }
    return { outcome: 'read', pullRequests };
  }

  async performForgeAction(request: ForgeActionRequest): Promise<ForgeActionResult> {
    const runGh = this.delegate?.runGh;
    if (!runGh) {
      throw new Error('Not implemented: ForgeActionAdapter.performForgeAction');
    }
    if (request.kind !== 'post-status' && request.status !== undefined) {
      return refusedOther('status is only valid for post-status');
    }
    if (request.kind === 'post-status') {
      const statusRefusal = this.statusFieldRefusal(request);
      if (statusRefusal !== null) {
        return statusRefusal;
      }
      const verified = await this.verifyHead(request);
      if (verified !== null) {
        return verified;
      }
      return this.runPostStatus(runGh, request);
    }
    if (!isCommitSha(request.expectedHeadSha)) {
      return refusedOther(`Invalid expected head SHA: ${request.expectedHeadSha}`);
    }
    if (!isSafeBranchName(request.branchName)) {
      return refusedOther(`Invalid branch name: ${request.branchName}`);
    }

    // `push-to-pr` reads the pull request first (the pre-read happens before
    // anything is pushed); the other kinds verify the live head next.
    if (request.kind === 'push-to-pr') {
      return this.runPushToPr(request);
    }

    const verified = await this.verifyHead(request);
    if (verified !== null) {
      return verified;
    }

    if (request.kind === 'push-and-open-pr') {
      return this.runPrCreate(runGh, request);
    }
    if (request.kind === 'merge-pr') {
      return this.runPrMerge(runGh, request);
    }
    return refusedOther('Unknown forge action kind');
  }

  /**
   * Validate the `post-status` request before the head is verified or `gh`
   * runs: status presence, context, state, the exact 40-hex head, the branch,
   * the repository and the description/state pairing. Returns a refused
   * `other` result, or null when the post may proceed. Never calls `runGh`.
   */
  private statusFieldRefusal(request: ForgeActionRequest): ForgeActionResult | null {
    const status = request.status;
    if (status === undefined) {
      return refusedOther('status is required for post-status');
    }
    if (status.context !== 'premerge') {
      return refusedOther('status context must be premerge');
    }
    if (status.state !== 'success' && status.state !== 'pending' && status.state !== 'failure') {
      return refusedOther('status state must be success, pending or failure');
    }
    if (!HEX_40_PATTERN.test(request.expectedHeadSha)) {
      return refusedOther(`Invalid expected head SHA: ${request.expectedHeadSha}`);
    }
    if (!isSafeBranchName(request.branchName)) {
      return refusedOther(`Invalid branch name: ${request.branchName}`);
    }
    const repository = this.delegate?.repository;
    if (repository === undefined) {
      return refusedOther('Cannot post status without a configured repository');
    }
    if (!REPOSITORY_PATTERN.test(repository.owner) || !REPOSITORY_PATTERN.test(repository.repo)) {
      return refusedOther('Invalid repository owner or repo');
    }
    if (!pairedDescription(status.state, status.description)) {
      return refusedOther('status description does not match its state');
    }
    return null;
  }

  /** Post the pre-merge review receipt to `gh api .../statuses/<sha>`. */
  private async runPostStatus(
    runGh: (args: readonly string[]) => Promise<GhInvocationResult>,
    request: ForgeActionRequest,
  ): Promise<ForgeActionResult> {
    const status = request.status;
    if (status === undefined) {
      return refusedOther('status is required for post-status');
    }
    const repository = this.delegate?.repository;
    if (repository === undefined) {
      return refusedOther('Cannot post status without a configured repository');
    }
    const args = [
      'api',
      '-X',
      'POST',
      `repos/${repository.owner}/${repository.repo}/statuses/${request.expectedHeadSha}`,
      '-f',
      `state=${status.state}`,
      '-f',
      'context=premerge',
      '-f',
      `description=${status.description}`,
    ];
    let gh: GhInvocationResult;
    try {
      gh = await runGh(args);
    } catch (error) {
      return {
        outcome: 'ambiguous',
        reason: `gh api statuses could not complete: ${errorMessage(error)}`,
      };
    }
    if (gh.exitCode !== 0) {
      return {
        outcome: 'refused',
        reason: `gh api statuses failed (exit ${gh.exitCode}): ${firstLine(gh.stderr) || 'gh api statuses failed'}`,
        refusalKind: classifyGhRefusal(gh.stderr, gh.stdout),
      };
    }
    return {
      outcome: 'executed',
      headSha: request.expectedHeadSha,
    };
  }

  /**
   * Verify the branch's live head matches the expected head. Returns a
   * final result (refused or ambiguous) when the check fails, or `null`
   * when the head matches and the action may proceed.
   */
  private async verifyHead(request: ForgeActionRequest): Promise<ForgeActionResult | null> {
    const verifyCurrentHeadSha = this.delegate?.verifyCurrentHeadSha;
    if (!verifyCurrentHeadSha) {
      return {
        outcome: 'refused',
        reason: 'Cannot perform forge action without verifyCurrentHeadSha',
        refusalKind: 'other',
      };
    }
    let currentHead: string;
    try {
      currentHead = await verifyCurrentHeadSha(request.branchName, request);
    } catch (error) {
      return {
        outcome: 'ambiguous',
        reason: `Could not verify the current head of ${request.branchName}: ${errorMessage(error)}`,
      };
    }
    // A moved head is refused; the old readiness is stale.
    if (currentHead !== request.expectedHeadSha) {
      return {
        outcome: 'refused',
        reason: `Moved head: branch ${request.branchName} is at ${currentHead}, expected ${request.expectedHeadSha}`,
        refusalKind: 'other',
      };
    }
    return null;
  }

  /** `-R owner/repo` when the installation repository is configured; else no extra args. */
  private repositoryArgs(): readonly string[] {
    const repository = this.delegate?.repository;
    return repository !== undefined ? ['-R', `${repository.owner}/${repository.repo}`] : [];
  }

  /**
   * Push-to-pr (AM4b-3): update an existing open PR's branch with the
   * attempt's verified head, never opening a second PR. The PR is read
   * before anything is pushed and again afterwards; a missing, closed or
   * unreadable PR refuses, an already-current head is a no-op, and a
   * post-push confirmation that does not show the head is ambiguous for
   * reconciliation.
   */
  private async runPushToPr(request: ForgeActionRequest): Promise<ForgeActionResult> {
    const reader = this.delegate?.pullRequestRead;
    if (reader === undefined) {
      return {
        outcome: 'refused',
        reason: 'Cannot push to a pull request without a pull request read',
        refusalKind: 'other',
      };
    }
    const readRequest: ReadPullRequestRequest = {
      ref: { kind: 'branch', branchName: request.branchName },
      ...(this.delegate?.repository !== undefined ? { repository: this.delegate.repository } : {}),
    };

    let preRead: ReadPullRequestResult;
    try {
      preRead = await reader.readPullRequest(readRequest);
    } catch (error) {
      return {
        outcome: 'refused',
        reason: `Could not read the pull request for branch ${request.branchName}: ${errorMessage(error)}`,
        refusalKind: 'other',
      };
    }
    if (preRead.outcome === 'unavailable') {
      return {
        outcome: 'refused',
        reason: `Could not read the pull request for branch ${request.branchName}: ${preRead.reason}`,
        refusalKind: 'other',
      };
    }
    if (preRead.outcome === 'not-found') {
      return {
        outcome: 'refused',
        reason: `No pull request exists for branch ${request.branchName}; push-to-pr never opens one`,
        refusalKind: 'other',
      };
    }
    const snapshot = preRead.pullRequest;
    if (snapshot.state !== 'open') {
      return {
        outcome: 'refused',
        reason: `Pull request #${snapshot.number} for branch ${request.branchName} is ${snapshot.state}, not open`,
        refusalKind: 'other',
      };
    }
    if (snapshot.headSha === request.expectedHeadSha) {
      return {
        outcome: 'executed',
        pullRequestNumber: snapshot.number,
        headSha: request.expectedHeadSha,
      };
    }

    const verified = await this.verifyHead(request);
    if (verified !== null) {
      return verified;
    }

    let postRead: ReadPullRequestResult;
    try {
      postRead = await reader.readPullRequest(readRequest);
    } catch {
      return {
        outcome: 'ambiguous',
        reason: `After the push step for branch ${request.branchName}, its pull request could not be read`,
      };
    }
    if (
      postRead.outcome === 'found' &&
      postRead.pullRequest.state === 'open' &&
      postRead.pullRequest.number === snapshot.number &&
      postRead.pullRequest.headSha.startsWith(request.expectedHeadSha)
    ) {
      return {
        outcome: 'executed',
        pullRequestNumber: postRead.pullRequest.number,
        headSha: request.expectedHeadSha,
      };
    }
    const whatWasRead =
      postRead.outcome === 'found'
        ? `#${postRead.pullRequest.number} ${postRead.pullRequest.state} at ${postRead.pullRequest.headSha}`
        : postRead.outcome === 'not-found'
          ? 'no pull request'
          : postRead.reason;
    return {
      outcome: 'ambiguous',
      reason: `After the push step for branch ${request.branchName}, pull request #${snapshot.number} does not show head ${request.expectedHeadSha}: ${whatWasRead}`,
    };
  }

  private async runPrCreate(
    runGh: (args: readonly string[]) => Promise<GhInvocationResult>,
    request: ForgeActionRequest,
  ): Promise<ForgeActionResult> {
    // CB-D2: the PR base follows the run's base branch when the request
    // carries one; an unparsable base refuses before `gh` runs.
    const baseBranch = request.baseBranch === undefined ? undefined : parseBaseBranch(request.baseBranch);
    if (request.baseBranch !== undefined && baseBranch === undefined) {
      return refusedOther('Invalid base branch');
    }
    const baseArgs = baseBranch === undefined ? [] : ['--base', baseBranch];
    const args = [
      'pr',
      'create',
      ...this.repositoryArgs(),
      '--head',
      request.branchName,
      ...baseArgs,
      '--title',
      request.title ?? `Fleet work order ${request.workOrderId}`,
      '--body',
      request.body ?? `Attempt ${request.attemptId} (action ${request.actionId}) at head ${request.expectedHeadSha}.`,
    ];
    let gh: GhInvocationResult;
    try {
      gh = await runGh(args);
    } catch (error) {
      return {
        outcome: 'ambiguous',
        reason: `gh pr create could not complete: ${errorMessage(error)}`,
      };
    }
    if (gh.exitCode !== 0) {
      return {
        outcome: 'refused',
        reason: `gh pr create failed (exit ${gh.exitCode}): ${firstLine(gh.stderr) || firstLine(gh.stdout)}`,
        refusalKind: classifyGhRefusal(gh.stderr, gh.stdout),
      };
    }
    const match = /\/pull\/(\d+)/.exec(gh.stdout) ?? /^#(\d+)\b/m.exec(gh.stdout);
    if (match === null) {
      return {
        outcome: 'ambiguous',
        reason: `gh pr create succeeded but no pull request number was reported: ${firstLine(gh.stdout)}`,
      };
    }
    return {
      outcome: 'executed',
      pullRequestNumber: Number(match[1]),
      headSha: request.expectedHeadSha,
    };
  }

  private async runPrMerge(
    runGh: (args: readonly string[]) => Promise<GhInvocationResult>,
    request: ForgeActionRequest,
  ): Promise<ForgeActionResult> {
    // The merge is pinned to the expected head; a moved PR head cannot match.
    // The resolved number is what is merged (WB5b2), so the merged pull request
    // and the recorded one are the same object; only a caller that resolved no
    // number falls back to the branch.
    const args = [
      'pr',
      'merge',
      ...this.repositoryArgs(),
      request.pullRequestNumber !== undefined ? String(request.pullRequestNumber) : request.branchName,
      '--match-head-commit',
      request.expectedHeadSha,
      '--merge',
    ];
    let gh: GhInvocationResult;
    try {
      gh = await runGh(args);
    } catch (error) {
      return {
        outcome: 'ambiguous',
        reason: `gh pr merge could not complete: ${errorMessage(error)}`,
      };
    }
    if (gh.exitCode !== 0) {
      const refusalKind = classifyGhRefusal(gh.stderr, gh.stdout);
      return this.confirmMergeAfterRefusal(request, refusalKind);
    }
    return {
      outcome: 'executed',
      headSha: request.expectedHeadSha,
    };
  }

  /**
   * A13: a non-zero `gh pr merge` exit does not prove the merge failed, so
   * the pull request state is read before any refusal is reported.
   */
  private async confirmMergeAfterRefusal(
    request: ForgeActionRequest,
    refusalKind: ForgeRefusalKind,
  ): Promise<ForgeActionResult> {
    const reader = this.forgeRead;
    if (reader === undefined || !reader.isConfigured()) {
      return {
        outcome: 'ambiguous',
        reason: 'gh pr merge exited non-zero and the pull request state could not be read',
      };
    }
    let read: ReadPullRequestResult;
    try {
      const ref =
        request.pullRequestNumber !== undefined
          ? { kind: 'number' as const, number: request.pullRequestNumber }
          : { kind: 'branch' as const, branchName: request.branchName };
      read = await reader.readPullRequest({
        ref,
        ...(this.delegate?.repository !== undefined ? { repository: this.delegate.repository } : {}),
      });
    } catch {
      return {
        outcome: 'ambiguous',
        reason: 'gh pr merge exited non-zero and the pull request state could not be read',
      };
    }
    if (read.outcome === 'not-found' || read.outcome === 'unavailable') {
      return {
        outcome: 'ambiguous',
        reason: 'gh pr merge exited non-zero and the pull request state could not be read',
      };
    }
    const snapshot = read.pullRequest;
    if (snapshot.state === 'merged') {
      if (isCommitSha(request.expectedHeadSha) && snapshot.headSha.startsWith(request.expectedHeadSha)) {
        return { outcome: 'executed', headSha: request.expectedHeadSha };
      }
      return {
        outcome: 'ambiguous',
        reason: 'the pull request merged at a different head',
      };
    }
    return {
      outcome: 'refused',
      reason: 'gh pr merge exited non-zero; the pull request is not merged',
      refusalKind,
    };
  }

  // --- MergeForgeActionPort (repo-scoped merge pass path, DT6a) ---------------

  async performMergeForgeAction(rawRequest: MergeForgeActionRequest): Promise<MergeForgeActionResult> {
    if (typeof rawRequest !== 'object' || rawRequest === null) {
      return this.mergeRefusedOther('invalid request');
    }
    if (ownData(rawRequest, 'kind') === 'create-branch') {
      // A create-branch request is read through its own data properties once, so no getter runs twice or throws.
      let snapshot: MergeForgeCreateBranchRequest;
      try {
        snapshot = snapshotCreateBranchRequest(rawRequest);
      } catch {
        return this.mergeRefusedOther('invalid request');
      }
      return this.performCreateBranch(snapshot);
    }
    if (ownData(rawRequest, 'kind') === 'merge-main-into-branch') {
      // The refresh kind is read through its own data properties once; no getter runs twice or throws.
      let snapshot: MergeForgeMergeMainIntoBranchRequest;
      try {
        snapshot = snapshotMergeMainIntoBranchRequest(rawRequest);
      } catch {
        return this.mergeRefusedOther('invalid request');
      }
      return this.performMergeMainIntoBranch(snapshot);
    }
    const kind = ownData(rawRequest, 'kind');
    if (kind !== 'merge-pr' && kind !== 'update-branch' && kind !== 'post-status') {
      // Includes an accessor `kind`, which would run its getter at the first read below.
      return this.mergeRefusedOther('invalid request');
    }
    const request = rawRequest as MergePullRequestRequest;
    const statusRefusal = this.mergeStatusRefusal(request);
    if (statusRefusal !== null) {
      return statusRefusal;
    }
    const validationRefusal = this.mergeValidationRefusal(request);
    if (validationRefusal !== null) {
      return validationRefusal;
    }
    const identityRefusal = this.mergeIdentityRefusal(request);
    if (identityRefusal !== null) {
      return identityRefusal;
    }
    const headGuard = await this.mergeReadHeadGuard(request);
    if (headGuard !== null) {
      return headGuard;
    }
    if (request.kind === 'merge-pr') {
      return this.runMergePr(request);
    }
    if (request.kind === 'update-branch') {
      return this.runMergeUpdateBranch(request);
    }
    return this.runMergePostStatus(request);
  }

  /** The reader's status rule (mirrors the attempt-bound path): only `post-status` may carry `status`. */
  private mergeStatusRefusal(request: MergeForgeActionRequest): MergeForgeActionResult | null {
    if (request.kind !== 'post-status') {
      if ('status' in request) {
        return this.mergeRefusedOther('status is only valid for post-status');
      }
      return null;
    }
    if (!('status' in request) || request.status === undefined) {
      return this.mergeRefusedOther('status is required for post-status');
    }
    if (request.status.context !== 'premerge') {
      return this.mergeRefusedOther('status context must be premerge');
    }
    if (
      request.status.state !== 'success' &&
      request.status.state !== 'failure'
    ) {
      return this.mergeRefusedOther('status state must be success or failure');
    }
    if (!pairedDescription(request.status.state, request.status.description)) {
      return this.mergeRefusedOther('status description does not match its state');
    }
    return null;
  }

  /** Refusal when the per-kind identity config dir is missing; checked before any head read. */
  private mergeIdentityRefusal(request: MergeForgeActionRequest): MergeForgeActionResult | null {
    if (request.kind === 'post-status') {
      if (this.premergeConfigDir() === null) {
        return this.mergeRefusedOther('no premerge identity is configured');
      }
      return null;
    }
    if (this.mergeConfigDir() === null) {
      return this.mergeRefusedOther('no merger identity is configured');
    }
    return null;
  }

  /** Attempt-bound validation mirrored for merge requests before any subprocess or read runs. */
  private mergeValidationRefusal(request: MergePullRequestRequest): MergeForgeActionResult | null {
    if (!Number.isFinite(Date.parse(request.deadlineIso))) {
      return this.mergeRefusedOther('unparseable deadline');
    }
    if (!Number.isSafeInteger(request.pullRequestNumber) || request.pullRequestNumber < 1) {
      return this.mergeRefusedOther(`Invalid pull request number: ${request.pullRequestNumber}`);
    }
    if (!REPOSITORY_PATTERN.test(request.repository.owner) || !REPOSITORY_PATTERN.test(request.repository.repo)) {
      return this.mergeRefusedOther('Invalid repository owner or repo');
    }
    if (!isSafeBranchName(request.branchName)) {
      return this.mergeRefusedOther(`Invalid branch name: ${request.branchName}`);
    }
    const validSha =
      request.kind === 'post-status'
        ? HEX_40_PATTERN.test(request.expectedHeadSha)
        : isCommitSha(request.expectedHeadSha);
    if (!validSha) {
      return this.mergeRefusedOther(`Invalid expected head SHA: ${request.expectedHeadSha}`);
    }
    return null;
  }

  /** The wall clock; tests inject a fixed `nowIso`. */
  private nowIso(): string {
    return this.delegate?.nowIso?.() ?? new Date().toISOString();
  }

  /**
   * The timeout bound for one call, or a budget refusal when the call must
   * not start: past the deadline, or fewer than 2 s remain. The caller maps
   * the refusal reason to `budget-exhausted`.
   */
  private budgetCallTimeoutMs(
    deadlineIso: string,
  ): { ok: true; timeoutMs: number } | { ok: false; reason: string } {
    const deadlineMs = Date.parse(deadlineIso);
    if (!Number.isFinite(deadlineMs)) {
      return { ok: false, reason: 'unparseable deadline' };
    }
    const remainingMs = deadlineMs - Date.parse(this.nowIso());
    if (remainingMs < MIN_REMAINING_TO_START_MS) {
      return { ok: false, reason: 'budget-exhausted' };
    }
    return { ok: true, timeoutMs: Math.min(NORMAL_FORGE_TIMEOUT_MS, remainingMs) };
  }

  private mergeRefusedOther(reason: string): MergeForgeActionResult {
    return { outcome: 'refused', reason, refusalKind: 'other' };
  }

  private mergeConfigDir(): string | null {
    const dir = this.config?.mergeGhConfigDir;
    return dir !== undefined && dir.trim().length > 0 ? dir.trim() : null;
  }

  private premergeConfigDir(): string | null {
    const dir = this.config?.premergeGhConfigDir;
    return dir !== undefined && dir.trim().length > 0 ? dir.trim() : null;
  }

  /** The per-kind config dir for a merge-path action: premerge for post-status, merger for others. */
  private configDirFor(request: MergeForgeActionRequest): string | null {
    return request.kind === 'post-status' ? this.premergeConfigDir() : this.mergeConfigDir();
  }

  /**
   * Build a reader that runs `gh pr view` with the per-kind config dir.
   * Merger's directory for merge-pr and update-branch, poster's for post-status.
   */
  private mergePullRequestReader(
    request: MergePullRequestRequest,
  ): Pick<ForgeReadPort, 'readPullRequest'> | null {
    const configDir = this.configDirFor(request);
    if (configDir === null) {
      return null;
    }
    const runGh = this.delegate?.runGh;
    if (runGh !== undefined) {
      return new ForgeReadAdapter({
        runGh: (args, timeoutMs) => runGh(args, configDir, timeoutMs),
      });
    }
    return this.delegate?.pullRequestRead ?? null;
  }

  /**
   * Read the pull request by number for the merge path, bounded by the
   * remaining budget. Returns null when the read cannot answer so the caller
   * reports ambiguous rather than writing.
   */
  private async mergeReadPullRequest(
    request: MergePullRequestRequest,
    timeoutMs: number,
  ): Promise<ReadPullRequestResult | null> {
    const reader = this.mergePullRequestReader(request);
    if (reader === null) {
      return null;
    }
    try {
      return await reader.readPullRequest({
        ref: { kind: 'number', number: request.pullRequestNumber },
        repository: request.repository,
        timeoutMs,
      });
    } catch {
      return null;
    }
  }

  /** Head guard for every merge-pass request, before any write. */
  private async mergeReadHeadGuard(request: MergePullRequestRequest): Promise<MergeForgeActionResult | null> {
    const budget = this.budgetCallTimeoutMs(request.deadlineIso);
    if (!budget.ok) {
      return this.mergeRefusedOther(budget.reason);
    }
    const read = await this.mergeReadPullRequest(request, budget.timeoutMs);
    if (read === null || read.outcome === 'not-found' || read.outcome === 'unavailable') {
      return { outcome: 'ambiguous', reason: 'could not read the pull request to verify its head' };
    }
    if (read.pullRequest.state !== 'open') {
      return this.mergeRefusedOther(
        `pull request #${request.pullRequestNumber} is ${read.pullRequest.state}, not open`,
      );
    }
    if (read.pullRequest.headSha !== request.expectedHeadSha) {
      return this.mergeRefusedOther('the pull request head moved since verification');
    }
    if (read.pullRequest.headRef !== request.branchName) {
      return this.mergeRefusedOther('the pull request head branch does not match the request');
    }
    return null;
  }

  private async runMergePr(request: MergePullRequestRequest): Promise<MergeForgeActionResult> {
    const configDir = this.mergeConfigDir();
    if (configDir === null) {
      return this.mergeRefusedOther('no merger identity is configured');
    }
    const runGh = this.delegate?.runGh;
    if (runGh === undefined) {
      return { outcome: 'ambiguous', reason: 'no gh subprocess is configured' };
    }
    const budget = this.budgetCallTimeoutMs(request.deadlineIso);
    if (!budget.ok) {
      return this.mergeRefusedOther(budget.reason);
    }
    const args = [
      'pr',
      'merge',
      '-R',
      `${request.repository.owner}/${request.repository.repo}`,
      String(request.pullRequestNumber),
      '--match-head-commit',
      request.expectedHeadSha,
      '--merge',
    ];
    let gh: GhInvocationResult;
    try {
      gh = await runGh(args, configDir, budget.timeoutMs);
    } catch {
      return { outcome: 'ambiguous', reason: 'gh pr merge could not complete' };
    }
    if (gh.exitCode !== 0) {
      return this.confirmMergeAfterRefusalScoped(request, classifyGhRefusal(gh.stderr, gh.stdout));
    }
    return { outcome: 'executed', headSha: request.expectedHeadSha };
  }

  /**
   * A13 for the merge path: a non-zero `gh pr merge` exit does not prove the
   * merge failed, so the pull request state is re-read (deadline-bounded)
   * before any refusal is reported.
   */
  private async confirmMergeAfterRefusalScoped(
    request: MergePullRequestRequest,
    refusalKind: ForgeRefusalKind,
  ): Promise<MergeForgeActionResult> {
    const budget = this.budgetCallTimeoutMs(request.deadlineIso);
    if (!budget.ok) {
      return {
        outcome: 'ambiguous',
        reason: 'gh pr merge exited non-zero and the pull request state could not be read',
      };
    }
    const read = await this.mergeReadPullRequest(request, budget.timeoutMs);
    if (read === null || read.outcome === 'not-found' || read.outcome === 'unavailable') {
      return {
        outcome: 'ambiguous',
        reason: 'gh pr merge exited non-zero and the pull request state could not be read',
      };
    }
    const snapshot = read.pullRequest;
    if (snapshot.state === 'merged') {
      if (isCommitSha(request.expectedHeadSha) && snapshot.headSha.startsWith(request.expectedHeadSha)) {
        return { outcome: 'executed', headSha: request.expectedHeadSha };
      }
      return { outcome: 'ambiguous', reason: 'the pull request merged at a different head' };
    }
    return {
      outcome: 'refused',
      reason: 'gh pr merge exited non-zero; the pull request is not merged',
      refusalKind,
    };
  }

  private async runMergeUpdateBranch(
    request: Extract<MergeForgeActionRequest, { kind: 'update-branch' }>,
  ): Promise<MergeForgeActionResult> {
    const configDir = this.mergeConfigDir();
    if (configDir === null) {
      return this.mergeRefusedOther('no merger identity is configured');
    }
    const runGh = this.delegate?.runGh;
    if (runGh === undefined) {
      return { outcome: 'ambiguous', reason: 'no gh subprocess is configured' };
    }
    const budget = this.budgetCallTimeoutMs(request.deadlineIso);
    if (!budget.ok) {
      return this.mergeRefusedOther(budget.reason);
    }
    const args = [
      'api',
      `repos/${request.repository.owner}/${request.repository.repo}/pulls/${request.pullRequestNumber}/update-branch`,
      '-f',
      `expected_head_sha=${request.expectedHeadSha}`,
      '-X',
      'PUT',
    ];
    let gh: GhInvocationResult;
    try {
      gh = await runGh(args, configDir, budget.timeoutMs);
    } catch {
      return { outcome: 'ambiguous', reason: 'gh api update-branch could not complete' };
    }
    if (gh.exitCode !== 0) {
      return this.reconcileUpdateBranchFailure(gh, request);
    }
    // The PUT is 202 async: re-read the head up to 3 times (plan §3.3).
    let observedOldHead = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const readBudget = this.budgetCallTimeoutMs(request.deadlineIso);
      if (!readBudget.ok) {
        break;
      }
      const read = await this.mergeReadPullRequest(request, readBudget.timeoutMs);
      if (read === null || read.outcome === 'not-found' || read.outcome === 'unavailable') {
        continue;
      }
      if (read.pullRequest.headSha !== request.expectedHeadSha) {
        return { outcome: 'executed', headSha: read.pullRequest.headSha };
      }
      observedOldHead = true;
    }
    if (observedOldHead) {
      return { outcome: 'ambiguous', reason: 'branch update accepted but the head is unchanged' };
    }
    return { outcome: 'ambiguous', reason: 'branch update accepted but the head could not be read' };
  }

  private async reconcileUpdateBranchFailure(
    gh: GhInvocationResult,
    request: Extract<MergeForgeActionRequest, { kind: 'update-branch' }>,
  ): Promise<MergeForgeActionResult> {
    // A changed head after a failed call does not say who changed it: this action or
    // someone else's push. It is never `executed` and never a definite refusal.
    const readBudget = this.budgetCallTimeoutMs(request.deadlineIso);
    if (readBudget.ok) {
      const read = await this.mergeReadPullRequest(request, readBudget.timeoutMs);
      if (
        read !== null &&
        read.outcome !== 'not-found' &&
        read.outcome !== 'unavailable' &&
        read.pullRequest.headSha !== request.expectedHeadSha
      ) {
        return {
          outcome: 'ambiguous',
          reason: `gh api update-branch failed (exit ${gh.exitCode}) and the head changed`,
        };
      }
    }
    const refusalKind = classifyGhRefusal(gh.stderr, gh.stdout);
    if (
      refusalKind === 'permission' ||
      refusalKind === 'protection' ||
      refusalKind === 'conflict'
    ) {
      return {
        outcome: 'refused',
        reason: `gh api update-branch failed (exit ${gh.exitCode})`,
        refusalKind,
      };
    }
    return {
      outcome: 'ambiguous',
      reason: `gh api update-branch failed (exit ${gh.exitCode})`,
    };
  }

  private async runMergePostStatus(
    request: Extract<MergeForgeActionRequest, { kind: 'post-status' }>,
  ): Promise<MergeForgeActionResult> {
    const configDir = this.premergeConfigDir();
    if (configDir === null) {
      return this.mergeRefusedOther('no premerge identity is configured');
    }
    const runGh = this.delegate?.runGh;
    if (runGh === undefined) {
      return { outcome: 'ambiguous', reason: 'no gh subprocess is configured' };
    }
    const budget = this.budgetCallTimeoutMs(request.deadlineIso);
    if (!budget.ok) {
      return this.mergeRefusedOther(budget.reason);
    }
    const args = [
      'api',
      '-X',
      'POST',
      `repos/${request.repository.owner}/${request.repository.repo}/statuses/${request.expectedHeadSha}`,
      '-f',
      `state=${request.status.state}`,
      '-f',
      'context=premerge',
      '-f',
      `description=${request.status.description}`,
    ];
    let gh: GhInvocationResult;
    try {
      gh = await runGh(args, configDir, budget.timeoutMs);
    } catch {
      return { outcome: 'ambiguous', reason: 'gh api statuses could not complete' };
    }
    if (gh.exitCode !== 0) {
      return {
        outcome: 'refused',
        reason: `gh api statuses failed (exit ${gh.exitCode})`,
        refusalKind: classifyGhRefusal(gh.stderr, gh.stdout),
      };
    }
    return { outcome: 'executed', headSha: request.expectedHeadSha };
  }

  // --- create-branch (lane CO7): chain/<name> from main at a recorded commit ---

  private async performCreateBranch(request: MergeForgeCreateBranchRequest): Promise<MergeForgeActionResult> {
    const refusal = this.createBranchValidationRefusal(request);
    if (refusal !== null) {
      return refusal;
    }
    if (this.mergeConfigDir() === null) {
      return this.mergeRefusedOther('no merger identity is configured');
    }
    return this.runCreateBranch(request);
  }

  /** Validation for create-branch: fixed reasons only, no input value echoed. */
  private createBranchValidationRefusal(request: MergeForgeCreateBranchRequest): MergeForgeActionResult | null {
    if ('pullRequestNumber' in request) {
      return this.mergeRefusedOther('create-branch carries no pull request');
    }
    if ('status' in request) {
      return this.mergeRefusedOther('status is only valid for post-status');
    }
    if (typeof request.actionId !== 'string' || request.actionId.length === 0 || request.actionId.length > 256) {
      return this.mergeRefusedOther('Invalid action id');
    }
    if (typeof request.deadlineIso !== 'string' || !Number.isFinite(Date.parse(request.deadlineIso))) {
      return this.mergeRefusedOther('unparseable deadline');
    }
    if (!this.isValidRepositoryRef(request.repository)) {
      return this.mergeRefusedOther('Invalid repository owner or repo');
    }
    if (!this.isChainBranch(request.branchName)) {
      return this.mergeRefusedOther('create-branch creates only a chain branch');
    }
    if (request.sourceBranch !== 'main') {
      return this.mergeRefusedOther('create-branch creates only from main');
    }
    if (typeof request.expectedHeadSha !== 'string' || !HEX_40_PATTERN.test(request.expectedHeadSha)) {
      return this.mergeRefusedOther('Invalid expected head SHA');
    }
    return null;
  }

  private isValidRepositoryRef(repository: unknown): repository is { readonly owner: string; readonly repo: string } {
    if (typeof repository !== 'object' || repository === null) {
      return false;
    }
    const owner = ownData(repository, 'owner');
    const repo = ownData(repository, 'repo');
    return (
      typeof owner === 'string' &&
      typeof repo === 'string' &&
      owner.length <= 100 &&
      repo.length <= 100 &&
      REPOSITORY_PATTERN.test(owner) &&
      REPOSITORY_PATTERN.test(repo) &&
      owner !== '.' &&
      owner !== '..' &&
      repo !== '.' &&
      repo !== '..'
    );
  }

  /** Only `chain/<lowercase-dashes>` is created here; `main` and every other branch is not. */
  private isChainBranch(branchName: unknown): branchName is string {
    return (
      typeof branchName === 'string' &&
      branchName.startsWith('chain/') &&
      parseBaseBranch(branchName) !== undefined &&
      isSafeBranchName(branchName)
    );
  }

  private async runCreateBranch(request: MergeForgeCreateBranchRequest): Promise<MergeForgeActionResult> {
    const configDir = this.mergeConfigDir();
    if (configDir === null) {
      return this.mergeRefusedOther('no merger identity is configured');
    }
    const runGh = this.delegate?.runGh;
    if (runGh === undefined) {
      return { outcome: 'ambiguous', reason: 'no gh subprocess is configured' };
    }
    const budget = this.budgetCallTimeoutMs(request.deadlineIso);
    if (!budget.ok) {
      return this.mergeRefusedOther(budget.reason);
    }
    const args = [
      'api',
      '--method',
      'POST',
      `repos/${request.repository.owner}/${request.repository.repo}/git/refs`,
      '-f',
      `ref=refs/heads/${request.branchName}`,
      '-f',
      `sha=${request.expectedHeadSha}`,
    ];
    let gh: GhInvocationResult;
    try {
      gh = await runGh(args, configDir, budget.timeoutMs);
    } catch {
      return { outcome: 'ambiguous', reason: 'gh api create-branch could not complete' };
    }
    if (gh.exitCode === 0) {
      return { outcome: 'executed', headSha: request.expectedHeadSha };
    }
    // A non-zero exit does not prove the branch is absent (it may already exist): read it back.
    const head = await this.readBranchHead(request);
    if (head.outcome === 'found') {
      if (head.headSha === request.expectedHeadSha) {
        return { outcome: 'executed', headSha: request.expectedHeadSha };
      }
      return {
        outcome: 'refused',
        reason: 'branch-exists-at-other-commit',
        refusalKind: 'other',
      };
    }
    if (head.outcome === 'not-found') {
      return {
        outcome: 'refused',
        reason: `gh api create-branch failed (exit ${gh.exitCode})`,
        refusalKind: classifyGhRefusal(gh.stderr, gh.stdout),
      };
    }
    return { outcome: 'ambiguous', reason: 'create-branch failed and the branch could not be read back' };
  }

  // --- merge-main-into-branch (lane CO8): merge main into chain/<name> ---

  private async performMergeMainIntoBranch(request: MergeForgeMergeMainIntoBranchRequest): Promise<MergeForgeActionResult> {
    const refusal = this.mergeMainIntoBranchValidationRefusal(request);
    if (refusal !== null) {
      return refusal;
    }
    if (this.mergeConfigDir() === null) {
      return this.mergeRefusedOther('no merger identity is configured');
    }
    return this.runMergeMainIntoBranch(request);
  }

  /** Validation for merge-main-into-branch: fixed reasons only, no input value echoed. */
  private mergeMainIntoBranchValidationRefusal(request: MergeForgeMergeMainIntoBranchRequest): MergeForgeActionResult | null {
    if ('pullRequestNumber' in request) {
      return this.mergeRefusedOther('merge-main-into-branch carries no pull request');
    }
    if ('status' in request) {
      return this.mergeRefusedOther('status is only valid for post-status');
    }
    if (typeof request.actionId !== 'string' || request.actionId.length === 0 || request.actionId.length > 256) {
      return this.mergeRefusedOther('Invalid action id');
    }
    if (typeof request.deadlineIso !== 'string' || !Number.isFinite(Date.parse(request.deadlineIso))) {
      return this.mergeRefusedOther('unparseable deadline');
    }
    if (!this.isValidRepositoryRef(request.repository)) {
      return this.mergeRefusedOther('Invalid repository owner or repo');
    }
    if (!this.isChainBranch(request.branchName)) {
      return this.mergeRefusedOther('merge-main-into-branch merges only a chain branch');
    }
    if (request.sourceBranch !== 'main') {
      return this.mergeRefusedOther('merge-main-into-branch merges only from main');
    }
    if (typeof request.expectedHeadSha !== 'string' || !HEX_40_PATTERN.test(request.expectedHeadSha)) {
      return this.mergeRefusedOther('Invalid expected head SHA');
    }
    return null;
  }

  private async runMergeMainIntoBranch(request: MergeForgeMergeMainIntoBranchRequest): Promise<MergeForgeActionResult> {
    const configDir = this.mergeConfigDir();
    if (configDir === null) {
      return this.mergeRefusedOther('no merger identity is configured');
    }
    const runGh = this.delegate?.runGh;
    if (runGh === undefined) {
      return { outcome: 'ambiguous', reason: 'no gh subprocess is configured' };
    }
    const budget = this.budgetCallTimeoutMs(request.deadlineIso);
    if (!budget.ok) {
      return this.mergeRefusedOther(budget.reason);
    }
    const args = [
      'api',
      '--method',
      'POST',
      `repos/${request.repository.owner}/${request.repository.repo}/merges`,
      '-f',
      `base=${request.branchName}`,
      '-f',
      'head=main',
    ];
    let gh: GhInvocationResult;
    try {
      gh = await runGh(args, configDir, budget.timeoutMs);
    } catch {
      return { outcome: 'ambiguous', reason: 'gh api merge-main-into-branch could not complete' };
    }
    if (gh.exitCode !== 0) {
      return this.reconcileMergeMainRefusal(gh, request);
    }
    const trimmed = gh.stdout.trim();
    if (trimmed.length === 0) {
      // HTTP 204: the branch is already up to date with main (no merge needed).
      return { outcome: 'already-applied' };
    }
    if (trimmed.length > MAX_REF_BODY_CHARS) {
      return { outcome: 'ambiguous', reason: 'merge response body too large' };
    }
    try {
      const body: unknown = JSON.parse(trimmed);
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return { outcome: 'ambiguous', reason: 'merge response was not a JSON object' };
      }
      const sha = (body as { readonly sha?: unknown }).sha;
      if (typeof sha !== 'string' || !HEX_40_PATTERN.test(sha)) {
        return { outcome: 'ambiguous', reason: 'merge response carried no usable commit sha' };
      }
      return { outcome: 'executed', headSha: sha };
    } catch {
      return { outcome: 'ambiguous', reason: 'merge response was not parseable JSON' };
    }
  }

  /**
   * A non-zero merge exit: a conflict is a refusal of kind conflict; a 404 is
   * confirmed against the branch head (absent → branch-gone; unreadable →
   * ambiguous); permission and protection are refusals; anything else is
   * ambiguous, never a guess.
   */
  private async reconcileMergeMainRefusal(
    gh: GhInvocationResult,
    request: MergeForgeMergeMainIntoBranchRequest,
  ): Promise<MergeForgeActionResult> {
    if (/HTTP 404|Not Found/i.test(`${gh.stderr}\n${gh.stdout}`)) {
      const head = await this.readMergeBranchHead({
        repository: request.repository,
        branchName: request.branchName,
        deadlineIso: request.deadlineIso,
      });
      if (head.outcome === 'not-found') {
        return { outcome: 'branch-gone' };
      }
      return { outcome: 'ambiguous', reason: 'merge refused and the branch could not be confirmed absent' };
    }
    const refusalKind = classifyGhRefusal(gh.stderr, gh.stdout);
    if (refusalKind === 'conflict') {
      return { outcome: 'refused', reason: 'merge into the chain branch conflicts with main', refusalKind: 'conflict' };
    }
    if (refusalKind === 'permission' || refusalKind === 'protection') {
      return { outcome: 'refused', reason: 'merge into the chain branch was refused', refusalKind };
    }
    return { outcome: 'ambiguous', reason: 'gh api merge-main-into-branch failed with an unrecognised answer' };
  }

  async readMergeBranchHead(request: MergeBranchHeadRequest): Promise<MergeBranchHeadResult> {
    if (typeof request !== 'object' || request === null) {
      return { outcome: 'unavailable', reason: 'invalid request' };
    }
    const deadlineIso = ownData(request, 'deadlineIso');
    const repository = ownData(request, 'repository');
    const branchName = ownData(request, 'branchName');
    if (typeof deadlineIso !== 'string' || !Number.isFinite(Date.parse(deadlineIso))) {
      return { outcome: 'unavailable', reason: 'unparseable deadline' };
    }
    if (!this.isValidRepositoryRef(repository) || (!this.isChainBranch(branchName) && branchName !== 'main')) {
      return { outcome: 'unavailable', reason: 'invalid request' };
    }
    return this.readBranchHead({
      repository: { owner: ownData(repository, 'owner') as string, repo: ownData(repository, 'repo') as string },
      branchName,
      deadlineIso,
    });
  }

  /** One `gh api` read of the branch ref (the API, never a local git read), bounded by the budget. */
  private async readBranchHead(request: MergeBranchHeadRequest): Promise<MergeBranchHeadResult> {
    const configDir = this.mergeConfigDir();
    if (configDir === null) {
      return { outcome: 'unavailable', reason: 'no merger identity is configured' };
    }
    const runGh = this.delegate?.runGh;
    if (runGh === undefined) {
      return { outcome: 'unavailable', reason: 'no gh subprocess is configured' };
    }
    const budget = this.budgetCallTimeoutMs(request.deadlineIso);
    if (!budget.ok) {
      return { outcome: 'unavailable', reason: budget.reason };
    }
    const args = ['api', `repos/${request.repository.owner}/${request.repository.repo}/git/ref/heads/${request.branchName}`];
    let gh: GhInvocationResult;
    try {
      gh = await runGh(args, configDir, budget.timeoutMs);
    } catch {
      return { outcome: 'unavailable', reason: 'gh api branch read could not complete' };
    }
    if (gh.exitCode !== 0) {
      if (/HTTP 404|Not Found/i.test(`${gh.stderr}\n${gh.stdout}`)) {
        return this.confirmBranchAbsent(request, runGh, configDir);
      }
      return { outcome: 'unavailable', reason: 'gh api branch read failed' };
    }
    return this.parseBranchHeadBody(gh.stdout, request.branchName);
  }

  /**
   * A 404 on the ref read also answers a repository the identity cannot see, so it proves the branch absent
   * only when the repository itself reads; otherwise the answer stays unavailable, never a guess.
   */
  private async confirmBranchAbsent(
    request: MergeBranchHeadRequest,
    runGh: NonNullable<ForgeActionDelegate['runGh']>,
    configDir: string,
  ): Promise<MergeBranchHeadResult> {
    const unresolved: MergeBranchHeadResult = { outcome: 'unavailable', reason: 'branch read could not confirm the branch is absent' };
    const budget = this.budgetCallTimeoutMs(request.deadlineIso);
    if (!budget.ok) {
      return unresolved;
    }
    try {
      const probe = await runGh(['api', `repos/${request.repository.owner}/${request.repository.repo}`], configDir, budget.timeoutMs);
      return probe.exitCode === 0 ? { outcome: 'not-found' } : unresolved;
    } catch {
      return unresolved;
    }
  }

  private parseBranchHeadBody(stdout: string, branchName: string): MergeBranchHeadResult {
    const unreadable: MergeBranchHeadResult = { outcome: 'unavailable', reason: 'branch read returned an unreadable body' };
    if (typeof stdout !== 'string' || stdout.length > MAX_REF_BODY_CHARS) {
      return unreadable;
    }
    try {
      const body: unknown = JSON.parse(stdout);
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return unreadable;
      }
      const { ref, object } = body as { readonly ref?: unknown; readonly object?: unknown };
      if (ref !== `refs/heads/${branchName}`) {
        return unreadable;
      }
      const sha = typeof object === 'object' && object !== null ? (object as { readonly sha?: unknown }).sha : undefined;
      if (typeof sha !== 'string' || !HEX_40_PATTERN.test(sha)) {
        return unreadable;
      }
      return { outcome: 'found', headSha: sha };
    } catch {
      return unreadable;
    }
  }
}
