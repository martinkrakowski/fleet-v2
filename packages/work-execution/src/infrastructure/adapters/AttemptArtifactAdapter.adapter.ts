// @generated adapter scaffold — implemented for migration step 2 (verified ignored paths, bounded artifact collection).
/**
 * AttemptArtifactAdapter implements AttemptArtifactPort. Frozen briefs are
 * placed only under paths proven gitignored by the worktree's index, and
 * artifacts are collected only for a completion receipt bound to the attempt.
 * The collected record reports facts (missing notes included), never prose.
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
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

export class AttemptArtifactAdapter implements AttemptArtifactPort {
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
    await fs.mkdir(laneDirectory, { recursive: true });
    await fs.writeFile(path.join(laneDirectory, 'brief.md'), request.proseMarkdown, 'utf8');
    await fs.writeFile(
      path.join(laneDirectory, 'brief-manifest.json'),
      request.manifestJson,
      'utf8',
    );
    return {
      outcome: 'placed',
      prosePath: path.join(request.worktreePath, '.lane', 'brief.md'),
      manifestPath: path.join(request.worktreePath, '.lane', 'brief-manifest.json'),
    };
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
      const { stdout } = await execFileAsync('git', ['-C', worktreePath, 'rev-parse', 'HEAD']);
      headCommit = stdout.trim();
    } catch (error) {
      throw new Error(`Unable to read HEAD commit in ${worktreePath}: ${String(error)}`, {
        cause: error,
      });
    }

    let commitsSinceBase: string[];
    try {
      const { stdout } = await execFileAsync('git', [
        '-C',
        worktreePath,
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
    const notesExists = await fs
      .stat(notesPath)
      .then(() => true)
      .catch(() => false);
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
      const exists = await fs
        .stat(path.join(worktreePath, artifactPath))
        .then(() => true)
        .catch(() => false);
      if (exists) collectedArtifactPaths.push(artifactPath);
    }

    return {
      outcome: 'collected',
      artifacts: { headCommit, commitsSinceBase, collectedArtifactPaths, notes },
    };
  }

  /** Exit 0 means ignored; exit 1 means not ignored; anything else is an error. */
  private async checkIgnored(worktreePath: string, candidatePath: string): Promise<boolean> {
    try {
      await execFileAsync('git', [
        '-C',
        worktreePath,
        'check-ignore',
        '-q',
        '--',
        candidatePath,
      ]);
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
