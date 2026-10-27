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

import { createHash, randomBytes } from 'node:crypto';
import * as path from 'node:path';

import type {
  AttemptArtifactPort,
  CollectCompletedAttemptArtifactsRequest,
  CollectCompletedAttemptArtifactsResult,
  PlaceFrozenBriefRequest,
  PlaceFrozenBriefResult,
  SealArtifactManifestRequest,
  SealArtifactManifestResult,
  VerifyArtifactManifestRequest,
  VerifyArtifactManifestResult,
  VerifyIgnoredPathsRequest,
  VerifyIgnoredPathsResult,
} from '../../application/ports/out/AttemptArtifactPort.out-port.js';
import type { CommandExecutorPort } from '../../application/ports/out/CommandExecutorPort.out-port.js';
import {
  artifactManifestRelativePath,
  artifactManifestTempRelativePath,
  buildArtifactManifest,
  compareArtifactManifest,
  parseArtifactManifest,
  serializeArtifactManifest,
  type ArtifactManifestEntry,
  type ObservedArtifact,
} from '../../domain/artifact-manifest.js';
import type { AttemptRunnerRecord } from '../../domain/execution-records.js';
import { validateWorktreeRelativePath } from '../../domain/worktree-path.js';
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

/** Wall-clock budget for one hash/size command (`wc`, `sha256sum`). */
const HASH_TIMEOUT_MS = 120 * 1000;

/** A valid SHA-256 hex digest: 64 lowercase hexadecimal characters. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Cryptographic SHA-256 hex digest injected by production composition roots. */
export function sha256HexDigest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

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
  private async checkIgnored(
    worktreePath: string,
    candidatePath: string,
    executor: CommandExecutorPort = this.executorFor(),
  ): Promise<boolean> {
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

  /**
   * Resolve the worktree's canonical path once on the target host via
   * `realpath -e -- <worktreePath>`.
   */
  private async resolveCanonicalWorktreePath(
    worktreePath: string,
    executor: CommandExecutorPort,
  ): Promise<string | null> {
    const result = await executor.run(['realpath', '-e', '--', worktreePath], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      return null;
    }
    const canonical = result.stdout.replace(/\r?\n$/, '');
    return canonical.startsWith('/') ? canonical : null;
  }

  /**
   * Probe whether a path is either absent (`test -e` false and `test -L`
   * false) or an existing regular file (`test -L` false and `test -f` true).
   */
  private async isAbsentOrRegularFile(
    targetPath: string,
    executor: CommandExecutorPort,
  ): Promise<boolean> {
    const [existsProbe, symlinkProbe] = await Promise.all([
      executor.run(['test', '-e', targetPath], { timeoutMs: PROBE_TIMEOUT_MS }),
      executor.run(['test', '-L', targetPath], { timeoutMs: PROBE_TIMEOUT_MS }),
    ]);
    if (
      (existsProbe.exitCode !== 0 && existsProbe.exitCode !== 1) ||
      (symlinkProbe.exitCode !== 0 && symlinkProbe.exitCode !== 1)
    ) {
      throw new Error(`Unable to probe ${targetPath}`);
    }
    if (symlinkProbe.exitCode === 0) {
      return false;
    }
    if (existsProbe.exitCode === 1) {
      return true;
    }
    const regularProbe = await executor.run(['test', '-f', targetPath], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (regularProbe.exitCode !== 0 && regularProbe.exitCode !== 1) {
      throw new Error(`Unable to probe ${targetPath}`);
    }
    return regularProbe.exitCode === 0;
  }

  /**
   * Measure one contained worktree-relative artifact path: an existence probe,
   * a regular-file probe, a canonical-path check (`realpath -e -- <path>` must
   * equal the worktree's canonical path plus the relative path, so symbolic
   * links in any path component are refused), a byte count and a SHA-256
   * digest, all through the same executor. Absent and non-regular results are
   * facts; a command failure is an error.
   */
  private async measureArtifact(
    worktreePath: string,
    canonicalWorktreePath: string,
    relativePath: string,
    executor: CommandExecutorPort,
  ): Promise<ObservedArtifact> {
    const target = resolveWorktreeTarget(worktreePath, relativePath);
    const exists = await this.pathExists(worktreePath, target, executor);
    if (!exists) {
      return { path: relativePath, state: 'absent' };
    }
    const symlinkProbe = await executor.run(['test', '-L', target], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (symlinkProbe.exitCode === 0) {
      return { path: relativePath, state: 'not-a-file' };
    }
    if (symlinkProbe.exitCode !== 1) {
      throw new Error(
        `Unable to probe ${target}: exit ${String(symlinkProbe.exitCode)}` +
          (symlinkProbe.error !== undefined ? `: ${symlinkProbe.error}` : ''),
      );
    }
    const regularProbe = await executor.run(['test', '-f', target], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (regularProbe.exitCode === 1) {
      return { path: relativePath, state: 'not-a-file' };
    }
    if (regularProbe.exitCode !== 0) {
      throw new Error(
        `Unable to probe ${target}: exit ${String(regularProbe.exitCode)}` +
          (regularProbe.error !== undefined ? `: ${regularProbe.error}` : ''),
      );
    }
    const canonicalProbe = await executor.run(['realpath', '-e', '--', target], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (canonicalProbe.exitCode !== 0) {
      return { path: relativePath, state: 'not-a-file' };
    }
    const canonicalTarget = canonicalProbe.stdout.replace(/\r?\n$/, '');
    const expectedCanonical = resolveWorktreeTarget(canonicalWorktreePath, relativePath);
    if (canonicalTarget !== expectedCanonical) {
      return { path: relativePath, state: 'not-a-file' };
    }
    const sizeRun = await executor.run(['wc', '-c', target], {
      timeoutMs: HASH_TIMEOUT_MS,
    });
    if (sizeRun.exitCode !== 0) {
      throw new Error(
        'Unable to measure ' + target + ': exit ' + String(sizeRun.exitCode) +
          (sizeRun.error !== undefined ? ': ' + sizeRun.error : ''),
      );
    }
    const size = Number(sizeRun.stdout.trim().split(/\s+/)[0]);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error('Unable to read size of ' + target);
    }
    const digestRun = await executor.run(['sha256sum', target], {
      timeoutMs: HASH_TIMEOUT_MS,
    });
    if (digestRun.exitCode !== 0) {
      throw new Error(
        'Unable to measure ' + target + ': exit ' + String(digestRun.exitCode) +
          (digestRun.error !== undefined ? ': ' + digestRun.error : ''),
      );
    }
    let digestText = digestRun.stdout.trim();
    if (digestText.startsWith('\\')) {
      digestText = digestText.slice(1);
    }
    const sha256 = digestText.slice(0, 64);
    if (!SHA256_HEX.test(sha256)) {
      throw new Error('Unable to read digest of ' + target);
    }
    return { path: relativePath, state: 'file', size, sha256 };
  }

  /**
   * One contained worktree-relative file read. The caller resolves the
   * target path with `resolveWorktreeTarget` first, so an absolute or
   * escaping path is refused before any `cat` runs. A null exit code
   * (spawn failure, timeout) is a failed read, not an absent file; only
   * exit 1 and friends mean "no such file".
   */
  private async readContainedFile(
    worktreePath: string,
    targetPath: string,
    recordedHost?: AttemptRunnerRecord | null,
  ): Promise<string | null> {
    const executor = this.executorFor(recordedHost);
    const result = await executor.run(['cat', targetPath], { timeoutMs: CAT_TIMEOUT_MS });
    if (result.exitCode === null) {
      throw new Error(
        `Unable to read ${targetPath}` + (result.error !== undefined ? `: ${result.error}` : ''),
      );
    }
    return result.exitCode === 0 ? result.stdout : null;
  }

  /**
   * Write the attempt's content-addressed artifact manifest atomically
   * (unique temp file, then `mv`) and read it back, and only then report
   * `sealed`. The manifest paths must be gitignored; every listed artifact
   * must be a regular file inside the canonical worktree at sealing.
   */
  async sealArtifactManifest(request: SealArtifactManifestRequest): Promise<SealArtifactManifestResult> {
    const rootRefusal = worktreeRootRefusal(request.worktreePath);
    if (rootRefusal !== null) {
      return { outcome: 'refused', reason: rootRefusal };
    }
    for (const artifactPath of request.artifactPaths) {
      const refusedReason = validateWorktreeRelativePath(artifactPath);
      if (refusedReason !== null) {
        return {
          outcome: 'refused',
          reason: `artifact path '${artifactPath}' is refused: ${refusedReason}`,
        };
      }
    }
    const executor = this.executorFor(request.recordedHost);
    const canonicalWorktreePath = await this.resolveCanonicalWorktreePath(
      request.worktreePath,
      executor,
    );
    if (canonicalWorktreePath === null) {
      return {
        outcome: 'refused',
        reason: `Unable to resolve canonical worktree path for ${request.worktreePath}`,
      };
    }
    const uniquePaths = [...new Set(request.artifactPaths)];
    const observed = await Promise.all(
      uniquePaths.map((p) =>
        this.measureArtifact(request.worktreePath, canonicalWorktreePath, p, executor),
      ),
    );
    for (const observation of observed) {
      if (observation.state === 'absent') {
        return { outcome: 'refused', reason: `artifact '${observation.path}' is absent at sealing` };
      }
      if (observation.state === 'not-a-file') {
        return {
          outcome: 'refused',
          reason: `artifact '${observation.path}' is not a regular file and cannot be sealed`,
        };
      }
    }
    const entries: ArtifactManifestEntry[] = observed
      .filter((o): o is Extract<ObservedArtifact, { state: 'file' }> => o.state === 'file')
      .map((o) => ({ path: o.path, size: o.size, sha256: o.sha256 }));
    const manifest = buildArtifactManifest(request.attemptId, entries);
    const text = serializeArtifactManifest(manifest);
    const manifestSha256 = sha256HexDigest(text);
    const manifestRelativePath = artifactManifestRelativePath(manifestSha256);
    const tempRelativePath = artifactManifestTempRelativePath(
      manifestRelativePath,
      randomBytes(4).toString('hex'),
    );
    const finalPath = resolveWorktreeTarget(request.worktreePath, manifestRelativePath);
    const tempPath = resolveWorktreeTarget(request.worktreePath, tempRelativePath);
    const laneDir = path.dirname(finalPath);
    const mkdir = await executor.run(['mkdir', '-p', laneDir], {
      timeoutMs: BRIEF_WRITE_TIMEOUT_MS,
    });
    if (mkdir.exitCode !== 0) {
      return {
        outcome: 'refused',
        reason: `Unable to create lane directory: ${mkdir.error ?? mkdir.stderr.trim()}`,
      };
    }
    const [laneDirProbe, laneLinkProbe] = await Promise.all([
      executor.run(['test', '-d', laneDir], { timeoutMs: PROBE_TIMEOUT_MS }),
      executor.run(['test', '-L', laneDir], { timeoutMs: PROBE_TIMEOUT_MS }),
    ]);
    if (laneDirProbe.exitCode !== 0 || laneLinkProbe.exitCode !== 1) {
      return {
        outcome: 'refused',
        reason: 'Lane directory .lane must be a real directory and not a symbolic link',
      };
    }
    // After the .lane check: git check-ignore exits 128 for a path beyond a symlink,
    // which must be a refusal, not an error.
    const ignored = await Promise.all(
      [manifestRelativePath, tempRelativePath].map((p) =>
        this.checkIgnored(request.worktreePath, p, executor),
      ),
    );
    if (ignored.some((value) => !value)) {
      return { outcome: 'refused', reason: 'Artifact manifest paths are not gitignored' };
    }
    const [tempAllowed, finalAllowed] = await Promise.all([
      this.isAbsentOrRegularFile(tempPath, executor),
      this.isAbsentOrRegularFile(finalPath, executor),
    ]);
    if (!tempAllowed || !finalAllowed) {
      return {
        outcome: 'refused',
        reason: 'Artifact manifest target or temp path is not a regular file',
      };
    }
    const write = await executor.run(['tee', tempPath], {
      input: text,
      timeoutMs: TEE_TIMEOUT_MS,
    });
    if (write.exitCode !== 0) {
      const detail = write.error !== undefined ? write.error : write.stderr.trim();
      await executor.run(['rm', '-f', tempPath], { timeoutMs: BRIEF_WRITE_TIMEOUT_MS });
      return { outcome: 'refused', reason: 'Unable to write artifact manifest: ' + detail };
    }
    const move = await executor.run(['mv', '-f', tempPath, finalPath], {
      timeoutMs: BRIEF_WRITE_TIMEOUT_MS,
    });
    if (move.exitCode !== 0) {
      const detail = move.error !== undefined ? move.error : move.stderr.trim();
      await executor.run(['rm', '-f', tempPath], { timeoutMs: BRIEF_WRITE_TIMEOUT_MS });
      return { outcome: 'refused', reason: 'Unable to move artifact manifest into place: ' + detail };
    }
    const readBack = await this.readContainedFile(request.worktreePath, finalPath, request.recordedHost);
    if (readBack !== text) {
      return { outcome: 'refused', reason: 'Artifact manifest read-back differs from what was written' };
    }
    return {
      outcome: 'sealed',
      manifestPath: manifestRelativePath,
      manifestSha256,
      manifest,
    };
  }

  /**
   * Re-hash every file the manifest lists and compare against the sealed
   * manifest. Answers `sealed`, `missing` (no manifest at all: `test -e`
   * false and `test -L` false) or `mismatch`; a non-regular file, symlink,
   * read failure or unparseable manifest is `manifest-invalid`, and a rewrite
   * of the manifest itself (digest differs from the recorded one) is
   * `manifest-changed`.
   */
  async verifyArtifactManifest(
    request: VerifyArtifactManifestRequest & { readonly manifestPath?: string },
  ): Promise<VerifyArtifactManifestResult> {
    const rootRefusal = worktreeRootRefusal(request.worktreePath);
    if (rootRefusal !== null) {
      throw new Error(rootRefusal);
    }
    const executor = this.executorFor(request.recordedHost);
    const manifestRelativePath =
      request.manifestPath ?? artifactManifestRelativePath(request.expectedManifestSha256);
    const targetPath = resolveWorktreeTarget(request.worktreePath, manifestRelativePath);
    // Same containment as sealing: a symlinked .lane would let cat read a manifest from
    // outside the worktree, so it is never a valid manifest location.
    const laneLinkProbe = await executor.run(['test', '-L', path.dirname(targetPath)], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (laneLinkProbe.exitCode !== 1) {
      return {
        outcome: 'mismatch',
        mismatches: [{ path: manifestRelativePath, kind: 'manifest-invalid' }],
      };
    }
    const [existsProbe, symlinkProbe] = await Promise.all([
      executor.run(['test', '-e', targetPath], { timeoutMs: PROBE_TIMEOUT_MS }),
      executor.run(['test', '-L', targetPath], { timeoutMs: PROBE_TIMEOUT_MS }),
    ]);
    if (
      (existsProbe.exitCode !== 0 && existsProbe.exitCode !== 1) ||
      (symlinkProbe.exitCode !== 0 && symlinkProbe.exitCode !== 1)
    ) {
      return {
        outcome: 'mismatch',
        mismatches: [{ path: manifestRelativePath, kind: 'manifest-invalid' }],
      };
    }
    if (existsProbe.exitCode === 1 && symlinkProbe.exitCode === 1) {
      return { outcome: 'missing' };
    }
    if (symlinkProbe.exitCode === 0) {
      return {
        outcome: 'mismatch',
        mismatches: [{ path: manifestRelativePath, kind: 'manifest-invalid' }],
      };
    }
    const regularProbe = await executor.run(['test', '-f', targetPath], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (regularProbe.exitCode !== 0) {
      return {
        outcome: 'mismatch',
        mismatches: [{ path: manifestRelativePath, kind: 'manifest-invalid' }],
      };
    }
    const readResult = await executor.run(['cat', targetPath], { timeoutMs: CAT_TIMEOUT_MS });
    if (readResult.exitCode !== 0) {
      return {
        outcome: 'mismatch',
        mismatches: [{ path: manifestRelativePath, kind: 'manifest-invalid' }],
      };
    }
    const text = readResult.stdout;
    if (
      request.expectedManifestSha256 !== undefined &&
      sha256HexDigest(text) !== request.expectedManifestSha256
    ) {
      return {
        outcome: 'mismatch',
        mismatches: [{ path: manifestRelativePath, kind: 'manifest-changed' }],
      };
    }
    const parsed = parseArtifactManifest(text);
    if (parsed === null) {
      return {
        outcome: 'mismatch',
        mismatches: [{ path: manifestRelativePath, kind: 'manifest-invalid' }],
      };
    }
    if (parsed.attemptId !== request.attemptId) {
      return {
        outcome: 'mismatch',
        mismatches: [{ path: manifestRelativePath, kind: 'attempt-id' }],
      };
    }
    const canonicalWorktreePath = await this.resolveCanonicalWorktreePath(
      request.worktreePath,
      executor,
     );
    if (canonicalWorktreePath === null) {
      return {
        outcome: 'mismatch',
        mismatches: [{ path: manifestRelativePath, kind: 'manifest-invalid' }],
      };
    }
    const observed = await Promise.all(
      parsed.files.map((f) =>
        this.measureArtifact(request.worktreePath, canonicalWorktreePath, f.path, executor),
      ),
    );
    return compareArtifactManifest(parsed, observed);
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
    return this.readContainedFile(worktreePath, targetPath, recordedHost);
  }

  async readBriefFile(
    worktreePath: string,
    relativePath: string,
    recordedHost?: AttemptRunnerRecord | null,
  ): Promise<string | null> {
    // The prose path — the caller-supplied brief package path — is contained
    // here with the same rule as the manifest, so an absolute or escaping
    // path is refused before any `cat` runs.
    const targetPath = resolveWorktreeTarget(worktreePath, relativePath);
    return this.readContainedFile(worktreePath, targetPath, recordedHost);
  }
}
