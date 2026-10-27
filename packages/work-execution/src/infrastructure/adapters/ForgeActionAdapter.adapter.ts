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
  ReadPullRequestResult,
} from '../../application/ports/out/ForgeReadPort.out-port.js';
import type { ForgeRefusalKind } from '../../domain/coordination-keys.js';

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
    if (!isCommitSha(request.expectedHeadSha)) {
      return {
        outcome: 'refused',
        reason: `Invalid expected head SHA: ${request.expectedHeadSha}`,
        refusalKind: 'other',
      };
    }
    if (!isSafeBranchName(request.branchName)) {
      return {
        outcome: 'refused',
        reason: `Invalid branch name: ${request.branchName}`,
        refusalKind: 'other',
      };
    }

    // The live head must be verified for every invocation: an unconfigured
    // verification delegate refuses instead of trusting stale readiness.
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

    if (request.kind === 'push-and-open-pr') {
      return this.runPrCreate(runGh, request);
    }
    return this.runPrMerge(runGh, request);
  }

  private async runPrCreate(
    runGh: (args: readonly string[]) => Promise<GhInvocationResult>,
    request: ForgeActionRequest,
  ): Promise<ForgeActionResult> {
    const args = [
      'pr',
      'create',
      '--head',
      request.branchName,
      '--title',
      `Fleet work order ${request.workOrderId}`,
      '--body',
      `Attempt ${request.attemptId} (action ${request.actionId}) at head ${request.expectedHeadSha}.`,
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
      read = await reader.readPullRequest({ ref: { kind: 'branch', branchName: request.branchName } });
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
      if (snapshot.headSha.startsWith(request.expectedHeadSha)) {
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
