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
} from '../../application/ports/out/ForgeActionPort.out-port.js';
import type {
  ForgeReadPort,
  ForgeRepositoryRef,
  ReadPullRequestRequest,
  ReadPullRequestResult,
} from '../../application/ports/out/ForgeReadPort.out-port.js';
import type { ForgeRefusalKind } from '../../domain/coordination-keys.js';
import { parseBaseBranch } from '../../domain/base-branch.js';

/** Result of one reviewed gh invocation. */
export interface GhInvocationResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Host-side delegates; the composition root binds the reviewed subprocess. */
export interface ForgeActionDelegate {
  readonly runGh?: (args: readonly string[]) => Promise<GhInvocationResult>;
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
   * push refuses, since the open PR and its head cannot be checked.
   */
  readonly pullRequestRead?: Pick<ForgeReadPort, 'readPullRequest'>;
  /**
   * The installation's repository (AM4b-3): when configured, every `gh`
   * argv carries `-R owner/repo` and reads name it explicitly.
   */
  readonly repository?: ForgeRepositoryRef;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? '';
}

/** Lower-case needles checked in this order: permission, then protection, then conflict. */
const PERMISSION_NEEDLES: readonly string[] = [
  'resource not accessible by integration',
  'does not have the correct permissions',
  'must have admin rights',
  'must have write access',
  'permission denied',
  'bad credentials',
  'http 401',
  'http 403',
  'gh auth login',
];
const PROTECTION_NEEDLES: readonly string[] = [
  'base branch policy prohibits the merge',
  'required status check',
  'approving review',
  'review is required',
  'repository rule violation',
  'protected branch',
  'branch protection',
];
const CONFLICT_NEEDLES: readonly string[] = [
  'merge commit cannot be cleanly created',
  'merge conflict',
  'has conflicts',
];

/**
 * Classify a failed `gh` run by its whole output (plan AM4b). Permission wins
 * over protection, protection over conflict; anything unrecognised is `other`.
 */
export function classifyGhRefusal(stderr: string, stdout: string): ForgeRefusalKind {
  const text = (stderr + '\n' + stdout).toLowerCase();
  if (PERMISSION_NEEDLES.some((needle) => text.includes(needle))) {
    return 'permission';
  }
  if (PROTECTION_NEEDLES.some((needle) => text.includes(needle))) {
    return 'protection';
  }
  if (CONFLICT_NEEDLES.some((needle) => text.includes(needle))) {
    return 'conflict';
  }
  return 'other';
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

export class ForgeActionAdapter implements ForgeActionPort {
  private readonly delegate?: ForgeActionDelegate;
  private readonly forgeRead?: ForgeReadPort;

  constructor(delegate?: ForgeActionDelegate, forgeRead?: ForgeReadPort) {
    this.delegate = delegate;
    this.forgeRead = forgeRead;
  }

  isConfigured(): boolean {
    return this.delegate !== undefined && this.delegate.runGh !== undefined;
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
    const args = [
      'pr',
      'merge',
      ...this.repositoryArgs(),
      request.branchName,
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
}
