// @generated adapter scaffold — implemented for migration step 2 (reviewed git subprocesses).
/**
 * WorkspaceAdapter implements WorkspacePort. It inspects a Git worktree as a
 * typed record through reviewed `git` subprocesses without modifying the
 * worktree: no resets, no checkouts, no cleanup. Unreadable state is an
 * error, never a silent guess.
 *
 * The worktree may live on another host (the orchestrator runs `git` and
 * `ocm-run` locally while `/mnt/pool/...` is mounted on `midnight`). With an
 * `sshHost` configured and the path absent locally, the same reviewed
 * read-only git commands run over `ssh` instead.
 */

import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

import type {
  WorktreeInspection,
  WorktreeInspectionRequest,
  WorkspacePort,
} from '../../application/ports/out/WorkspacePort.out-port.js';
import type { CommandExecutorPort } from '../../application/ports/out/CommandExecutorPort.out-port.js';

const execFileAsync = promisify(execFile);

export interface WorkspaceAdapterOptions {
  /**
   * Executor owning the worktree's host commands. When set it is
   * authoritative: every git command, existence probe and file read runs
   * through it, locally or over the ssh transport the executor carries.
   */
  readonly executor?: CommandExecutorPort;
  /** Legacy direct seam: SSH host alias holding the worktree when it is not present locally. */
  readonly sshHost?: string;
}

/** Residue markers a previous attempt may have left in the worktree. */
const laneResidueFiles = ['.lane/brief.md', '.lane/brief-manifest.json', '.lane/notes.md'];

const SAFE_SSH_HOST_PATTERN = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+$/;

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

/** Single-quote one argument for the remote POSIX shell. */
function posixQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Strip porcelain v1 quoting around paths with special characters. */
function unquotePorcelainPath(porcelainPath: string): string {
  if (porcelainPath.startsWith('"') && porcelainPath.endsWith('"')) {
    return porcelainPath.slice(1, -1);
  }
  return porcelainPath;
}

export class WorkspaceAdapter implements WorkspacePort {
  constructor(private readonly options?: WorkspaceAdapterOptions) {}

  async inspectWorktree(request: WorktreeInspectionRequest): Promise<WorktreeInspection> {
    const { worktreePath, baseCommit } = request;

    if (this.options?.sshHost && !existsSync(worktreePath) && !isSafeSshHost(this.options.sshHost)) {
      throw new Error(
        `Unable to inspect worktree in ${worktreePath}: unsafe SSH host '${this.options.sshHost}'`,
      );
    }

    let checkedOutCommit: string;
    try {
      checkedOutCommit = (await this.runGit(worktreePath, ['rev-parse', 'HEAD'])).trim();
    } catch (error) {
      throw new Error(`Unable to read HEAD commit in ${worktreePath}: ${String(error)}`, {
        cause: error,
      });
    }

    let statusOutput: string;
    try {
      statusOutput = await this.runGit(worktreePath, ['status', '--porcelain=v1', '-uall']);
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
      if (await this.pathExists(worktreePath, residuePath)) residueFromEarlierAttempts.push(residueFile);
    }

    const missingExpectedArtifacts: string[] = [];
    for (const expectedPath of request.expectedArtifactPaths) {
      const absolutePath = path.join(worktreePath, expectedPath);
      if (!(await this.pathExists(worktreePath, absolutePath))) {
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

  async readWorktreeFile(worktreePath: string, relativePath: string): Promise<string | null> {
    const targetPath = path.isAbsolute(relativePath)
      ? relativePath
      : path.join(worktreePath, relativePath);
    if (this.options?.executor !== undefined) {
      const result = await this.options.executor.run(['cat', targetPath]);
      return result.exitCode === 0 ? result.stdout : null;
    }
    if (this.options?.sshHost && !existsSync(worktreePath) && !isSafeSshHost(this.options.sshHost)) {
      throw new Error(
        `Unable to read file in ${worktreePath}: unsafe SSH host '${this.options.sshHost}'`,
      );
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
