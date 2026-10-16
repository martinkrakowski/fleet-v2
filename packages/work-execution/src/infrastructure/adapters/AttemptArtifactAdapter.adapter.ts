// @generated adapter scaffold — implemented for migration step 2 (verified ignored paths, bounded artifact collection).
/**
 * AttemptArtifactAdapter implements AttemptArtifactPort. Frozen briefs are
 * placed only under paths proven gitignored by the worktree's index, and
 * artifacts are collected only for a completion receipt bound to the attempt.
 * The collected record reports facts (missing notes included), never prose.
 *
 * The worktree may live on another host reachable over ssh; with an
 * `sshHost` configured and the path absent locally, the same reviewed
 * commands run remotely with the brief contents base64-encoded so no shell
 * ever interprets operator-authored prose.
 */

import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

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
import { isSafeSshHost } from './WorkspaceAdapter.adapter.js';

const execFileAsync = promisify(execFile);

export interface AttemptArtifactAdapterOptions {
  /**
   * Executor owning the worktree's host commands; authoritative when set.
   * Frozen brief bytes travel on the executor's stdin (`tee`), so no remote
   * shell ever sees operator-authored prose.
   */
  readonly executor?: CommandExecutorPort;
  /** Legacy direct seam: SSH host alias holding the worktree when it is not present locally. */
  readonly sshHost?: string;
}

/** Single-quote one argument for the remote POSIX shell. */
function posixQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export class AttemptArtifactAdapter implements AttemptArtifactPort {
  constructor(private readonly options?: AttemptArtifactAdapterOptions) {}

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
    if (this.options?.executor !== undefined) {
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
      const mkdir = await this.options.executor.run(['mkdir', '-p', laneDirectory]);
      if (mkdir.exitCode !== 0) {
        return {
          outcome: 'refused',
          reason: `Unable to create lane directory: ${mkdir.error ?? mkdir.stderr.trim()}`,
        };
      }
      // `tee` overwrites the target with exactly the bytes on stdin, so the
      // frozen brief stays byte-identical without any shell redirection.
      const proseWrite = await this.options.executor.run(['tee', prosePath], {
        input: request.proseMarkdown,
      });
      if (proseWrite.exitCode !== 0) {
        return {
          outcome: 'refused',
          reason: `Unable to place brief prose: ${proseWrite.error ?? proseWrite.stderr.trim()}`,
        };
      }
      const manifestWrite = await this.options.executor.run(['tee', manifestPath], {
        input: request.manifestJson,
      });
      if (manifestWrite.exitCode !== 0) {
        return {
          outcome: 'refused',
          reason: `Unable to place brief manifest: ${manifestWrite.error ?? manifestWrite.stderr.trim()}`,
        };
      }
      return { outcome: 'placed', prosePath, manifestPath };
    }
    if (this.options?.sshHost && !existsSync(request.worktreePath) && !isSafeSshHost(this.options.sshHost)) {
      return { outcome: 'refused', reason: `Refusing to place brief: unsafe SSH host '${this.options.sshHost}'` };
    }

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
    const sshHost = this.useRemote(request.worktreePath);
    if (sshHost === null) {
      await fs.mkdir(laneDirectory, { recursive: true });
      await fs.writeFile(prosePath, request.proseMarkdown, 'utf8');
      await fs.writeFile(manifestPath, request.manifestJson, 'utf8');
    } else {
      // Base64 keeps the frozen brief byte-identical and keeps every quote,
      // backtick and newline out of the remote shell's interpretation.
      const proseB64 = Buffer.from(request.proseMarkdown, 'utf8').toString('base64');
      const manifestB64 = Buffer.from(request.manifestJson, 'utf8').toString('base64');
      const command =
        `mkdir -p ${posixQuote(laneDirectory)} && ` +
        `printf '%s' ${posixQuote(proseB64)} | base64 -d > ${posixQuote(prosePath)} && ` +
        `printf '%s' ${posixQuote(manifestB64)} | base64 -d > ${posixQuote(manifestPath)}`;
      await execFileAsync('ssh', [sshHost, '--', command]);
    }
    return { outcome: 'placed', prosePath, manifestPath };
  }

  async collectCompletedAttemptArtifacts(
    request: CollectCompletedAttemptArtifactsRequest,
  ): Promise<CollectCompletedAttemptArtifactsResult> {
    if (this.options?.sshHost && !existsSync(request.worktreePath) && !isSafeSshHost(this.options.sshHost)) {
      return { outcome: 'refused', reason: `Refusing to collect artifacts: unsafe SSH host '${this.options.sshHost}'` };
    }

    if (request.completionReceipt.attemptId !== request.attemptId) {
      return { outcome: 'refused', reason: 'Completion receipt attemptId mismatch' };
    }

    const { worktreePath } = request;
    let headCommit: string;
    try {
      headCommit = (await this.runGit(worktreePath, ['rev-parse', 'HEAD'])).trim();
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
      ]);
      commitsSinceBase = stdout.split('\n').filter((line) => line.trim() !== '');
    } catch (error) {
      throw new Error(
        `Unable to list commits since base ${request.baseCommit} in ${worktreePath}: ${String(error)}`,
        { cause: error },
      );
    }

    const notesPath = path.join(worktreePath, '.lane', 'notes.md');
    const notesExists = await this.pathExists(worktreePath, notesPath);
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
      const exists = await this.pathExists(
        worktreePath,
        path.join(worktreePath, artifactPath),
      );
      if (exists) collectedArtifactPaths.push(artifactPath);
    }

    return {
      outcome: 'collected',
      artifacts: { headCommit, commitsSinceBase, collectedArtifactPaths, notes },
    };
  }

  /** Remote host alias when the worktree lives off-host, otherwise null. */
  private useRemote(worktreePath: string): string | null {
    if (!this.options?.sshHost || existsSync(worktreePath)) {
      return null;
    }
    if (!isSafeSshHost(this.options.sshHost)) {
      throw new Error(`Refusing to execute on unsafe SSH host: ${this.options.sshHost}`);
    }
    return this.options.sshHost;
  }

  /** Read-only git in the worktree, through the executor, the legacy ssh host, or locally. */
  private async runGit(worktreePath: string, args: readonly string[]): Promise<string> {
    if (this.options?.executor !== undefined) {
      const result = await this.options.executor.run(['git', '-C', worktreePath, ...args]);
      if (result.exitCode !== 0) {
        throw new Error(
          `git ${args.join(' ')} failed in ${worktreePath}: exit ${String(result.exitCode)}` +
            (result.stderr.trim() !== '' ? `: ${result.stderr.trim()}` : ''),
        );
      }
      return result.stdout;
    }
    const sshHost = this.useRemote(worktreePath);
    if (sshHost === null) {
      const { stdout } = await execFileAsync('git', ['-C', worktreePath, ...args]);
      return stdout;
    }
    const remoteCommand = ['git', '-C', worktreePath, ...args].map(posixQuote).join(' ');
    const { stdout } = await execFileAsync('ssh', [sshHost, '--', remoteCommand]);
    return stdout;
  }

  /** Existence of one absolute path in the worktree's filesystem. */
  private async pathExists(worktreePath: string, targetPath: string): Promise<boolean> {
    if (this.options?.executor !== undefined) {
      const result = await this.options.executor.run(['test', '-e', targetPath]);
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        throw new Error(
          `Unable to probe ${targetPath}: exit ${String(result.exitCode)}` +
            (result.error !== undefined ? `: ${result.error}` : ''),
        );
      }
      return result.exitCode === 0;
    }
    const sshHost = this.useRemote(worktreePath);
    if (sshHost === null) {
      return fs
        .stat(targetPath)
        .then(() => true)
        .catch(() => false);
    }
    const { stdout } = await execFileAsync('ssh', [
      sshHost,
      '--',
      `if test -e ${posixQuote(targetPath)}; then printf 1; else printf 0; fi`,
    ]);
    return stdout.trim() === '1';
  }

  /** Exit 0 means ignored; exit 1 means not ignored; anything else is an error. */
  private async checkIgnored(worktreePath: string, candidatePath: string): Promise<boolean> {
    if (this.options?.executor !== undefined) {
      const result = await this.options.executor.run([
        'git',
        '-C',
        worktreePath,
        'check-ignore',
        '-q',
        '--',
        candidatePath,
      ]);
      if (result.exitCode === 0) return true;
      if (result.exitCode === 1) return false;
      throw new Error(
        `git check-ignore failed for ${candidatePath} in ${worktreePath}: exit ${String(result.exitCode)}` +
          (result.error !== undefined ? ` (${result.error})` : ''),
      );
    }
    const sshHost = this.useRemote(worktreePath);
    if (sshHost === null) {
      try {
        await execFileAsync('git', ['-C', worktreePath, 'check-ignore', '-q', '--', candidatePath]);
        return true;
      } catch (error) {
        const exitCode = (error as { code?: number | string }).code;
        if (exitCode === 1) return false;
        throw new Error(
          `git check-ignore failed for ${candidatePath} in ${worktreePath}: exit ${String(exitCode)}`,
          { cause: error },
        );
      }
    }
    const remoteCommand = ['git', '-C', worktreePath, 'check-ignore', '-q', '--', candidatePath]
      .map(posixQuote)
      .join(' ');
    try {
      await execFileAsync('ssh', [sshHost, '--', remoteCommand]);
      return true;
    } catch (error) {
      const exitCode = (error as { code?: number | string }).code;
      if (exitCode === 1) return false;
      throw new Error(
        `git check-ignore failed for ${candidatePath} in ${worktreePath}: exit ${String(exitCode)}`,
        { cause: error },
      );
    }
  }

  async readBriefManifest(worktreePath: string, manifestPath?: string): Promise<string | null> {
    const targetPath = manifestPath ?? path.join(worktreePath, '.lane', 'brief-manifest.json');
    if (this.options?.executor !== undefined) {
      const result = await this.options.executor.run(['cat', targetPath]);
      return result.exitCode === 0 ? result.stdout : null;
    }
    if (this.options?.sshHost && !existsSync(worktreePath) && !isSafeSshHost(this.options.sshHost)) {
      throw new Error(`Refusing to read manifest: unsafe SSH host '${this.options.sshHost}'`);
    }
    const sshHost = this.useRemote(worktreePath);
    if (sshHost === null) {
      try {
        return await fs.readFile(targetPath, 'utf8');
      } catch {
        return null;
      }
    }
    try {
      const { stdout } = await execFileAsync('ssh', [
        sshHost,
        '--',
        `cat ${posixQuote(targetPath)}`,
      ]);
      return stdout;
    } catch {
      return null;
    }
  }
}
