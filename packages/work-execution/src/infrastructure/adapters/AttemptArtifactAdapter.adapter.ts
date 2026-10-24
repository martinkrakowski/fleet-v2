// @generated adapter scaffold — implemented for migration step 2 (verified ignored paths, bounded artifact collection).
/**
 * AttemptArtifactAdapter implements AttemptArtifactPort. Frozen briefs are
 * placed only under paths proven gitignored by the worktree's index, and
 * artifacts are collected only for a completion receipt bound to the attempt.
 * The collected record reports facts (missing notes included), never prose.
 *
 * Every command runs through the configured `CommandExecutorPort` (local or
 * ssh) with an explicit wall-clock budget: git commands, existence probes,
 * reads and `mkdir` each get 60 s, and each `tee` stdin write gets 120 s; a
 * run that exceeds its budget is killed and reported as a failure, never a
 * success. The former direct `sshHost` seam is gone: transport selection is the
 * executor's job. The brief bytes travel on the executor's stdin (`tee`,
 * bounded by an explicit wall-clock timeout), so no remote shell ever sees
 * operator-authored prose.
 */

import * as path from 'node:path';

import type {
  AttemptArtifactPort,
  CollectCompletedAttemptArtifactsRequest,
  CollectCompletedAttemptArtifactsResult,
  PlaceFrozenBriefRequest,
  PlaceFrozenBriefResult,
  VerifyIgnoredPathsRequest,
  VerifyIgnoredPathsResult,
} from '../../application/ports/out/AttemptArtifactPort.out-port.js';
import type { CommandExecutorPort } from '../../application/ports/out/CommandExecutorPort.out-port.js';
import type { AttemptRunnerRecord } from '../../domain/execution-records.js';
import { hasRecordedHostName } from './ConfirmRecordedHost.js';
import type { ExecutorForRecordedHostResult } from './ExecutorForHost.helper.js';
import { resolveWorktreeTarget, worktreeRootRefusal } from './WorkspaceAdapter.adapter.js';

export interface AttemptArtifactAdapterOptions {
  /**
   * Executor owning the worktree's host commands. Frozen brief bytes travel
   * on the executor's stdin (`tee`), so no remote shell ever sees
   * operator-authored prose.
   */
  readonly executor?: CommandExecutorPort;
  /**
   * H9b2. When given, a read for an attempt recorded on a named host runs
   * through that recorded host's executor (the recorded host is the truth);
   * a host that changed or was removed is refused, naming the recorded
   * host. Legacy records (no recorded host name) keep `executor`. Brief
   * placement (a write before dispatch) always keeps `executor`.
   */
  readonly executorForRecordedHost?: (
    recorded: AttemptRunnerRecord | null | undefined,
  ) => ExecutorForRecordedHostResult;
}

/** Wall-clock budget for one brief-placement command (`mkdir`). */
const BRIEF_WRITE_TIMEOUT_MS = 60 * 1000;

/** Wall-clock budget for one `tee` stdin write of brief bytes. */
const TEE_TIMEOUT_MS = 120 * 1000;

/** Wall-clock budget for one read-only git command in the worktree. */
const GIT_TIMEOUT_MS = 60 * 1000;

/** Wall-clock budget for one existence probe (`test -e`). */
const PROBE_TIMEOUT_MS = 60 * 1000;

/** Wall-clock budget for one file read (`cat`). */
const CAT_TIMEOUT_MS = 60 * 1000;

export class AttemptArtifactAdapter implements AttemptArtifactPort {
  constructor(private readonly options?: AttemptArtifactAdapterOptions) {}

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
      throw new Error('AttemptArtifactAdapter requires a configured CommandExecutorPort executor');
    }
    return executor;
  }

  async verifyIgnoredPaths(request: VerifyIgnoredPathsRequest): Promise<VerifyIgnoredPathsResult> {
    const offendingPaths: string[] = [];
    for (const candidatePath of request.candidatePaths) {
      const ignored = await this.checkIgnored(request.worktreePath, candidatePath);
      if (!ignored) offendingPaths.push(candidatePath);
    }
    if (offendingPaths.length > 0) {
      return { outcome: 'not-ignored', offendingPaths };
    }
    return { outcome: 'ignored', checkedPaths: [...request.candidatePaths] };
  }

  async placeFrozenBrief(request: PlaceFrozenBriefRequest): Promise<PlaceFrozenBriefResult> {
    // Brief placement joins only fixed `.lane` names, but the worktree itself
    // must still be a sound containment prefix before any command runs.
    const rootRefusal = worktreeRootRefusal(request.worktreePath);
    if (rootRefusal !== null) {
      return { outcome: 'refused', reason: rootRefusal };
    }
    const executor = this.executorFor();
    const briefTargets = ['.lane/brief.md', '.lane/brief-manifest.json'];
    const ignored = await this.verifyIgnoredPaths({
      worktreePath: request.worktreePath,
      candidatePaths: briefTargets,
    });
    if (ignored.outcome === 'not-ignored') {
      return { outcome: 'refused', reason: 'Brief target paths are not gitignored' };
    }
    const laneDirectory = path.join(request.worktreePath, '.lane');
    const prosePath = path.join(laneDirectory, 'brief.md');
    const manifestPath = path.join(laneDirectory, 'brief-manifest.json');
    const mkdir = await executor.run(['mkdir', '-p', laneDirectory], {
      timeoutMs: BRIEF_WRITE_TIMEOUT_MS,
    });
    if (mkdir.exitCode !== 0) {
      return {
        outcome: 'refused',
        reason: `Unable to create lane directory: ${mkdir.error ?? mkdir.stderr.trim()}`,
      };
    }
    // `tee` overwrites the target with exactly the bytes on stdin, so the
    // frozen brief stays byte-identical without any shell redirection.
    const proseWrite = await executor.run(['tee', prosePath], {
      input: request.proseMarkdown,
      timeoutMs: TEE_TIMEOUT_MS,
    });
    if (proseWrite.exitCode !== 0) {
      return {
        outcome: 'refused',
        reason: `Unable to place brief prose: ${proseWrite.error ?? proseWrite.stderr.trim()}`,
      };
    }
    const manifestWrite = await executor.run(['tee', manifestPath], {
      input: request.manifestJson,
      timeoutMs: TEE_TIMEOUT_MS,
    });
    if (manifestWrite.exitCode !== 0) {
      return {
        outcome: 'refused',
        reason: `Unable to place brief manifest: ${manifestWrite.error ?? manifestWrite.stderr.trim()}`,
      };
    }
    return { outcome: 'placed', prosePath, manifestPath };
  }

  async collectCompletedAttemptArtifacts(
    request: CollectCompletedAttemptArtifactsRequest,
  ): Promise<CollectCompletedAttemptArtifactsResult> {
    if (request.completionReceipt.attemptId !== request.attemptId) {
      return { outcome: 'refused', reason: 'Completion receipt attemptId mismatch' };
    }

    const { worktreePath } = request;
    const executor = this.executorFor(request.recordedHost);
    let headCommit: string;
    try {
      headCommit = (await this.runGit(worktreePath, ['rev-parse', 'HEAD'], executor)).trim();
    } catch (error) {
      throw new Error(`Unable to read HEAD commit in ${worktreePath}: ${String(error)}`, {
        cause: error,
      });
    }

    let commitsSinceBase: string[];
    try {
      const stdout = await this.runGit(worktreePath, [
        'rev-list',
        `${request.baseCommit}..HEAD`,
      ], executor);
      commitsSinceBase = stdout.split('\n').filter((line) => line.trim() !== '');
    } catch (error) {
      throw new Error(
        `Unable to list commits since base ${request.baseCommit} in ${worktreePath}: ${String(error)}`,
        { cause: error },
      );
    }

    const notesPath = path.join(worktreePath, '.lane', 'notes.md');
    const notesExists = await this.pathExists(worktreePath, notesPath, executor);
    const notes: 'present' | 'missing' = notesExists ? 'present' : 'missing';

    const candidateArtifactPaths = [
      ...request.expectedArtifactPaths,
      ...(notes === 'present' ? ['.lane/notes.md'] : []),
    ];
    const collectedArtifactPaths: string[] = [];
    const seenPaths = new Set<string>();
    for (const artifactPath of candidateArtifactPaths) {
      if (seenPaths.has(artifactPath)) continue;
      seenPaths.add(artifactPath);
      // Every caller-supplied expected-artifact path is contained here: an
      // absolute or escaping entry is refused before any probe runs.
      const exists = await this.pathExists(
        worktreePath,
        resolveWorktreeTarget(worktreePath, artifactPath),
        executor,
      );
      if (exists) collectedArtifactPaths.push(artifactPath);
    }

    return {
      outcome: 'collected',
      artifacts: { headCommit, commitsSinceBase, collectedArtifactPaths, notes },
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

  /** Exit 0 means ignored; exit 1 means not ignored; anything else is an error. */
  private async checkIgnored(worktreePath: string, candidatePath: string): Promise<boolean> {
    const executor = this.executorFor();
    const result = await executor.run(
      [
        'git',
        '-C',
        worktreePath,
        'check-ignore',
        '-q',
        '--',
        candidatePath,
      ],
      { timeoutMs: GIT_TIMEOUT_MS },
    );
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new Error(
      `git check-ignore failed for ${candidatePath} in ${worktreePath}: exit ${String(result.exitCode)}` +
        (result.error !== undefined ? ` (${result.error})` : ''),
    );
  }

  async readBriefManifest(
    worktreePath: string,
    manifestPath?: string,
    recordedHost?: AttemptRunnerRecord | null,
  ): Promise<string | null> {
    // The manifest path — the caller-supplied one or the `.lane` default —
    // is contained here, so an absolute or escaping path is refused before
    // any `cat` runs.
    const targetPath = resolveWorktreeTarget(
      worktreePath,
      manifestPath ?? '.lane/brief-manifest.json',
    );
    const executor = this.executorFor(recordedHost);
    const result = await executor.run(['cat', targetPath], { timeoutMs: CAT_TIMEOUT_MS });
    // A null exit code (spawn failure, timeout) is a failed read, not an
    // absent manifest; only exit 1 and friends mean "no such file".
    if (result.exitCode === null) {
      throw new Error(
        `Unable to read ${targetPath}` + (result.error !== undefined ? `: ${result.error}` : ''),
      );
    }
    return result.exitCode === 0 ? result.stdout : null;
  }
}
