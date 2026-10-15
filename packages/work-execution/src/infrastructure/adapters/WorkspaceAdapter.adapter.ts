// @generated adapter scaffold — implemented for migration step 2 (reviewed git subprocesses).
/**
 * WorkspaceAdapter implements WorkspacePort. It inspects a Git worktree as a
 * typed record through reviewed `git` subprocesses without modifying the
 * worktree: no resets, no checkouts, no cleanup. Unreadable state is an
 * error, never a silent guess.
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

import type {
  WorktreeInspection,
  WorktreeInspectionRequest,
  WorkspacePort,
} from '../../application/ports/out/WorkspacePort.out-port.js';

const execFileAsync = promisify(execFile);

/** Residue markers a previous attempt may have left in the worktree. */
const laneResidueFiles = ['.lane/brief.md', '.lane/brief-manifest.json', '.lane/notes.md'];

/** Strip porcelain v1 quoting around paths with special characters. */
function unquotePorcelainPath(porcelainPath: string): string {
  if (porcelainPath.startsWith('"') && porcelainPath.endsWith('"')) {
    return porcelainPath.slice(1, -1);
  }
  return porcelainPath;
}

export class WorkspaceAdapter implements WorkspacePort {
  async inspectWorktree(request: WorktreeInspectionRequest): Promise<WorktreeInspection> {
    const { worktreePath, baseCommit } = request;

    let checkedOutCommit: string;
    try {
      const { stdout } = await execFileAsync('git', ['-C', worktreePath, 'rev-parse', 'HEAD']);
      checkedOutCommit = stdout.trim();
    } catch (error) {
      throw new Error(`Unable to read HEAD commit in ${worktreePath}: ${String(error)}`, {
        cause: error,
      });
    }

    let statusOutput: string;
    try {
      const { stdout } = await execFileAsync('git', [
        '-C',
        worktreePath,
        'status',
        '--porcelain=v1',
        '-uall',
      ]);
      statusOutput = stdout;
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
      const exists = await fs
        .stat(residuePath)
        .then(() => true)
        .catch(() => false);
      if (exists) residueFromEarlierAttempts.push(residueFile);
    }

    const missingExpectedArtifacts: string[] = [];
    for (const expectedPath of request.expectedArtifactPaths) {
      const absolutePath = path.join(worktreePath, expectedPath);
      const exists = await fs
        .stat(absolutePath)
        .then(() => true)
        .catch(() => false);
      if (!exists) missingExpectedArtifacts.push(expectedPath);
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
}
