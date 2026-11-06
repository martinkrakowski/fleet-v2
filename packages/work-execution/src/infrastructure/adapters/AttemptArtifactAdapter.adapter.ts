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
  ArtifactManifestRemovalCheckResult,
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
import type { CommandRunResult } from '../../application/ports/out/CommandExecutorPort.out-port.js';
import {
  MAX_ARTIFACT_MANIFEST_CHARS,
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
import { snapshotPlainDataRecord } from '../../domain/plain-record-reads.js';
import { validateWorktreeRelativePath } from '../../domain/worktree-path.js';
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
   * H9b2. When given, a request carrying a recorded runner block (reads,
   * brief placement, manifest sealing, worktree prepare and commit) goes
   * through this helper, which confirms a named host, resolves an alias-only
   * record through the installation or refuses it (D2), and keeps the legacy
   * executor otherwise. A request with no recorded block (manual prepare)
   * keeps `executor`.
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

/** A valid content-addressed artifact manifest worktree-relative path. */
const MANIFEST_PATH_PATTERN = /^\.lane\/artifacts-manifest-[0-9a-f]{16}\.json$/;

/** KF-33a: a commit id this diff accepts — 40 or 64 lowercase hexadecimal characters. */
const COMMIT_HEX = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Applied to every git command: the hardening overrides — no fsmonitor and no
 * repository hooks — so a lane-modified `.git/config` cannot execute commands
 * during ignored-path checks or artifact collection.
 */
const GIT_HARDENING: readonly string[] = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
];

/** Cryptographic SHA-256 hex digest injected by production composition roots. */
export function sha256HexDigest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export class AttemptArtifactAdapter implements AttemptArtifactPort {
  constructor(private readonly options?: AttemptArtifactAdapterOptions) {}

  /**
   * When given, a request carrying a recorded runner block (reads, brief
   * placement, manifest sealing, worktree prepare and commit) goes through
   * this helper, which confirms a named host, resolves an alias-only record
   * through the installation or refuses it (D2), and keeps the legacy
   * executor otherwise. A request with no recorded block (manual prepare)
   * keeps `executor`. The executor is the only transport; without one there
   * is nothing to run.
   */
  private executorFor(
    recordedHost?: AttemptRunnerRecord | null,
  ): CommandExecutorPort {
    if (
      this.options?.executorForRecordedHost !== undefined &&
      recordedHost !== null &&
      recordedHost !== undefined
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
    // The check runs through the same executor as the writes: with a
    // recorded host the worktree lives on that host, so the git check-ignore
    // must run there too; without one (manual prepare) it keeps the
    // configured executor.
    const executor = this.executorFor(request.recordedHost);
    const offendingPaths: string[] = [];
    for (const candidatePath of request.candidatePaths) {
      const ignored = await this.checkIgnored(request.worktreePath, candidatePath, executor);
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
    const executor = this.executorFor(request.recordedHost);
    const briefTargets = ['.lane/brief.md', '.lane/brief-manifest.json'];
    // The ignored-path check runs through the same executor as the writes:
    // with a recorded host the placement resolves, the worktree lives on
    // that host, so the git check-ignore must run there too.
    const offendingPaths: string[] = [];
    for (const briefTarget of briefTargets) {
      if (!(await this.checkIgnored(request.worktreePath, briefTarget, executor))) {
        offendingPaths.push(briefTarget);
      }
    }
    if (offendingPaths.length > 0) {
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
    // A recorded host the helper refuses is a deterministic refusal, not a
    // transport failure: answer a typed refusal so the conductor journals
    // `collect-refused` instead of re-running the same throw on every pass.
    let executor: CommandExecutorPort;
    try {
      executor = this.executorFor(request.recordedHost);
    } catch (error) {
      return { outcome: 'refused', reason: error instanceof Error ? error.message : String(error) };
    }
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
    const result = await executor.run(
      ['git', '-C', worktreePath, ...GIT_HARDENING, ...args],
      {
        timeoutMs: GIT_TIMEOUT_MS,
      },
    );
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
        ...GIT_HARDENING,
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
   * `realpath -- <worktreePath>`.
   */
  private async resolveCanonicalWorktreePath(
    worktreePath: string,
    executor: CommandExecutorPort,
  ): Promise<string | null> {
    const result = await executor.run(['realpath', '--', worktreePath], {
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
   * a regular-file probe, a canonical-path check (`realpath -- <path>` must
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
    const canonicalProbe = await executor.run(['realpath', '--', target], {
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
    request: VerifyArtifactManifestRequest,
  ): Promise<VerifyArtifactManifestResult> {
    const rootRefusal = worktreeRootRefusal(request.worktreePath);
    if (rootRefusal !== null) {
      throw new Error(rootRefusal);
    }
    if (
      request.manifestPath !== undefined &&
      !MANIFEST_PATH_PATTERN.test(request.manifestPath)
    ) {
      return {
        outcome: 'mismatch',
        mismatches: [{ path: request.manifestPath, kind: 'manifest-invalid' }],
      };
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

  /**
   * C2': the executor for one removal check. Unlike `executorFor` this never
   * throws and never falls back from a refused recorded host to the local
   * executor: a recorded host that cannot resolve leaves the check unknown,
   * because a missing remote answer is not a missing manifest.
   */
  private removalExecutorFor(
    recordedHost?: AttemptRunnerRecord | null,
  ): CommandExecutorPort | null {
    try {
      if (
        this.options?.executorForRecordedHost !== undefined &&
        recordedHost !== null &&
        recordedHost !== undefined
      ) {
        const resolved = this.options.executorForRecordedHost(recordedHost);
        if (!resolved.ok) {
          return null;
        }
        return resolved.executor;
      }
      return this.options?.executor ?? null;
    } catch {
      return null;
    }
  }

  /**
   * C2': the fail-closed removal check of one sealed artifact manifest. Every
   * executor call runs inside `try/catch` with an explicit budget and a
   * bounded output buffer; nothing throws, no reason ever embeds a path or
   * stderr, and an unanswered probe is `unknown` — never missing, never
   * sealed.
   */
  async checkArtifactManifestForRemoval(
    request: VerifyArtifactManifestRequest,
  ): Promise<ArtifactManifestRemovalCheckResult> {
    // 1. Snapshot the request without running any getter; a non-object, a
    //    malformed field or an unreadable shape is a mismatch, not a throw.
    let snap: Record<string, unknown> | null;
    try {
      snap = snapshotPlainDataRecord(request);
    } catch {
      snap = null;
    }
    const invalid: ArtifactManifestRemovalCheckResult = {
      outcome: 'mismatch',
      mismatches: [{ path: '', kind: 'manifest-invalid' }],
    };
    if (snap === null) {
      return invalid;
    }
    const attemptId = snap['attemptId'];
    const worktreePath = snap['worktreePath'];
    const manifestPath = snap['manifestPath'];
    const expectedManifestSha256 = snap['expectedManifestSha256'];
    if (
      typeof attemptId !== 'string' ||
      attemptId.length === 0 ||
      attemptId.length > 128 ||
      attemptId.includes('/') ||
      attemptId.includes('\0')
    ) {
      return invalid;
    }
    if (
      typeof worktreePath !== 'string' ||
      worktreePath.length > 4096 ||
      worktreeRootRefusal(worktreePath) !== null
    ) {
      return invalid;
    }
    if (
      (manifestPath !== undefined && manifestPath !== null && typeof manifestPath !== 'string') ||
      (expectedManifestSha256 !== undefined &&
        expectedManifestSha256 !== null &&
        typeof expectedManifestSha256 !== 'string')
    ) {
      return invalid;
    }
    const manifestRelativePath =
      typeof manifestPath === 'string' && manifestPath !== ''
        ? manifestPath
        : artifactManifestRelativePath(
            typeof expectedManifestSha256 === 'string' ? expectedManifestSha256 : undefined,
          );
    if (!MANIFEST_PATH_PATTERN.test(manifestRelativePath)) {
      return invalid;
    }
    if (
      expectedManifestSha256 !== undefined &&
      expectedManifestSha256 !== null &&
      !(typeof expectedManifestSha256 === 'string' && SHA256_HEX.test(expectedManifestSha256))
    ) {
      return invalid;
    }
    // 2. The recorded host is the truth; an unresolvable one stays unknown.
    const executor = this.removalExecutorFor(
      snap['recordedHost'] as AttemptRunnerRecord | null | undefined,
    );
    if (executor === null) {
      return { outcome: 'unknown', reason: 'no-executor-for-recorded-host' };
    }
    // 3. Probe the manifest with bounded, answered-or-unknown subprocesses.
    const targetPath = resolveWorktreeTarget(worktreePath, manifestRelativePath);
    const laneLinkProbe = await this.boundedRun(
      executor,
      ['test', '-L', path.dirname(targetPath)],
      PROBE_TIMEOUT_MS,
      65_536,
    );
    if (laneLinkProbe === null) {
      return { outcome: 'unknown', reason: 'lane-dir-probe-unreadable' };
    }
    if (laneLinkProbe.exitCode === null || laneLinkProbe.error !== undefined) {
      return { outcome: 'unknown', reason: 'lane-dir-probe-unreadable' };
    }
    if (laneLinkProbe.exitCode !== 0 && laneLinkProbe.exitCode !== 1) {
      return { outcome: 'unknown', reason: 'lane-dir-probe-unreadable' };
    }
    if (laneLinkProbe.exitCode === 0) {
      return invalid;
    }
    let existsProbe: CommandRunResult;
    let symlinkProbe: CommandRunResult;
    try {
      [existsProbe, symlinkProbe] = await Promise.all([
        executor.run(['test', '-e', targetPath], { timeoutMs: PROBE_TIMEOUT_MS, maxBufferBytes: 65_536 }),
        executor.run(['test', '-L', targetPath], { timeoutMs: PROBE_TIMEOUT_MS, maxBufferBytes: 65_536 }),
      ]);
    } catch {
      return { outcome: 'unknown', reason: 'manifest-probe-unreadable' };
    }
    if (
      (existsProbe.exitCode === null || existsProbe.error !== undefined || (existsProbe.exitCode !== 0 && existsProbe.exitCode !== 1)) ||
      (symlinkProbe.exitCode === null || symlinkProbe.error !== undefined || (symlinkProbe.exitCode !== 0 && symlinkProbe.exitCode !== 1))
    ) {
      return { outcome: 'unknown', reason: 'manifest-probe-unreadable' };
    }
    if (existsProbe.exitCode === 1 && symlinkProbe.exitCode === 1) {
      return { outcome: 'missing' };
    }
    if (symlinkProbe.exitCode === 0) {
      return invalid;
    }
    const regularProbe = await this.boundedRun(
      executor,
      ['test', '-f', targetPath],
      PROBE_TIMEOUT_MS,
      65_536,
    );
    if (regularProbe === null) {
      return { outcome: 'unknown', reason: 'manifest-regular-probe-unreadable' };
    }
    if (regularProbe.exitCode === null || regularProbe.error !== undefined) {
      return { outcome: 'unknown', reason: 'manifest-regular-probe-unreadable' };
    }
    if (regularProbe.exitCode !== 0 && regularProbe.exitCode !== 1) {
      return { outcome: 'unknown', reason: 'manifest-regular-probe-unreadable' };
    }
    if (regularProbe.exitCode === 1) {
      return invalid;
    }
    // 4. Size first, so an oversized manifest is refused without reading it.
    const sizeRun = await this.boundedRun(executor, ['wc', '-c', targetPath], HASH_TIMEOUT_MS, 65_536);
    if (sizeRun === null) {
      return { outcome: 'unknown', reason: 'manifest-size-unreadable' };
    }
    if (sizeRun.exitCode === null || sizeRun.error !== undefined || sizeRun.exitCode !== 0) {
      return { outcome: 'unknown', reason: 'manifest-size-unreadable' };
    }
    const byteCount = Number(sizeRun.stdout.trim().split(/\s+/)[0]);
    if (!Number.isSafeInteger(byteCount) || byteCount < 0) {
      return { outcome: 'unknown', reason: 'manifest-size-unreadable' };
    }
    if (byteCount > MAX_ARTIFACT_MANIFEST_CHARS) {
      return invalid;
    }
    const readResult = await this.boundedRun(
      executor,
      ['cat', targetPath],
      CAT_TIMEOUT_MS,
      MAX_ARTIFACT_MANIFEST_CHARS + 1024,
    );
    if (readResult === null) {
      return { outcome: 'unknown', reason: 'manifest-read-failed' };
    }
    if (readResult.exitCode !== 0 || readResult.error !== undefined) {
      return { outcome: 'unknown', reason: 'manifest-read-failed' };
    }
    const text = readResult.stdout;
    if (
      typeof expectedManifestSha256 === 'string' &&
      expectedManifestSha256 !== '' &&
      sha256HexDigest(text) !== expectedManifestSha256
    ) {
      return {
        outcome: 'mismatch',
        mismatches: [{ path: manifestRelativePath, kind: 'manifest-changed' }],
      };
    }
    const parsed = parseArtifactManifest(text);
    if (parsed === null) {
      return invalid;
    }
    if (parsed.attemptId !== attemptId) {
      return {
        outcome: 'mismatch',
        mismatches: [{ path: manifestRelativePath, kind: 'attempt-id' }],
      };
    }
    // 5. The canonical worktree path, then every listed file, bounded.
    let canonicalWorktreePath: string | null;
    try {
      canonicalWorktreePath = await this.resolveCanonicalWorktreePath(worktreePath, executor);
    } catch {
      canonicalWorktreePath = null;
    }
    if (canonicalWorktreePath === null) {
      return { outcome: 'unknown', reason: 'worktree-realpath-unreadable' };
    }
    const observed: ObservedArtifact[] = [];
    for (const entry of parsed.files) {
      const measured = await this.measureArtifactForRemoval(
        worktreePath,
        canonicalWorktreePath,
        entry.path,
        executor,
      );
      if (measured === 'unknown') {
        return { outcome: 'unknown', reason: 'artifact-probe-unreadable' };
      }
      observed.push(measured);
    }
    return compareArtifactManifest(parsed, observed);
  }

  /**
   * C2': one `executor.run` inside `try/catch`; a thrown rejection (transport
   * failure) is a null answer the caller reports as unknown, never a throw.
   */
  private async boundedRun(
    executor: CommandExecutorPort,
    argv: readonly string[],
    timeoutMs: number,
    maxBufferBytes: number,
  ): Promise<CommandRunResult | null> {
    try {
      return await executor.run(argv, { timeoutMs, maxBufferBytes });
    } catch {
      return null;
    }
  }

  /**
   * C2': measure one listed artifact with bounded probes. Answers
   * `'unknown'` when a probe fails to answer or errors, and a plain
   * `ObservedArtifact` for the genuine facts (absent, not-a-file, measured).
   */
  private async measureArtifactForRemoval(
    worktreePath: string,
    canonicalWorktreePath: string,
    relativePath: string,
    executor: CommandExecutorPort,
  ): Promise<ObservedArtifact | 'unknown'> {
    const target = resolveWorktreeTarget(worktreePath, relativePath);
    const existsProbe = await this.boundedRun(executor, ['test', '-e', target], PROBE_TIMEOUT_MS, 65_536);
    if (existsProbe === null) {
      return 'unknown';
    }
    if (existsProbe.exitCode === null || existsProbe.error !== undefined) {
      return 'unknown';
    }
    if (existsProbe.exitCode !== 0 && existsProbe.exitCode !== 1) {
      return 'unknown';
    }
    if (existsProbe.exitCode === 1) {
      return { path: relativePath, state: 'absent' };
    }
    const symlinkProbe = await this.boundedRun(executor, ['test', '-L', target], PROBE_TIMEOUT_MS, 65_536);
    if (symlinkProbe === null) {
      return 'unknown';
    }
    if (symlinkProbe.exitCode === null || symlinkProbe.error !== undefined) {
      return 'unknown';
    }
    if (symlinkProbe.exitCode === 0) {
      return { path: relativePath, state: 'not-a-file' };
    }
    if (symlinkProbe.exitCode !== 1) {
      return 'unknown';
    }
    const regularProbe = await this.boundedRun(executor, ['test', '-f', target], PROBE_TIMEOUT_MS, 65_536);
    if (regularProbe === null) {
      return 'unknown';
    }
    if (regularProbe.exitCode === null || regularProbe.error !== undefined) {
      return 'unknown';
    }
    if (regularProbe.exitCode === 1) {
      return { path: relativePath, state: 'not-a-file' };
    }
    if (regularProbe.exitCode !== 0) {
      return 'unknown';
    }
    const canonicalProbe = await this.boundedRun(executor, ['realpath', '--', target], PROBE_TIMEOUT_MS, 65_536);
    if (canonicalProbe === null) {
      return 'unknown';
    }
    if (canonicalProbe.exitCode === null || canonicalProbe.error !== undefined) {
      return 'unknown';
    }
    if (canonicalProbe.exitCode !== 0) {
      return { path: relativePath, state: 'not-a-file' };
    }
    const canonicalTarget = canonicalProbe.stdout.replace(/\r?\n$/, '');
    const expectedCanonical = resolveWorktreeTarget(canonicalWorktreePath, relativePath);
    if (canonicalTarget !== expectedCanonical) {
      return { path: relativePath, state: 'not-a-file' };
    }
    const sizeRun = await this.boundedRun(executor, ['wc', '-c', target], HASH_TIMEOUT_MS, 65_536);
    if (
      sizeRun === null ||
      sizeRun.exitCode === null ||
      sizeRun.error !== undefined ||
      sizeRun.exitCode !== 0
    ) {
      return 'unknown';
    }
    const size = Number(sizeRun.stdout.trim().split(/\s+/)[0]);
    if (!Number.isSafeInteger(size) || size < 0) {
      return 'unknown';
    }
    const digestRun = await this.boundedRun(executor, ['sha256sum', target], HASH_TIMEOUT_MS, 65_536);
    if (
      digestRun === null ||
      digestRun.exitCode === null ||
      digestRun.error !== undefined ||
      digestRun.exitCode !== 0
    ) {
      return 'unknown';
    }
    let digestText = digestRun.stdout.trim();
    if (digestText.startsWith('\\')) {
      digestText = digestText.slice(1);
    }
    const sha256 = digestText.slice(0, 64);
    if (!SHA256_HEX.test(sha256)) {
      return 'unknown';
    }
    return { path: relativePath, state: 'file', size, sha256 };
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

  /**
   * KF-33a: the worktree-relative paths changed between the two commits.
   * A non-hex base or head is refused before any command runs; any throw —
   * including a non-zero git exit — is swallowed as null so callers fail
   * closed (every finding stays in scope), never rethrow.
   */
  async readChangedPaths(
    worktreePath: string,
    baseCommit: string,
    headCommit: string,
    recordedHost?: AttemptRunnerRecord | null,
  ): Promise<readonly string[] | null> {
    if (!COMMIT_HEX.test(baseCommit) || !COMMIT_HEX.test(headCommit)) {
      return null;
    }
    try {
      const stdout = await this.runGit(
        worktreePath,
        ['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', baseCommit, headCommit, '--'],
        this.executorFor(recordedHost),
      );
      return stdout.split('\0').slice(0, -1);
    } catch {
      return null;
    }
  }
}
