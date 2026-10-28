// @generated adapter scaffold — implemented for migration station O3 (reviewed git subprocesses).
/**
 * WorkspaceAdapter implements WorkspacePort. It inspects a Git worktree as a
 * typed record through reviewed `git` subprocesses; every read leaves the
 * worktree untouched (no resets, no checkouts, no cleanup) and the one write
 * is `commitLaneOutput`: stage, `commit-tree`, `update-ref` by
 * compare-and-swap; never a push, a reset or a checkout. Unreadable state is
 * an error, never a silent guess.
 *
 * Every command runs through the configured `CommandExecutorPort` (local or
 * ssh) with an explicit wall-clock budget: git commands, existence probes
 * and file reads each get 60 s; a run that exceeds its budget is killed and
 * reported as a failure, never a success. The former direct `sshHost` seam
 * is gone: transport selection is the
 * executor's job, made once from the installation configuration and not
 * re-decided here per call. In particular, once a worktree ssh host is
 * configured, git runs through that ssh transport even when the worktree
 * path also exists locally — the legacy `existsSync` probe is no longer part
 * of the transport decision (documented, tested change).
 */

import * as path from 'node:path';

import {
  WorktreePathRefusedError,
  type WorktreeInspection,
  type WorktreeInspectionRequest,
  type WorkspacePort,
} from '../../application/ports/out/WorkspacePort.out-port.js';
import type { CommandExecutorPort } from '../../application/ports/out/CommandExecutorPort.out-port.js';
import type { AttemptRunnerRecord } from '../../domain/execution-records.js';
import { validateWorktreeRelativePath } from '../../domain/worktree-path.js';
import { pathUnderPrefix } from '../../domain/lane-diff-check.js';
import { hasRecordedHostName } from './ConfirmRecordedHost.js';
import type { ExecutorForRecordedHostResult } from './ExecutorForHost.helper.js';
import { isValidAgyModel } from './AgyRunnerAdapter.adapter.js';
import type {
  CommitLaneOutputRequest,
  CommitLaneOutputResult,
} from '../../application/ports/out/WorkspacePort.out-port.js';

/**
 * Adapter-layer helper for resolving one caller-supplied path against a
 * worktree root. This is the single containment point for every worktree
 * target path built from caller input: the worktree must be an absolute
 * path that is not the filesystem root, an absolute candidate is accepted
 * only when it lies inside the worktree itself, and the resulting relative
 * candidate must pass the domain check before anything is joined and run.
 */

/**
 * Resolve one target path under `worktreePath`. Returns the absolute target
 * path, or throws `WorktreePathRefusedError` before any command runs.
 *
 * - The worktree root is stripped of trailing slashes; an empty result
 *   (`/`, `//`, `''`) or a relative worktree path is refused.
 * - An absolute candidate is rewritten to its worktree-relative form when it
 *   starts with `root + '/'`; any other absolute candidate is refused.
 * - The relative candidate must pass `validateWorktreeRelativePath`.
 */
export function resolveWorktreeTarget(worktreePath: string, candidate: string): string {
  const rootRefusal = worktreeRootRefusal(worktreePath);
  if (rootRefusal !== null) {
    throw new WorktreePathRefusedError(candidate, rootRefusal);
  }
  const trimmedWorktreeRoot = worktreePath.replace(/\/+$/, '');
  let relative = candidate;
  if (relative.startsWith('/') && relative.startsWith(`${trimmedWorktreeRoot}/`)) {
    relative = relative.slice(trimmedWorktreeRoot.length + 1);
  }
  const refusedReason = validateWorktreeRelativePath(relative);
  if (refusedReason !== null) {
    throw new WorktreePathRefusedError(candidate, refusedReason);
  }
  return path.join(worktreePath, relative);
}

/**
 * The worktree-root check alone: returns a reason string when `worktreePath`
 * is not an absolute path that is not the filesystem root, and null when the
 * containment prefix is sound. Callers that never derive a file target from
 * the worktree (for example brief placement, which joins only fixed `.lane`
 * names) use this instead of the full resolution.
 */
export function worktreeRootRefusal(worktreePath: string): string | null {
  const trimmed = worktreePath.replace(/\/+$/, '');
  if (trimmed === '' || !worktreePath.startsWith('/')) {
    return 'worktree path must be an absolute path that is not the filesystem root';
  }
  return null;
}

export interface WorkspaceAdapterOptions {
  /**
   * Executor owning the worktree's host commands. Every git command,
   * existence probe and file read runs through it, locally or over the ssh
   * transport the executor carries.
   */
  readonly executor?: CommandExecutorPort;
  /**
   * H9b2. When given, a read for an attempt recorded on a named host runs
   * through that recorded host's executor (the recorded host is the truth);
   * a host that changed or was removed is refused, naming the recorded
   * host. Legacy records (no recorded host name) keep `executor`.
   */
  readonly executorForRecordedHost?: (
    recorded: AttemptRunnerRecord | null | undefined,
  ) => ExecutorForRecordedHostResult;
}

/** Residue markers a previous attempt may have left in the worktree. */
const laneResidueFiles = ['.lane/brief.md', '.lane/brief-manifest.json', '.lane/notes.md'];

/** Wall-clock budget for one read-only git command in the worktree. */
const GIT_TIMEOUT_MS = 60 * 1000;

/** Wall-clock budget for one existence probe (`test -e`). */
const PROBE_TIMEOUT_MS = 60 * 1000;

/** Wall-clock budget for one file read (`cat`). */
const CAT_TIMEOUT_MS = 60 * 1000;

/** The commit's argv hardening (2026-10-16 plan, step 4): no hooks, no signing, no fsmonitor. */
const COMMIT_GIT_CONFIG: readonly string[] = [
  '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'core.fsmonitor=false',
];
const COMMIT_HEAD_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const COMMIT_ATTEMPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * The commit message of one edit-only attempt: a subject line and the two
 * trailers, nothing else.
 */
export function editOnlyCommitMessage(attemptId: string, implementerModel: string): string {
  return 'fleet: edit-only lane output for ' + attemptId + '\n\n' +
    'Implemented-By: agy ' + implementerModel + '\n' +
    'Fleet-Attempt: ' + attemptId + '\n';
}

/**
 * Validate that an SSH host string is safe to pass to subprocess commands.
 * Matches `^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+$` and does not start with `-`.
 */
export function isSafeSshHost(host: string): boolean {
  if (typeof host !== 'string' || host.startsWith('-')) {
    return false;
  }
  const atIndex = host.indexOf('@');
  if (atIndex !== -1 && host.slice(atIndex + 1).startsWith('-')) {
    return false;
  }
  return SAFE_SSH_HOST_PATTERN.test(host);
}

const SAFE_SSH_HOST_PATTERN = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+$/;

/** Strip porcelain v1 quoting around paths with special characters. */
function unquotePorcelainPath(porcelainPath: string): string {
  if (porcelainPath.startsWith('"') && porcelainPath.endsWith('"')) {
    return porcelainPath.slice(1, -1);
  }
  return porcelainPath;
}

export class WorkspaceAdapter implements WorkspacePort {
  constructor(private readonly options?: WorkspaceAdapterOptions) {}

  /**
   * The executor for one read: a read carrying a recorded host name goes to
   * that recorded host's executor when the helper is wired; everything else
   * keeps the configured executor. The executor is the only transport;
   * without one there is nothing to run.
   */
  private executorFor(
    recordedHost?: AttemptRunnerRecord | null,
  ): CommandExecutorPort {
    if (
      this.options?.executorForRecordedHost !== undefined &&
      hasRecordedHostName(recordedHost)
    ) {
      const resolved = this.options.executorForRecordedHost(recordedHost);
      if (!resolved.ok) {
        throw new Error(resolved.reason);
      }
      return resolved.executor;
    }
    const executor = this.options?.executor;
    if (executor === undefined) {
      throw new Error('WorkspaceAdapter requires a configured CommandExecutorPort executor');
    }
    return executor;
  }

  async inspectWorktree(request: WorktreeInspectionRequest): Promise<WorktreeInspection> {
    const { worktreePath, baseCommit } = request;
    const executor = this.executorFor(request.recordedHost);

    let checkedOutCommit: string;
    try {
      checkedOutCommit = (await this.runGit(worktreePath, ['rev-parse', 'HEAD'], executor)).trim();
    } catch (error) {
      throw new Error(`Unable to read HEAD commit in ${worktreePath}: ${String(error)}`, {
        cause: error,
      });
    }

    let statusOutput: string;
    try {
      statusOutput = await this.runGit(worktreePath, ['status', '--porcelain=v1', '-uall'], executor);
    } catch (error) {
      throw new Error(`Unable to read git status in ${worktreePath}: ${String(error)}`, {
        cause: error,
      });
    }

    const uncommittedPaths: string[] = [];
    const untrackedPaths: string[] = [];
    for (const line of statusOutput.split('\n')) {
      if (line === '') continue;
      // Porcelain v1: two status columns, one space, then the path.
      const entryPath = unquotePorcelainPath(line.slice(3));
      if (entryPath === '') continue;
      if (line.startsWith('?? ')) {
        untrackedPaths.push(entryPath);
      } else {
        uncommittedPaths.push(entryPath);
      }
    }

    const residueFromEarlierAttempts: string[] = [];
    for (const residueFile of laneResidueFiles) {
      const residuePath = path.join(worktreePath, residueFile);
      if (await this.pathExists(worktreePath, residuePath, executor)) residueFromEarlierAttempts.push(residueFile);
    }

    const missingExpectedArtifacts: string[] = [];
    for (const expectedPath of request.expectedArtifactPaths) {
      // Every caller-supplied expected-artifact path is contained here: an
      // absolute or escaping entry is refused before any probe runs.
      const absolutePath = resolveWorktreeTarget(worktreePath, expectedPath);
      if (!(await this.pathExists(worktreePath, absolutePath, executor))) {
        missingExpectedArtifacts.push(expectedPath);
      }
    }

    return {
      worktreePath,
      checkedOutCommit,
      matchesBaseCommit:
        checkedOutCommit === baseCommit ||
        checkedOutCommit.startsWith(baseCommit) ||
        baseCommit.startsWith(checkedOutCommit),
      uncommittedPaths,
      untrackedPaths,
      residueFromEarlierAttempts,
      missingExpectedArtifacts,
    };
  }

  /** Read-only git in the worktree, through the executor, within its budget. */
  private async runGit(
    worktreePath: string,
    args: readonly string[],
    executor: CommandExecutorPort,
  ): Promise<string> {
    const result = await executor.run(['git', '-C', worktreePath, ...args], {
      timeoutMs: GIT_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `git ${args.join(' ')} failed in ${worktreePath}: exit ${String(result.exitCode)}` +
          (result.stderr.trim() !== '' ? `: ${result.stderr.trim()}` : ''),
      );
    }
    return result.stdout;
  }

  /** Existence of one absolute path in the worktree's filesystem. */
  private async pathExists(
    worktreePath: string,
    targetPath: string,
    executor: CommandExecutorPort,
  ): Promise<boolean> {
    const result = await executor.run(['test', '-e', targetPath], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new Error(
        `Unable to probe ${targetPath}: exit ${String(result.exitCode)}` +
          (result.error !== undefined ? `: ${result.error}` : ''),
      );
    }
    return result.exitCode === 0;
  }

  async readWorktreeFile(
    worktreePath: string,
    relativePath: string,
    recordedHost?: AttemptRunnerRecord | null,
  ): Promise<string | null> {
    // Containment lives in the shared adapter helper: the worktree must be
    // an absolute path that is not the filesystem root, an absolute candidate
    // is accepted only when it lies inside the worktree itself, and the
    // relative form must pass the domain check — all before any command.
    const targetPath = resolveWorktreeTarget(worktreePath, relativePath);
    const executor = this.executorFor(recordedHost);
    const result = await executor.run(['cat', targetPath], { timeoutMs: CAT_TIMEOUT_MS });
    // A null exit code (spawn failure, timeout) is a failed read, not an
    // absent file; only exit 1 and friends mean "no such file".
    if (result.exitCode === null) {
      throw new Error(
        `Unable to read ${targetPath}` + (result.error !== undefined ? `: ${result.error}` : ''),
      );
    }
    return result.exitCode === 0 ? result.stdout : null;
  }

  /**
   * One commit command in the worktree with the commit hardening: no hooks,
   * no signing, no fsmonitor. `ok: false` when the command failed or never
   * reported an exit code, with a fixed reason that never carries stderr or
   * a path.
   */
  private async runCommitGit(
    executor: CommandExecutorPort,
    worktreePath: string,
    args: readonly string[],
  ): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
    const result = await executor.run(['git', '-C', worktreePath, ...COMMIT_GIT_CONFIG, ...args], {
      timeoutMs: GIT_TIMEOUT_MS,
    });
    if (result.exitCode !== 0 || result.error !== undefined) {
      return { ok: false, reason: 'git ' + args[0] + ' failed' };
    }
    return { ok: true, stdout: result.stdout };
  }

  /**
   * Stage the whole checked change set, write the staged tree and read
   * HEAD's tree. The one shared HEAD-tree comparison for both of its uses:
   * the nothing-to-commit check on the main path and the ownership proof of
   * the already-committed path.
   */
  private async stageAndCompareWithHeadTree(
    executor: CommandExecutorPort,
    worktreePath: string,
  ): Promise<{ ok: true; tree: string; headTree: string } | { ok: false; reason: string }> {
    // Stage the whole checked change set. Ignored files are never staged.
    const addRun = await this.runCommitGit(executor, worktreePath, ['add', '-A', '--', '.']);
    if (!addRun.ok) return { ok: false, reason: addRun.reason };
    const treeRun = await this.runCommitGit(executor, worktreePath, ['write-tree']);
    if (!treeRun.ok) return { ok: false, reason: treeRun.reason };
    const headTreeRun = await this.runCommitGit(executor, worktreePath, ['rev-parse', '--verify', 'HEAD^{tree}']);
    if (!headTreeRun.ok) return { ok: false, reason: headTreeRun.reason };
    return { ok: true, tree: treeRun.stdout.trim(), headTree: headTreeRun.stdout.trim() };
  }

  async commitLaneOutput(request: CommitLaneOutputRequest): Promise<CommitLaneOutputResult> {
    // 1. Validate before any command runs.
    const worktreeRefusal = worktreeRootRefusal(request.worktreePath);
    const allowedPathPrefixes = request.allowedPathPrefixes;
    const prefixesValid =
      allowedPathPrefixes.length > 0 &&
      allowedPathPrefixes.every((prefix) => typeof prefix === 'string' && prefix !== '');
    if (
      worktreeRefusal !== null ||
      COMMIT_HEAD_PATTERN.test(request.expectedHead) !== true ||
      COMMIT_ATTEMPT_ID_PATTERN.test(request.attemptId) !== true ||
      isValidAgyModel(request.implementerModel) !== true ||
      prefixesValid !== true
    ) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }

    // 2. The commit runs on the recorded host's executor when there is one.
    let executor: CommandExecutorPort;
    try {
      executor = this.executorFor(request.recordedHost);
    } catch {
      return { outcome: 'error', reason: 'worktree host could not be resolved' };
    }

    const { worktreePath } = request;

    // 3. Read HEAD.
    const headRun = await this.runCommitGit(executor, worktreePath, ['rev-parse', '--verify', 'HEAD^{commit}']);
    if (!headRun.ok) return { outcome: 'error', reason: headRun.reason };
    const head = headRun.stdout.trim();

    // 4. The checked-out branch, else a detached head is refused.
    const branchRun = await this.runCommitGit(executor, worktreePath, ['symbolic-ref', '-q', 'HEAD']);
    if (!branchRun.ok) return { outcome: 'refused', reason: 'detached-head' };
    const branchRef = branchRun.stdout.trim();
    if (branchRef.startsWith('refs/heads/') !== true) {
      return { outcome: 'refused', reason: 'detached-head' };
    }

    // 5. HEAD must be the dispatch head; a crash after the commit reads as
    // already-committed instead of a head-moved refusal. `already-committed`
    // must prove the commit is this adapter's: the dispatch head as the only
    // parent, this adapter's exact message, and a worktree holding nothing
    // beyond that commit. A foreign commit carrying the trailer never passes.
    if (head !== request.expectedHead) {
      const parentsRun = await this.runCommitGit(executor, worktreePath, ['show', '-s', '--format=%P', 'HEAD']);
      if (!parentsRun.ok) return { outcome: 'error', reason: parentsRun.reason };
      const parents = parentsRun.stdout.trim();
      if (parents !== request.expectedHead) {
        return { outcome: 'refused', reason: 'head-moved' };
      }
      const messageRun = await this.runCommitGit(executor, worktreePath, ['show', '-s', '--format=%B', 'HEAD']);
      if (!messageRun.ok) return { outcome: 'error', reason: messageRun.reason };
      const expectedMessage = editOnlyCommitMessage(request.attemptId, request.implementerModel);
      if (messageRun.stdout.trim() !== expectedMessage.trim()) {
        return { outcome: 'refused', reason: 'head-moved' };
      }
      const ownershipTree = await this.stageAndCompareWithHeadTree(executor, worktreePath);
      if (!ownershipTree.ok) return { outcome: 'error', reason: ownershipTree.reason };
      if (ownershipTree.tree !== ownershipTree.headTree) {
        return { outcome: 'refused', reason: 'head-moved' };
      }
      return { outcome: 'already-committed', headCommit: head, branchRef };
    }

    // 6–7. Stage the change set, write the staged tree and compare it with
    // HEAD's tree (the shared comparison helper).
    const stagedTree = await this.stageAndCompareWithHeadTree(executor, worktreePath);
    if (!stagedTree.ok) return { outcome: 'error', reason: stagedTree.reason };
    const tree = stagedTree.tree;
    if (tree === stagedTree.headTree) {
      return { outcome: 'nothing-to-commit' };
    }

    // 7b. The diff check ran before staging; re-check the tree that is
    // actually about to be committed, so a file written between the check
    // and `add -A` is refused here. Nothing is committed and no ref moves;
    // the staged index is left as it is (no reset).
    const diffTreeRun = await this.runCommitGit(
      executor,
      worktreePath,
      ['diff-tree', '-r', '--no-renames', '--name-only', '-z', request.expectedHead, tree],
    );
    if (!diffTreeRun.ok) return { outcome: 'error', reason: diffTreeRun.reason };
    const changedPaths = diffTreeRun.stdout.split('\0').filter((changedPath) => changedPath !== '');
    const outsideAllowedPaths = changedPaths.some(
      (changedPath) => allowedPathPrefixes.some((prefix) => pathUnderPrefix(changedPath, prefix)) !== true,
    );
    if (outsideAllowedPaths) {
      return { outcome: 'refused', reason: 'outside-allowed-paths' };
    }

    // 8. Write the commit: the dispatch head is the only parent.
    const commitRun = await this.runCommitGit(
      executor,
      worktreePath,
      [
        'commit-tree', tree, '-p', request.expectedHead, '--no-gpg-sign',
        '-m', editOnlyCommitMessage(request.attemptId, request.implementerModel),
      ],
    );
    if (!commitRun.ok) return { outcome: 'error', reason: commitRun.reason };
    const commit = commitRun.stdout.trim();
    if (COMMIT_HEAD_PATTERN.test(commit) !== true) {
      return { outcome: 'error', reason: 'git commit-tree failed' };
    }

    // 9. Move the branch by compare-and-swap: git refuses when the branch
    // moved since `expectedHead`, and then nothing was moved.
    const updateRun = await this.runCommitGit(
      executor,
      worktreePath,
      ['update-ref', '-m', 'fleet edit-only commit ' + request.attemptId, branchRef, commit, request.expectedHead],
    );
    if (!updateRun.ok) return { outcome: 'refused', reason: 'ref-moved' };

    // 10. Done.
    return { outcome: 'committed', headCommit: commit, branchRef };
  }
}
