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

const execFileAsync = promisify(execFile);

export interface WorkspaceAdapterOptions {
  /** SSH host alias holding the worktree when it is not present locally. */
  readonly sshHost?: string;
}

/** Residue markers a previous attempt may have left in the worktree. */
const laneResidueFiles = ['.lane/brief.md', '.lane/brief-manifest.json', '.lane/notes.md'];

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
}
