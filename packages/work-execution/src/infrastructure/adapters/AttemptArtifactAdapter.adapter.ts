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

const execFileAsync = promisify(execFile);

export interface AttemptArtifactAdapterOptions {
  /** SSH host alias holding the worktree when it is not present locally. */
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
      await execFileAsync('ssh', [sshHost, command]);
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
    return this.options?.sshHost && !existsSync(worktreePath) ? this.options.sshHost : null;
  }

  /** Read-only git in the worktree, locally or through the reviewed ssh host. */
  private async runGit(worktreePath: string, args: readonly string[]): Promise<string> {
    const sshHost = this.useRemote(worktreePath);
    if (sshHost === null) {
      const { stdout } = await execFileAsync('git', ['-C', worktreePath, ...args]);
      return stdout;
    }
    const remoteCommand = ['git', '-C', worktreePath, ...args].map(posixQuote).join(' ');
    const { stdout } = await execFileAsync('ssh', [sshHost, remoteCommand]);
    return stdout;
  }

  /** Existence of one absolute path in the worktree's filesystem. */
  private async pathExists(worktreePath: string, targetPath: string): Promise<boolean> {
    const sshHost = this.useRemote(worktreePath);
    if (sshHost === null) {
      return fs
        .stat(targetPath)
        .then(() => true)
        .catch(() => false);
    }
    try {
      await execFileAsync('ssh', [sshHost, `test -e ${posixQuote(targetPath)}`]);
      return true;
    } catch {
      return false;
    }
  }

  /** Exit 0 means ignored; exit 1 means not ignored; anything else is an error. */
  private async checkIgnored(worktreePath: string, candidatePath: string): Promise<boolean> {
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
      await execFileAsync('ssh', [sshHost, remoteCommand]);
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
}
